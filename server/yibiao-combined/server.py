#!/usr/bin/env python3
# ============================================================
# 标讯合并服务 (yibiao-combined) — 单端口版
# 单进程单端口，客户端/前端零改动：
#   /sync/* -> 机器同步端点 (Bearer Token 认证)   [原 15002]
#   /  /api/* -> 知识库认证后台 (session 认证)     [原 15004]
# 依赖：同目录 kb_db.py
# 原服务：yibiao-http-server/server.py (15002) + yibiao-kb-server/kb_server.py (15004)
# 说明：桌面客户端实际通过 Samba 共享同步，HTTP 15002 已无真实调用方，
#       此处保留 /sync/* 仅作能力兜底，统一收口到单端口 15004。
# ============================================================
import http.server
import socketserver
import json
import os
import re
import datetime
import tempfile
import zipfile
import threading
from urllib.parse import urlparse, parse_qs, quote
import kb_db

# ---------------- 配置 ----------------
PORT = int(os.environ.get('KB_PORT', '15004'))  # 单端口

UPLOAD_DIR = os.environ.get('YIBIAO_INCOMING', '/toubiao/yibiao-incoming')
MASTER_ZIP = os.environ.get('YIBIAO_MASTER_ZIP', '/toubiao/yibiao-master/master.zip')
MASTER_DB = os.environ.get('YIBIAO_MASTER_DB', '/toubiao/yibiao-master/master.sqlite')
MASTER_KB = os.environ.get('YIBIAO_MASTER_KB', '/toubiao/yibiao-master/knowledge-base')
AUTH_TOKEN = os.environ.get('YIBIAO_SYNC_TOKEN', 'yibiao-sync-2026')
LOG_FILE = os.environ.get('COMBINED_LOG', '/toubiao/yibiao-combined/server.log')

# kb_db 配置（import 后覆盖模块级变量，再 init）
kb_db.DB_PATH = os.environ.get('KB_DB', '/toubiao/yibiao-kb-server/kb.sqlite')
kb_db.KB_DATA_DIR = os.environ.get('KB_DATA_DIR', '/toubiao/yibiao-kb-server/knowledge-base')
kb_db.init_db()
kb_db.ensure_all_root_folders()


# ---------------- 日志 ----------------
def log(msg):
    line = '[{}] {}'.format(datetime.datetime.now().isoformat(timespec='seconds'), msg)
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


# ---------------- 审计日志写入 ----------------
def audit_event(account_id=None, account_name='', account_type='employee',
                role='', action='', target_type='', target_id='',
                detail='', ip=''):
    """向 kb.sqlite 的 operation_log 表追加一条审计记录。静默失败，不影响主流程。"""
    try:
        import sqlite3 as _sql
        conn = _sql.connect(kb_db.DB_PATH)
        ts = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')
        conn.execute(
            """INSERT INTO operation_log
               (account_id, account_name, account_type, role, action,
                target_type, target_id, detail, ip, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (account_id or 0, account_name or '', account_type or 'employee',
             role or '', action or '', target_type or '',
             str(target_id) if target_id else '', detail or '',
             ip or '', ts))
        conn.commit()
        conn.close()
    except Exception:
        pass


def _client_ip(handler):
    """从请求中提取客户端 IP（优先 X-Forwarded-For，回退 peer）。"""
    xff = handler.headers.get('X-Forwarded-For', '')
    return xff.split(',')[0].strip() if xff else handler.client_address[0]


# ============================================================
# 同步端点辅助函数 (原 yibiao-http-server/server.py)
# ============================================================
def _master_db_conn():
    if not os.path.exists(MASTER_DB):
        return None
    return __import__('sqlite3').connect(MASTER_DB)


def build_manifest():
    import sqlite3
    conn = _master_db_conn()
    if conn is None:
        return None
    try:
        cols = [c[1] for c in conn.execute('PRAGMA table_info(knowledge_documents)').fetchall()]
        need = ['document_id', 'folder_id', 'is_deleted', 'updated_at']
        have = [c for c in need if c in cols]
        docs = [dict(zip(have, r)) for r in conn.execute(
            'SELECT {} FROM knowledge_documents'.format(','.join(have))).fetchall()]
        return {'documents': docs, 'generated_at': datetime.datetime.now().isoformat()}
    finally:
        conn.close()


def build_incremental_zip(ids):
    import sqlite3
    conn = _master_db_conn()
    if conn is None:
        return None
    out_path = tempfile.mktemp(suffix='.zip')
    try:
        placeholders = ','.join('?' * len(ids))
        rows = conn.execute(
            'SELECT document_id, folder_id FROM knowledge_documents WHERE document_id IN ({})'.format(placeholders), ids).fetchall()
        with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
            z.write(MASTER_DB, 'knowledge.sqlite')
            for doc_id, folder_id in rows:
                src = os.path.join(MASTER_KB, 'folders', folder_id, 'documents', doc_id)
                if not os.path.isdir(src):
                    continue
                for root, _dirs, files in os.walk(src):
                    for f in files:
                        fp = os.path.join(root, f)
                        arc = os.path.join('kb', os.path.relpath(fp, MASTER_KB))
                        z.write(fp, arc)
        return out_path
    finally:
        conn.close()


# ============================================================
# 单端口统一 Handler：/sync/* 走同步，其余走知识库
# ============================================================
class CombinedHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    # ---------------- 分发 ----------------
    def do_GET(self):
        if self.path.split('?')[0].startswith('/sync'):
            return self._sync_GET()
        return self._kb_GET()

    def do_POST(self):
        if self.path.split('?')[0].startswith('/sync'):
            return self._sync_POST()
        return self._kb_POST()

    def do_DELETE(self):
        # 仅知识库使用 DELETE
        return self._kb_DELETE()

    def do_OPTIONS(self):
        return self._kb_OPTIONS()

    def do_PUT(self):
        # 仅知识库使用 PUT
        return self._kb_PUT()

    # ============================================================
    # 同步端点逻辑 (原 SyncHandler)
    # ============================================================
    def _read_body(self):
        te = (self.headers.get('Transfer-Encoding', '') or '').lower()
        if te == 'chunked':
            return self._read_chunked()
        cl = self.headers.get('Content-Length')
        if cl:
            try:
                n = int(cl)
            except ValueError:
                n = 0
            return self.rfile.read(n) if n > 0 else b''
        return self.rfile.read()

    def _read_chunked(self):
        buf = b''
        while True:
            line = self.rfile.readline().strip()
            if not line:
                line = self.rfile.readline().strip()
            if not line:
                break
            try:
                size = int(line.split(b';')[0], 16)
            except ValueError:
                break
            if size == 0:
                while True:
                    tail = self.rfile.readline()
                    if tail in (b'\r\n', b'\n', b''):
                        break
                break
            chunk = self.rfile.read(size)
            self.rfile.read(2)
            buf += chunk
        return buf

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_auth(self):
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or auth[7:] != AUTH_TOKEN:
            self._send_json(401, {'error': '认证失败'})
            return False
        return True

    def _sync_GET(self):
        try:
            if not self._check_auth():
                return
            path = self.path.split('?')[0].rstrip('/')
            if path.endswith('/yibiao/manifest'):
                manifest = build_manifest()
                if manifest is None:
                    self._send_json(200, {'documents': [], 'generated_at': datetime.datetime.now().isoformat()})
                    return
                self._send_json(200, manifest)
                return
            ids = None
            if '?' in self.path:
                qs = parse_qs(self.path.split('?', 1)[1])
                ids = qs.get('ids', [None])[0]
            if ids:
                id_list = [x for x in ids.split(',') if x]
                if id_list:
                    tmp_zip = build_incremental_zip(id_list)
                    if tmp_zip and os.path.exists(tmp_zip):
                        try:
                            with open(tmp_zip, 'rb') as f:
                                content = f.read()
                        finally:
                            os.remove(tmp_zip)
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/zip')
                        self.send_header('Content-Length', str(len(content)))
                        self.end_headers()
                        self.wfile.write(content)
                        return
            if not os.path.exists(MASTER_ZIP):
                self._send_json(404, {'error': 'master.zip 不存在'})
                return
            with open(MASTER_ZIP, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            log('SYNC GET error: %s' % e)
            try:
                self._send_json(500, {'error': 'server error'})
            except Exception:
                pass

    def _sync_POST(self):
        try:
            if not self._check_auth():
                return
            ctype = self.headers.get('Content-Type', '')
            if 'boundary=' not in ctype:
                self._send_json(400, {'error': '缺少 boundary'})
                return
            boundary = ctype.split('boundary=')[1].split(';')[0].strip().strip('"')
            post_data = self._read_body()
            parts = post_data.split(b'--' + boundary.encode())
            zip_name = None
            zip_content = None
            for part in parts[1:-1]:
                if b'filename=' in part:
                    i = part.find(b'filename=') + 9
                    if part[i:i + 1] == b'"':
                        i += 1
                    j = part.find(b'"', i)
                    if j == -1:
                        continue
                    fname = part[i:j].decode('utf-8', 'replace')
                    if fname.endswith('.zip'):
                        s = part.find(b'\r\n\r\n') + 4
                        content = part[s:]
                        if content.endswith(b'\r\n'):
                            content = content[:-2]
                        zip_name = fname
                        zip_content = content
                        break
            if zip_name and zip_content:
                os.makedirs(UPLOAD_DIR, exist_ok=True)
                dest = os.path.join(UPLOAD_DIR, zip_name)
                with open(dest, 'wb') as f:
                    f.write(zip_content)
                log('upload received: %s (%d bytes)' % (zip_name, len(zip_content)))
                # 尝试从 zip manifest 提取用户名用于审计
                sync_user = 'unknown'
                try:
                    with zipfile.ZipFile(zip_content) as zf:
                        for n in zf.namelist():
                            if 'manifest' in n.lower():
                                m = json.loads(zf.read(n))
                                sync_user = m.get('username', 'unknown')
                                break
                except Exception:
                    pass
                audit_event(
                    account_name=sync_user, account_type='sync_client',
                    action='sync_push', detail='同步推送: %s (%d bytes)' % (zip_name, len(zip_content)),
                    ip=_client_ip(self))
                self._send_json(200, {'ok': True, 'received': zip_name, 'size': len(zip_content)})
            else:
                self._send_json(400, {'error': '未找到 zip 文件'})
        except Exception as e:
            log('SYNC POST error: %s' % e)
            try:
                self._send_json(500, {'error': 'server error: %s' % e})
            except Exception:
                pass

    # ============================================================
    # 知识库逻辑 (原 KbHandler)
    # ============================================================
    def _send(self, code, obj=None, extra_headers=None):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8') if obj is not None else b''
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length == 0:
                return {}
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception:
            return None

    def _serve_html(self, name):
        html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
        try:
            with open(html_path, 'r', encoding='utf-8') as f:
                html = f.read()
        except Exception:
            html = '<h1>%s not found</h1>' % name
        body = html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        auth = self.headers.get('Authorization', '')
        if auth.startswith('Bearer '):
            return kb_db.get_session(auth[7:].strip())
        return None

    def _is_admin(self):
        e = self._auth()
        return e if (e and e['role'] == 'admin') else None

    def _query_param(self, key):
        q = parse_qs(urlparse(self.path).query)
        return q.get(key, [None])[0]

    def _can_write_folder(self, employee, parent_id):
        if employee['role'] == 'admin':
            return True, None
        root = kb_db.get_root_folder(employee['id'])
        if not root:
            return False, '你还没有根文件夹，请联系管理员'
        if parent_id in (None, '', 0, '0'):
            return False, '员工不能创建顶级文件夹'
        if kb_db.is_in_own_subtree(employee['id'], int(parent_id)):
            return True, None
        return False, '只能在自己根文件夹及子文件夹内操作'

    def _parse_multipart(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
        except (TypeError, ValueError):
            return {}, {}
        raw = self.rfile.read(length) if length else b''
        ctype = self.headers.get('Content-Type', '')
        boundary = None
        for seg in ctype.split(';'):
            seg = seg.strip()
            if seg.startswith('boundary='):
                boundary = seg[len('boundary='):].strip('"')
        if not boundary:
            return {}, {}
        delim = ('--' + boundary).encode()
        fields, files = {}, {}
        for p in raw.split(delim):
            if p in (b'', b'--', b'\r\n'):
                continue
            if p.startswith(b'\r\n'):
                p = p[2:]
            if p.endswith(b'\r\n'):
                p = p[:-2]
            if p == b'--':
                continue
            if b'\r\n\r\n' not in p:
                continue
            head, body = p.split(b'\r\n\r\n', 1)
            headers = {}
            for line in head.decode('utf-8', 'replace').split('\r\n'):
                if ':' in line:
                    k, v = line.split(':', 1)
                    headers[k.strip().lower()] = v.strip()
            cd = headers.get('content-disposition', '')
            name = filename = None
            for seg in cd.split(';'):
                seg = seg.strip()
                if seg.startswith('name='):
                    name = seg[len('name='):].strip('"')
                elif seg.startswith('filename='):
                    filename = seg[len('filename='):].strip('"')
            if not name:
                continue
            if filename:
                files[name] = {'filename': filename, 'content_type': headers.get('content-type', 'application/octet-stream'), 'data': body}
            else:
                fields[name] = body.decode('utf-8', 'replace')
        return fields, files

    def _send_file(self, full_path, filename, mime):
        size = os.path.getsize(full_path)
        self.send_response(200)
        self.send_header('Content-Type', mime or 'application/octet-stream')
        self.send_header('Content-Length', str(size))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + quote(filename or 'download'))
        self.end_headers()
        with open(full_path, 'rb') as fh:
            while True:
                chunk = fh.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _kb_OPTIONS(self):
        self._send(204)

    def _kb_POST(self):
        path = urlparse(self.path).path
        ctype = self.headers.get('Content-Type', '')
        data = {}
        if 'application/json' in ctype:
            data = self._read_json()
            if data is None:
                return self._send(400, {'error': '请求体不是合法 JSON'})

        if path == '/api/register':
            ok, err = kb_db.register(data.get('username', ''), data.get('password', ''), data.get('display_name', ''), data.get('department'))
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_name=data.get('username'), action='register',
                detail='注册成功，等待审核', ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '注册成功，等待管理员审核'})

        if path == '/api/login':
            res, err = kb_db.authenticate(data.get('username', ''), data.get('password', ''))
            if err:
                return self._send(401, {'error': err})
            audit_event(
                account_id=res.get('id'), account_name=res.get('username') or res.get('display_name'),
                role=res.get('role'), action='login',
                detail='登录成功', ip=_client_ip(self))
            return self._send(200, {'success': True, 'data': res})

        if path == '/api/admin/review':
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            ok, err = kb_db.review(data.get('user_id'), data.get('action'), admin['id'], data.get('reject_reason'))
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin['username'],
                role='admin', action='admin', target_type='employee', target_id=data.get('user_id'),
                detail='审核%s: %s' % (data.get('action', ''), data.get('reject_reason') or ''),
                ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '审核完成'})

        if path == '/api/admin/reset-password':
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            ok, err = kb_db.reset_password(data.get('user_id'), data.get('new_password'))
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin['username'],
                role='admin', action='admin', target_type='employee', target_id=data.get('user_id'),
                detail='重置密码', ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '密码已重置'})

        if path == '/api/admin/set-status':
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            ok, err = kb_db.set_employee_status(data.get('user_id'), data.get('status'))
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin['username'],
                role='admin', action='admin', target_type='employee', target_id=data.get('user_id'),
                detail='状态改为 %s' % (data.get('status') or ''), ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '状态已更新'})

        if path == '/api/admin/employees':
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            ok, err = kb_db.admin_create_employee(
                data.get('username', ''), data.get('password', ''),
                data.get('display_name', ''), data.get('department'),
                data.get('role', 'employee'), data.get('status', 'approved'))
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin['username'],
                role='admin', action='admin', target_type='employee',
                detail='创建账号 %s (角色=%s)' % (data.get('username', ''), data.get('role', 'employee')),
                ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '账户已创建'})
        m = re.match(r'^/api/admin/groups/(\d+)/members$', path)
        if m:
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            ok, err = kb_db.add_employee_group(data.get('employee_id'), m.group(1))
            if not ok:
                return self._send(400, {'error': err})
            return self._send(200, {'success': True})
        if path == '/api/admin/groups':
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            g, err = kb_db.create_permission_group(data.get('name', ''), data.get('description'))
            if err:
                return self._send(400, {'error': err})
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin['username'],
                role='admin', action='group', target_type='group', target_id=g.get('id') if g else '',
                detail='创建权限分组: %s' % (data.get('name', '')), ip=_client_ip(self))
            return self._send(200, {'success': True, 'data': g})

        if path == '/api/folders':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            name = (data.get('name') or '').strip()
            parent_id = data.get('parent_id')
            ok, err = self._can_write_folder(employee, parent_id)
            if not ok:
                return self._send(403, {'error': err})
            folder, ferr = kb_db.create_folder(name, parent_id, employee['id'])
            if ferr:
                return self._send(400, {'error': ferr})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='folder', target_type='folder', target_id=folder.get('id'),
                detail='创建文件夹: %s' % name, ip=_client_ip(self))
            return self._send(200, {'success': True, 'data': folder})

        if path == '/api/documents':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            if 'multipart/form-data' not in ctype:
                return self._send(400, {'error': '上传需使用 multipart/form-data'})
            fields, files = self._parse_multipart()
            folder_id = fields.get('folder_id')
            f = files.get('file')
            if not folder_id or not f:
                return self._send(400, {'error': '缺少 folder_id 或 file'})
            ok, err = self._can_write_folder(employee, folder_id)
            if not ok:
                return self._send(403, {'error': err})
            if not kb_db.get_folder(folder_id):
                return self._send(400, {'error': '目标文件夹不存在'})
            title = fields.get('title') or f['filename']
            doc, derr = kb_db.upload_document(folder_id, employee['id'], title, f['filename'], f.get('content_type', 'application/octet-stream'), f['data'])
            if derr:
                return self._send(400, {'error': derr})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='doc', target_type='document', target_id=doc.get('id'),
                detail='上传文档: %s (%.1fKB)' % (title, (len(f['data']) / 1024)), ip=_client_ip(self))
            return self._send(200, {'success': True, 'data': {k: doc[k] for k in ('id', 'folder_id', 'owner_id', 'title', 'file_name', 'file_size', 'mime_type', 'created_at')}})

        return self._send(404, {'error': '接口不存在'})

    # ==================== 个人库（主库）辅助方法 ====================
    def _personal_folders(self):
        """从 master.sqlite 读取文件夹树。"""
        import sqlite3 as sql
        conn = _master_db_conn()
        if conn is None:
            return []
        try:
            cur = conn.execute(
                "SELECT id, parent_id, name, created_at FROM knowledge_folders ORDER BY id")
            rows = cur.fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def _personal_documents(self, folder_id):
        """从 master.sqlite 读取指定文件夹下的文档列表。"""
        import sqlite3 as sql
        conn = _master_db_conn()
        if conn is None:
            return []
        try:
            cols = [c[1] for c in conn.execute('PRAGMA table_info(knowledge_documents)').fetchall()]
            need = ['document_id', 'folder_id', 'is_deleted', 'updated_at']
            have = [c for c in need if c in cols]
            query_parts = ['id', 'folder_id', 'title', 'file_name', 'file_size', 'mime_type', 'status']
            have2 = [p for p in query_parts if p in cols]
            col_str = ','.join(have2 + have) if have2 and have else ','.join(have2 + ['folder_id'])
            if not have2:
                col_str = ','.join(have)
            if folder_id:
                pid = int(folder_id) if str(folder_id) not in ('0', 'null', '') else None
                q = 'SELECT {} FROM knowledge_documents'.format(col_str)
                if pid is not None:
                    q += ' WHERE folder_id=?'
                else:
                    q += ' WHERE is_deleted=0'
                rows = conn.execute(q, (pid,) if pid is not None else ()).fetchall()
            else:
                rows = conn.execute(
                    'SELECT {} FROM knowledge_documents WHERE is_deleted=0 ORDER BY document_id'.format(col_str),
                ).fetchall()
            return [dict(zip([c.replace('-','_') if '-' in c else c for c in [desc[1] for desc in cur.description]], r)) for r in rows]
        finally:
            conn.close()

    def _send_personal_file(self, doc_id_str):
        """发送个人库文件（只读）。"""
        conn = _master_db_conn()
        if conn is None:
            return self._send(404, {'error': '主库不可用'})
        try:
            cur = conn.execute("PRAGMA table_info(knowledge_documents)")
            cols = [c[1] for c in cur.fetchall()]
            mapping = {
                'document_id': 'document_id',
                'file_path': 'file_path' if 'file_path' in cols else None,
                'folder_id': 'folder_id',
            }
            doc_id = int(doc_id_str)
            q = 'SELECT document_id'
            has_fp = False
            for item in [
                ('file_path', 'file_path'),
                ('folder_id', 'folder_id'),
            ]:
                if item[0] in cols:
                    q += ',{}'.format(item[1])
            q += ' FROM knowledge_documents WHERE document_id=?'
            row = conn.execute(q, (doc_id,)).fetchone()
            if not row:
                return self._send(404, {'error': '文档不存在'})
            d = dict(zip(['document_id','file_path','folder_id'], row))
            fp = d.get('file_path') or ''
            # fallback：try to find by document_id
            if not os.path.isfile(fp):
                for f in conn.execute("SELECT document_id FROM knowledge_documents").fetchall():
                    pass  # skip
                # Construct path from folders/documents pattern
                fid = d.get('folder_id', 'default')
                candidate = os.path.join(MASTER_KB, 'folders', fid, 'documents', str(doc_id))
                if os.path.isdir(candidate):
                    files = os.listdir(candidate)
                    if files:
                        fp = os.path.join(candidate, files[0])
                elif not fp:
                    return self._send(404, {'error': '文件路径未知'})
            if not os.path.isfile(fp):
                return self._send(404, {'error': '文件已丢失'})
            mtype = d.get('mime_type') or 'application/octet-stream'
            self._send_file(fp, os.path.basename(fp), mtype)
        finally:
            conn.close()

    def _sync_team_to_master(self, doc_id, owner_name='system'):
        """团队库文档 → 个人库（拷贝到 master.sqlite）。"""
        import shutil
        team_doc = kb_db.get_document(doc_id)
        if not team_doc:
            return False, '文档不存在'
        master_conn = _master_db_conn()
        if master_conn is None:
            return False, '主库不可用'
        try:
            master_conn.execute(
                """INSERT INTO knowledge_documents
                    (document_id, folder_id, title, file_name, file_size, mime_type, status, progress, item_count, block_count, owner_name, created_at, updated_at, is_deleted)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)""",
                (team_doc['id'], team_doc['folder_id'], team_doc['title'],
                 team_doc['file_name'], team_doc['file_size'], team_doc.get('mime_type'),
                 team_doc.get('status', 'ok'), 100, 0, 0, owner_name)
            )
            master_conn.commit()
            new_id = master_conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            # Copy file
            src = os.path.join(kb_db.KB_DATA_DIR, team_doc['file_path'])
            dst_folder = os.path.join(MASTER_KB, 'folders', str(new_id), 'documents')
            os.makedirs(dst_folder, exist_ok=True)
            if os.path.isfile(src):
                shutil.copy2(src, dst_folder)
            return True, '同步成功'
        except Exception as e:
            return False, str(e)
        finally:
            master_conn.close()

    def _kb_GET(self):
        path = urlparse(self.path).path
        if path in ('/', '/admin'):
            return self._serve_html('kb_admin.html')
        if path == '/register':
            return self._serve_html('kb_register.html')
        if path == '/api/health':
            return self._send(200, {'status': 'ok'})
        if path == '/api/me':
            e = self._auth()
            if not e:
                return self._send(401, {'error': '未登录或会话已过期'})
            return self._send(200, {'data': kb_db.public_fields(e)})
        if path == '/api/admin/pending':
            if not self._is_admin():
                return self._send(403, {'error': '需要管理员权限'})
            return self._send(200, {'data': kb_db.list_pending()})
        if path == '/api/admin/employees':
            if not self._is_admin():
                return self._send(403, {'error': '需要管理员权限'})
            return self._send(200, {'data': kb_db.list_employees()})
        if path == '/api/permissions':
            e = self._auth()
            if not e:
                return self._send(401, {'error': '未登录或会话已过期'})
            return self._send(200, {'data': [
                {'key': k, 'label': lbl, 'description': desc}
                for k, lbl, desc in kb_db.PERMISSION_CATALOG
            ]})
        if path == '/api/admin/groups':
            if not self._is_admin():
                return self._send(403, {'error': '需要管理员权限'})
            return self._send(200, {'data': kb_db.list_permission_groups()})
        if path == '/api/admin/audit':
            if not self._is_admin():
                return self._send(403, {'error': '需要管理员权限'})
            import sqlite3 as _sql
            try:
                limit = int(self._query_param('limit') or 200)
            except (TypeError, ValueError):
                limit = 200
            if limit <= 0 or limit > 1000:
                limit = 200
            conn = _sql.connect(kb_db.DB_PATH)
            try:
                cur = conn.execute(
                    "SELECT id, account_id, account_name, account_type, role, action, "
                    "target_type, target_id, detail, ip, created_at "
                    "FROM operation_log ORDER BY id DESC LIMIT ?", (limit,))
                cols = [d[0] for d in cur.description]
                rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            except Exception as e:
                return self._send(500, {'error': '读取审计日志失败: %s' % e})
            finally:
                conn.close()
            return self._send(200, {'success': True, 'data': rows})
        m = re.match(r'^/api/documents/(\d+)/file$', path)
        if m:
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            doc = kb_db.get_document(m.group(1))
            if not doc:
                return self._send(404, {'error': '文档不存在'})
            full = os.path.join(kb_db.KB_DATA_DIR, doc['file_path'])
            if not os.path.isfile(full):
                return self._send(404, {'error': '文件已丢失'})
            self._send_file(full, doc['file_name'], doc['mime_type'])
            return
        if path == '/api/folders':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            folders = kb_db.list_folders()
            parent = self._query_param('parent')
            if parent not in (None, ''):
                pid = None if parent in ('0', 'null') else int(parent)
                folders = [f for f in folders if f['parent_id'] == pid]
            return self._send(200, {'data': folders})
        if path == '/api/documents':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            folder = self._query_param('folder')
            kw = self._query_param('q')
            if kw:
                return self._send(200, {'data': kb_db.search_documents(kw)})
            if not folder:
                return self._send(200, {'data': kb_db.list_documents(None)})
            return self._send(200, {'data': kb_db.list_documents(folder)})
        # ==================== /api/personal/* （Bearer token，个人库/主库）====================
        if path == '/api/personal/folders':
            return self._send(200, {'data': self._personal_folders()})
        if path == '/api/personal/documents':
            folder = self._query_param('folder')
            return self._send(200, {'data': self._personal_documents(folder)})
        if path.startswith('/api/personal/documents/') and path.endswith('/file'):
            doc_id_str = path.split('/documents/')[1].split('/')[0]
            return self._send_personal_file(doc_id_str)
        if path == '/api/import/personal':
            """个人库 → 团队库导入（管理员审核通过后才可写）。"""
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            body = self._read_json()
            if not body or 'documents' not in body:
                return self._send(400, {'error': '缺少 documents 数组'})
            created = []
            for item in body['documents']:
                doc_id = item.get('document_id')
                folder_id = item.get('folder_id')
                try:
                    fid = int(folder_id) if folder_id else None
                except (ValueError, TypeError):
                    fid = 0
                    continue
                remote = kb_db.create_document_from_personal(int(doc_id), fid, employee['id'])
                if remote is None:
                    continue
                created.append({'document_id': doc_id, 'remote_id': remote})
            return self._send(200, {'created': created})
        if path == '/api/import/team':
            """团队库 → 个人库共享（只读浏览）。"""
            auth_header = self.headers.get('Authorization', '')
            if auth_header.startswith('Bearer '):
                token = auth_header[7:]
            else:
                return self._send(401, {'error': '缺少 Bearer token'})
            body = self._read_json()
            if not body or 'documents' not in body:
                return self._send(400, {'error': '缺少 documents 数组'})
            synced = []
            for item in body['documents']:
                doc_id = item.get('id')
                try:
                    did = int(doc_id)
                except (ValueError, TypeError):
                    continue
                    # skip
                ok, msg = self._sync_team_to_master(did, body.get('owner_name', 'system'))
                synced.append({'id': did, 'ok': bool(ok), 'msg': msg})
            return self._send(200, {'synced': synced})
        return self._send(404, {'error': '接口不存在'})

    def _kb_DELETE(self):
        path = urlparse(self.path).path
        employee = self._auth()
        if not employee:
            return self._send(401, {'error': '未登录或会话已过期'})
        m = re.match(r'^/api/folders/(\d+)$', path)
        if m:
            folder = kb_db.get_folder(m.group(1))
            if not folder:
                return self._send(404, {'error': '文件夹不存在'})
            if employee['role'] != 'admin' and folder['owner_id'] != employee['id']:
                return self._send(403, {'error': '只能删除自己创建的文件夹'})
            ok, err = kb_db.delete_folder(m.group(1))
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='folder', target_type='folder', target_id=m.group(1),
                detail='删除文件夹: %s' % (folder.get('name') or m.group(1)), ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '文件夹已删除'})
        m = re.match(r'^/api/documents/(\d+)$', path)
        if m:
            doc = kb_db.get_document(m.group(1))
            if not doc:
                return self._send(404, {'error': '文档不存在'})
            if employee['role'] != 'admin' and doc['owner_id'] != employee['id']:
                return self._send(403, {'error': '只能删除自己上传的文档'})
            ok, err = kb_db.delete_document(m.group(1))
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='doc', target_type='document', target_id=m.group(1),
                detail='删除文档: %s' % (doc.get('title') or doc.get('file_name') or m.group(1)),
                ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '文档已删除'})
        m = re.match(r'^/api/admin/groups/(\d+)/members/(\d+)$', path)
        if m:
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            ok, err = kb_db.remove_employee_group(m.group(2), m.group(1))
            if not ok:
                return self._send(400, {'error': err})
            return self._send(200, {'success': True})
        m = re.match(r'^/api/admin/groups/(\d+)$', path)
        if m:
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            ok, err = kb_db.delete_permission_group(m.group(1))
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin['username'],
                role='admin', action='group', target_type='group', target_id=m.group(1),
                detail='删除权限分组', ip=_client_ip(self))
            return self._send(200, {'success': True})
        m = re.match(r'^/api/admin/employees/(\d+)$', path)
        if m:
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            if str(m.group(1)) == str(admin['id']):
                return self._send(400, {'error': '不能删除当前登录的管理员账号'})
            ok, err = kb_db.delete_employee(m.group(1))
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin['username'],
                role='admin', action='admin', target_type='employee', target_id=m.group(1),
                detail='删除账号', ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '账号已删除（其名下知识库文档与文件夹已保留）'})
        return self._send(404, {'error': '接口不存在'})

    def _kb_PUT(self):
        path = urlparse(self.path).path
        ctype = self.headers.get('Content-Type', '')
        data = {}
        if 'application/json' in ctype:
            data = self._read_json()
            if data is None:
                return self._send(400, {'error': '请求体不是合法 JSON'})
        m = re.match(r'^/api/admin/groups/(\d+)/permissions$', path)
        if m:
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            ok, err = kb_db.set_group_permissions(m.group(1), data.get('permissions', []))
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin['username'],
                role='admin', action='group', target_type='group', target_id=m.group(1),
                detail='更新权限: %d 项' % len(data.get('permissions', [])), ip=_client_ip(self))
            return self._send(200, {'success': True})
        m = re.match(r'^/api/admin/employees/(\d+)$', path)
        if m:
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            # 拒绝把自己降级为员工，避免误锁门禁
            if str(m.group(1)) == str(admin['id']) and data.get('role') == 'employee':
                return self._send(400, {'error': '不能把自己降级为员工'})
            ok, err = kb_db.update_employee(m.group(1), data)
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin['username'],
                role='admin', action='admin', target_type='employee', target_id=m.group(1),
                detail='更新账号: %s' % (', '.join('%s=%s' % (k, v) for k, v in data.items() if k != 'password')),
                ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '账号已更新'})
        return self._send(404, {'error': '接口不存在'})

    def log_message(self, fmt, *args):
        log(fmt % args)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(MASTER_ZIP), exist_ok=True)
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    log('yibiao-combined single-port starting on :%d (sync=/sync/*, kb=/)' % PORT)
    srv = ThreadingHTTPServer(('', PORT), CombinedHandler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()
