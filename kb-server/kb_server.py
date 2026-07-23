#!/usr/bin/env python3
# 方案 D 认证服务（仅账号密码 + 自助注册 + 管理员审核）
# 标准库 http.server，多线程，HTTP/1.1；与现有 server.py 风格一致，无第三方依赖。
import http.server
import socketserver
import json
import os
import re
import datetime
from urllib.parse import urlparse, parse_qs, quote
import kb_db

PORT = int(os.environ.get('KB_PORT', '15004'))
DB_PATH = os.environ.get('KB_DB', '/toubiao/yibiao-kb-server/kb.sqlite')
kb_db.DB_PATH = DB_PATH
kb_db.init_db()
# 为已审核员工补建根文件夹（兼容历史数据）
kb_db.ensure_all_root_folders()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    # ---------- 通用响应 ----------
    def _send(self, code, obj=None, extra_headers=None):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
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
            html = '<h1>kb_admin.html not found</h1>'
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
        """员工只能在自己根文件夹及子文件夹内写；管理员全库可写。"""
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
        """极简 multipart/form-data 解析（不依赖已移除的 cgi 模块）。"""
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
                files[name] = {
                    'filename': filename,
                    'content_type': headers.get('content-type', 'application/octet-stream'),
                    'data': body,
                }
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
        self.send_header('Content-Disposition',
                         'attachment; filename*=UTF-8\'\'' + quote(filename or 'download'))
        self.end_headers()
        with open(full_path, 'rb') as fh:
            while True:
                chunk = fh.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)

    # ---------- 路由 ----------
    def do_OPTIONS(self):
        self._send(204)

    def do_POST(self):
        path = urlparse(self.path).path
        ctype = self.headers.get('Content-Type', '')
        data = {}
        if 'application/json' in ctype:
            data = self._read_json()
            if data is None:
                return self._send(400, {'error': '请求体不是合法 JSON'})

        if path == '/api/register':
            ok, err = kb_db.register(
                data.get('username', ''), data.get('password', ''),
                data.get('display_name', ''), data.get('department'))
            if not ok:
                return self._send(400, {'error': err})
            return self._send(200, {'success': True, 'message': '注册成功，等待管理员审核'})

        if path == '/api/login':
            res, err = kb_db.authenticate(data.get('username', ''), data.get('password', ''))
            if err:
                return self._send(401, {'error': err})
            return self._send(200, {'success': True, 'data': res})

        if path == '/api/admin/review':
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            ok, err = kb_db.review(
                data.get('user_id'), data.get('action'), admin['id'], data.get('reject_reason'))
            if not ok:
                return self._send(400, {'error': err})
            return self._send(200, {'success': True, 'message': '审核完成'})

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
            return self._send(200, {'success': True, 'data': folder})

        if path == '/api/documents':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            ctype = self.headers.get('Content-Type', '')
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
            doc, derr = kb_db.upload_document(
                folder_id, employee['id'], title, f['filename'],
                f.get('content_type', 'application/octet-stream'), f['data'])
            if derr:
                return self._send(400, {'error': derr})
            return self._send(200, {'success': True, 'data': {
                k: doc[k] for k in ('id', 'folder_id', 'owner_id', 'title',
                                    'file_name', 'file_size', 'mime_type', 'created_at')}})

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
            return self._send(200, {'success': True, 'data': g})

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
            return self._send(200, {'success': True, 'message': '账户已创建'})

        return self._send(404, {'error': '接口不存在'})

    def do_PUT(self):
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
            return self._send(200, {'success': True})
        return self._send(404, {'error': '接口不存在'})

    def do_GET(self):
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

        # 下载文档文件（流式）
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

        # 搜索文档（优化③）
        if path == '/api/documents':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            folder = self._query_param('folder')
            search_q = self._query_param('q') or self._query_param('search')
            doc_id = self._query_param('doc_id')
            # 按文档ID精确查找
            if doc_id:
                doc = kb_db.get_document(doc_id)
                return self._send(200, {'data': [doc] if doc else []})
            # 全文搜索
            if search_q:
                with kb_db._conn() as conn:
                    query = f"%{search_q}%"
                    docs = conn.execute(
                        "SELECT id,folder_id,owner_id,title,file_name,file_size,mime_type,created_at "
                        "FROM knowledge_documents WHERE title LIKE ? OR file_name LIKE ?",
                        (query, query)).fetchall()
                return self._send(200, {'data': [dict(r) for r in docs]})
            # 按文件夹列出（原有逻辑）
            if not folder:
                return self._send(400, {'error': '缺少 folder 参数'})
            return self._send(200, {'data': kb_db.list_documents(folder)})

        # 文档版本历史（优化④）
        m = re.match(r'^/api/documents/(\d+)/versions$', path)
        if m:
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            doc = kb_db.get_document(m.group(1))
            return self._send(200, {'data': [{
                'version': 1,
                'created_at': doc['created_at'] if doc else '',
                'note': '初始版本'
            }]})

        return self._send(404, {'error': '接口不存在'})

    def do_DELETE(self):
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
            return self._send(200, {'success': True})

        return self._send(404, {'error': '接口不存在'})

    def log_message(self, fmt, *args):
        pass


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    srv = ThreadedHTTPServer(('0.0.0.0', PORT), Handler)
    print('kb-auth server listening on :%d' % PORT, flush=True)
    srv.serve_forever()
