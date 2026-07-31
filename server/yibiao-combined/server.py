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
import io
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
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
# 同步包合并脚本（收到 push 后实时触发）；不存在时仅落盘等 cron
MERGE_SCRIPT = os.environ.get('YIBIAO_MERGE_SCRIPT', '/toubiao/yibiao-sync/merge.py')
if 'YIBIAO_SYNC_TOKEN' not in os.environ:
    print('[warn] YIBIAO_SYNC_TOKEN 未通过环境变量注入，正在使用内置默认值，生产环境请务必覆盖', flush=True)

# 主库（master.sqlite）写操作并发锁（防止多线程同时写导致 database is locked）
_MASTER_LOCK = threading.RLock()

# 分析 Worker（独立 Node 进程）地址；上传文档后触发服务器侧分析。
WORKER_URL = os.environ.get('KB_WORKER_URL', 'http://127.0.0.1:15006')


def _trigger_worker_analysis(document_id, library_type='team'):
    """上传文档后异步触发分析 Worker。fire-and-forget，失败仅记日志不影响上传返回。"""
    try:
        import urllib.request
        import urllib.error
        payload = json.dumps({'documentId': document_id, 'libraryType': library_type}).encode('utf-8')
        req = urllib.request.Request(
            WORKER_URL + '/analyze', data=payload,
            headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=5) as resp:
            log('[worker] 已触发分析 doc=%s -> %s' % (document_id, resp.status))
    except Exception as e:
        log('[worker] 触发分析失败 doc=%s: %s' % (document_id, e))


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
    _sqlite3 = __import__('sqlite3')
    conn = _sqlite3.connect(MASTER_DB)
    # sqlite3.Row 支持按索引和按列名两种访问方式，向后兼容旧的 r[0] 取值，
    # 同时让新增的个人库回收站/导出等方法可以安全地使用 row['col'] 访问。
    conn.row_factory = _sqlite3.Row
    conn.execute('PRAGMA busy_timeout = 5000')
    # 主库开启 WAL：读写互不阻塞，合并写库不会卡住个人库查询（merge.py 也会设置，此处保证首次使用即生效）
    try:
        conn.execute('PRAGMA journal_mode=WAL')
    except Exception:
        pass
    return conn


def _master_ensure_analysis_table(conn):
    """确保 master.sqlite 存在 kb_analysis 表（个人库分析结果，主键 TEXT document_id）。"""
    conn.execute('''
        CREATE TABLE IF NOT EXISTS kb_analysis (
            document_id   TEXT PRIMARY KEY,
            status        TEXT,
            payload       TEXT,
            item_count    INTEGER,
            block_count   INTEGER,
            analyzer_id   INTEGER,
            analyzer_name TEXT,
            updated_at    TEXT NOT NULL
        )
    ''')


def _master_save_analysis(document_id, status, payload, item_count=None, block_count=None,
                          analyzer_id=None, analyzer_name=None):
    """写回/更新个人库某文档的分析结果（存 master.sqlite）。"""
    with _MASTER_LOCK:
        conn = _master_db_conn()
        if conn is None:
            return
        try:
            _master_ensure_analysis_table(conn)
            payload_str = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
            conn.execute(
                """INSERT INTO kb_analysis
                   (document_id, status, payload, item_count, block_count, analyzer_id, analyzer_name, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(document_id) DO UPDATE SET
                     status=excluded.status, payload=excluded.payload,
                     item_count=excluded.item_count, block_count=excluded.block_count,
                     analyzer_id=excluded.analyzer_id, analyzer_name=excluded.analyzer_name,
                     updated_at=excluded.updated_at""",
                (str(document_id), status, payload_str, item_count, block_count,
                 analyzer_id, analyzer_name, datetime.datetime.now().isoformat()))
            conn.commit()
        finally:
            conn.close()


def _master_get_analysis(document_id):
    """返回个人库某文档分析结果 dict 或 None（不做 owner 校验，调用方负责校验 document 归属）。"""
    with _MASTER_LOCK:
        conn = _master_db_conn()
        if conn is None:
            return None
        try:
            _master_ensure_analysis_table(conn)
            row = conn.execute(
                "SELECT document_id, status, payload, item_count, block_count, "
                "analyzer_id, analyzer_name, updated_at FROM kb_analysis WHERE document_id=?",
                (str(document_id),)).fetchone()
        finally:
            conn.close()
    if not row:
        return None
    payload = row['payload']
    try:
        payload_obj = json.loads(payload) if payload else None
    except (TypeError, ValueError):
        payload_obj = None
    return {
        'document_id': row['document_id'],
        'status': row['status'],
        'payload': payload_obj,
        'item_count': row['item_count'],
        'block_count': row['block_count'],
        'analyzer_id': row['analyzer_id'],
        'analyzer_name': row['analyzer_name'],
        'updated_at': row['updated_at'],
    }


def _master_delete_analysis(document_id):
    """删除个人库某文档的分析缓存（文档被删/重分析时调用）。"""
    with _MASTER_LOCK:
        conn = _master_db_conn()
        if conn is None:
            return
        try:
            _master_ensure_analysis_table(conn)
            conn.execute("DELETE FROM kb_analysis WHERE document_id=?", (str(document_id),))
            conn.commit()
        finally:
            conn.close()


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


def _copy_filtered_rows(dst, table, cols, rows, exclude_id):
    """把行写入 dst 的 table；exclude_id=True 时跳过自增 id 列，避免跨库主键冲突。"""
    if not rows:
        return
    if exclude_id and 'id' in cols:
        idx = cols.index('id')
        cols2 = [c for i, c in enumerate(cols) if i != idx]
        rows2 = [tuple(v for i, v in enumerate(r) if i != idx) for r in rows]
    else:
        cols2, rows2 = cols, rows
    col_names = ','.join(cols2)
    qmarks = ','.join('?' * len(cols2))
    dst.executemany(
        'INSERT OR IGNORE INTO {t} ({c}) VALUES ({q})'.format(t=table, c=col_names, q=qmarks),
        rows2)


def build_filtered_master_db(src_db, ids):
    """生成一个临时 sqlite：只含目标 document_id 在各 knowledge_* 表的行（★4 真正增量）。

    - 带 document_id 的表按 ids 过滤；
    - knowledge_folders 整表复制（folder 链数据量小且合并时必须存在）；
    - knowledge_migration_meta 不复制（迁移状态是每客户端本地的，不应跨端传播）。
    """
    import sqlite3 as _sql
    tmp = tempfile.mktemp(suffix='.sqlite')
    src = _sql.connect(src_db)
    dst = _sql.connect(tmp)
    try:
        dst.execute('PRAGMA foreign_keys=OFF')
        # 复制全部 knowledge_* 表结构
        for (sql,) in src.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_%' AND sql IS NOT NULL").fetchall():
            dst.execute(sql)
        # 复制索引
        for (sql,) in src.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name LIKE 'knowledge_%'").fetchall():
            try:
                dst.execute(sql)
            except Exception:
                pass
        if not ids:
            dst.commit()
            return tmp
        placeholders = ','.join('?' * len(ids))
        skip_tables = {'knowledge_migration_meta'}
        full_tables = {'knowledge_folders'}
        for (name,) in src.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_%' AND sql IS NOT NULL ORDER BY name").fetchall():
            cols = [c[1] for c in src.execute('PRAGMA table_info({})'.format(name)).fetchall()]
            if name in skip_tables:
                continue
            if name in full_tables:
                rows = src.execute('SELECT * FROM {}'.format(name)).fetchall()
                _copy_filtered_rows(dst, name, cols, rows, exclude_id=False)
                continue
            if 'document_id' in cols:
                rows = src.execute(
                    'SELECT * FROM {} WHERE document_id IN ({})'.format(name, placeholders), ids).fetchall()
                _copy_filtered_rows(dst, name, cols, rows, exclude_id=True)
            # 既无 document_id 也不在 full/skip 的表：保持空表（结构已建）
        dst.commit()
        return tmp
    finally:
        src.close()


def build_incremental_zip(ids):
    """★4 增量：只打包目标 ids 对应的文档数据与文件，knowledge.sqlite 也是过滤后的。"""
    if not os.path.exists(MASTER_DB):
        return None
    filtered_db = build_filtered_master_db(MASTER_DB, ids)
    if filtered_db is None or not os.path.exists(filtered_db):
        return None
    out_path = tempfile.mktemp(suffix='.zip')
    try:
        import sqlite3 as _sql
        fconn = _sql.connect(filtered_db)
        try:
            rows = fconn.execute('SELECT document_id, folder_id FROM knowledge_documents').fetchall()
        finally:
            fconn.close()
        with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
            z.write(filtered_db, 'knowledge.sqlite')
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
        try:
            os.remove(filtered_db)
        except Exception:
            pass


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

    # ★3 流式读取：把请求体分块写入 fobj（64KB/块），全程不整包进内存。
    # 返回写入的总字节数。支持 Content-Length 与 Transfer-Encoding: chunked 两种模式。
    def _stream_body_to(self, fobj, chunk_size=65536):
        te = (self.headers.get('Transfer-Encoding', '') or '').lower()
        total = 0
        if te == 'chunked':
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
                remaining = size
                while remaining > 0:
                    data = self.rfile.read(min(chunk_size, remaining))
                    if not data:
                        break
                    fobj.write(data)
                    total += len(data)
                    remaining -= len(data)
                self.rfile.read(2)  # 吃掉 chunk 尾部 \r\n
            return total
        cl = self.headers.get('Content-Length')
        try:
            n = int(cl) if cl else 0
        except ValueError:
            n = 0
        remaining = n
        while remaining > 0:
            data = self.rfile.read(min(chunk_size, remaining))
            if not data:
                break
            fobj.write(data)
            total += len(data)
            remaining -= len(data)
        return total

    # ★3 从已落盘的 multipart 临时文件中定位 zip part 的字节范围（用 mmap 查找，
    # 由操作系统按页调度，不会把整个文件读进进程内存）。
    # 返回 (zip_name, start, end)；未找到返回 (None, 0, 0)。
    @staticmethod
    def _locate_zip_part(src_path, bmark):
        import mmap
        with open(src_path, 'rb') as f:
            try:
                mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
            except ValueError:
                return (None, 0, 0)  # 空文件
            try:
                pos = mm.find(bmark)
                while pos != -1:
                    part_start = pos + len(bmark)
                    # 结束边界 "--boundary--"
                    if mm[part_start:part_start + 2] == b'--':
                        break
                    header_end = mm.find(b'\r\n\r\n', part_start)
                    if header_end == -1:
                        break
                    headers = mm[part_start:header_end]
                    fn_idx = headers.find(b'filename=')
                    if fn_idx != -1:
                        i = fn_idx + 9
                        if headers[i:i + 1] == b'"':
                            i += 1
                        j = headers.find(b'"', i)
                        if j != -1:
                            fname = headers[i:j].decode('utf-8', 'replace')
                            if fname.endswith('.zip'):
                                content_start = header_end + 4
                                content_end = mm.find(b'\r\n' + bmark, content_start)
                                if content_end == -1:
                                    content_end = len(mm)
                                return (fname, content_start, content_end)
                    pos = mm.find(bmark, header_end)
                return (None, 0, 0)
            finally:
                mm.close()

    # ★3 分块发送本地文件（不整文件读内存）；remove_after=True 时发送完删除。
    def _send_zip_file(self, fpath, remove_after=False, chunk_size=65536):
        try:
            size = os.path.getsize(fpath)
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Length', str(size))
            self.end_headers()
            with open(fpath, 'rb') as f:
                while True:
                    data = f.read(chunk_size)
                    if not data:
                        break
                    self.wfile.write(data)
        finally:
            if remove_after:
                try:
                    os.remove(fpath)
                except OSError:
                    pass

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
                        # ★3 分块发送，发送完删除临时 zip
                        self._send_zip_file(tmp_zip, remove_after=True)
                        return
            if not os.path.exists(MASTER_ZIP):
                self._send_json(404, {'error': 'master.zip 不存在'})
                return
            # ★3 分块发送 master.zip（不整文件读内存）
            self._send_zip_file(MASTER_ZIP)
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
            bmark = b'--' + boundary.encode()
            # ★3 流式落盘：请求体先分块写入临时文件（同目录，保证后续 rename 原子），
            # 再用 mmap 定位 zip part 字节范围，分块拷贝出 zip —— 全程不整包进内存。
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            raw_fd, raw_path = tempfile.mkstemp(suffix='.raw', dir=UPLOAD_DIR)
            zip_name = None
            zip_size = 0
            try:
                with os.fdopen(raw_fd, 'wb') as rawf:
                    total = self._stream_body_to(rawf)
                log('upload body streamed to disk: %d bytes' % total)
                zip_name, z_start, z_end = self._locate_zip_part(raw_path, bmark)
                if zip_name and z_end > z_start:
                    # 路径穿越防护：只取文件名部分，剔除目录分隔符；强制 .zip 后缀
                    zip_name = os.path.basename(zip_name.replace('\\', '/'))
                    if not zip_name or not zip_name.endswith('.zip') or zip_name.startswith('.'):
                        self._send_json(400, {'error': '非法文件名'})
                        return
                    dest = os.path.join(UPLOAD_DIR, zip_name)
                    # 双保险：确认落盘路径仍在 UPLOAD_DIR 内
                    if os.path.realpath(os.path.dirname(dest)) != os.path.realpath(UPLOAD_DIR):
                        self._send_json(400, {'error': '非法文件路径'})
                        return
                    # 分块拷贝 zip 段到最终文件（64KB/块）
                    with open(raw_path, 'rb') as src, open(dest + '.part', 'wb') as out:
                        src.seek(z_start)
                        remaining = z_end - z_start
                        while remaining > 0:
                            data = src.read(min(65536, remaining))
                            if not data:
                                break
                            out.write(data)
                            remaining -= len(data)
                    os.replace(dest + '.part', dest)
                    zip_size = os.path.getsize(dest)
            finally:
                try:
                    os.remove(raw_path)
                except OSError:
                    pass
            if zip_name and zip_size > 0:
                log('upload received: %s (%d bytes)' % (zip_name, zip_size))
                # 尝试从 zip manifest 提取用户名用于审计（直接读盘上 zip，不再经内存 BytesIO）
                sync_user = 'unknown'
                try:
                    with zipfile.ZipFile(dest) as zf:
                        for n in zf.namelist():
                            if 'manifest' in n.lower():
                                m = json.loads(zf.read(n))
                                sync_user = m.get('username', 'unknown')
                                break
                except Exception:
                    pass
                audit_event(
                    account_name=sync_user, account_type='sync_client',
                    action='sync_push', detail='同步推送: %s (%d bytes)' % (zip_name, zip_size),
                    ip=_client_ip(self))
                # 实时触发合并：异步子进程（Popen 立即返回，不阻塞本请求）；
                # 用 ionice+nice 降低合并的 I/O 与 CPU 优先级，避免同步合并抢占 KB 服务的
                # 磁盘/CPU，导致其他人使用变慢。合并的并发串行由 merge.py 内部的 flock 保证。
                try:
                    if os.path.isfile(MERGE_SCRIPT):
                        env = dict(os.environ)
                        env.update({
                            'YIBIAO_MASTER_DB': MASTER_DB,
                            'YIBIAO_MASTER_KB': MASTER_KB,
                            'YIBIAO_INCOMING': UPLOAD_DIR,
                            'YIBIAO_MASTER_ZIP': MASTER_ZIP,
                        })
                        cmd = [sys.executable, MERGE_SCRIPT]
                        # 优先降 I/O 优先级（ionice），再降 CPU 优先级（nice）；工具缺失时自动跳过
                        if shutil.which('ionice'):
                            cmd = ['ionice', '-c', '2', '-n', '7'] + cmd
                        if shutil.which('nice'):
                            cmd = ['nice', '-n', '10'] + cmd
                        subprocess.Popen(cmd, env=env,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception as e:
                    log('merge trigger failed: %s' % e)
                self._send_json(200, {'ok': True, 'received': zip_name, 'size': zip_size})
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
        # A5（成员可在根目录建文件夹）+ A3（他人可编辑）：成员可在团队库任意文件夹（含根目录）创建/写入。
        # 删除权限由 A1 在 _kb_DELETE 单独控制（P2 落实：只能删自己的）。
        return True, None

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

    def _send_zip(self, data, filename):
        self.send_response(200)
        self.send_header('Content-Type', 'application/zip')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + quote(filename))
        self.end_headers()
        self.wfile.write(data)

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
            # 管理员重置自己密码时保留当前会话，避免后续操作被误判为未登录
            keep_token = None
            if str(data.get('user_id')) == str(admin['id']):
                auth = self.headers.get('Authorization', '')
                if auth.startswith('Bearer '):
                    keep_token = auth[7:].strip()
            ok, err = kb_db.reset_password(data.get('user_id'), data.get('new_password'), keep_token)
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
            parent_id = data.get('parent_id') or data.get('parent')
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
            # 触发服务器侧分析 Worker（独立 Node 进程）。
            # _trigger_worker_analysis 是模块级函数（不是类方法），且用后台线程发起，
            # 避免同步 urlopen 拖慢上传响应，也避免触发失败影响上传结果。
            threading.Thread(
                target=_trigger_worker_analysis,
                args=(doc.get('id'), 'team'),
                daemon=True,
            ).start()
            return self._send(200, {'success': True, 'data': {k: doc[k] for k in ('id', 'folder_id', 'owner_id', 'title', 'file_name', 'file_size', 'mime_type', 'created_at')}})

        # ==================== 全局模型配置（管理员设置，全员生效）====================
        if path == '/api/admin/model-config':
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            # POST：保存配置
            base_url = (data.get('base_url') or '').strip()
            api_key = data.get('api_key')  # 允许为空（表示清除）；前端传 null/空串即清除
            analysis_model = (data.get('analysis_model') or '').strip() or 'sensenova-6.7-flash-lite'
            qa_model = (data.get('qa_model') or '').strip() or 'sensenova-6.7-flash-lite'
            embedding_model = (data.get('embedding_model') or '').strip() or None
            if not base_url:
                return self._send(400, {'error': 'base_url 不能为空'})
            # api_key 为空串或 null 时清除；否则更新。前端若传 '__UNCHANGED__' 表示保留原值
            if api_key == '__UNCHANGED__':
                api_key = kb_db.get_model_config().get('api_key')
            elif api_key is not None:
                api_key = api_key.strip() or None
            kb_db.save_model_config(base_url, api_key, analysis_model, qa_model, embedding_model)
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin.get('username'),
                role='admin', action='admin', target_type='model_config', target_id='1',
                detail='更新全局模型配置', ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '模型配置已保存'})

        # ==================== 代理 sub2api 模型列表（服务端持 key）====================
        if path == '/api/models':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            cfg = kb_db.get_model_config()
            if not cfg.get('api_key'):
                return self._send(200, {'success': True, 'models': [], 'message': '服务端尚未配置 API Key'})
            try:
                import urllib.request
                req = urllib.request.Request(cfg['base_url'].rstrip('/') + '/models',
                                             headers={'Authorization': 'Bearer ' + cfg['api_key']})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    body = json.loads(resp.read().decode('utf-8'))
                models = []
                raw = body.get('data') if isinstance(body, dict) else None
                if isinstance(raw, list):
                    for m in raw:
                        if isinstance(m, dict) and m.get('id'):
                            models.append(m['id'])
                return self._send(200, {'success': True, 'models': models})
            except Exception as e:
                return self._send(200, {'success': False, 'models': [], 'message': '拉取模型列表失败: %s' % str(e)})

        # ==================== 团队库分析共享：写回分析结果 ====================
        m = re.match(r'^/api/documents/(\d+)/analysis$', path)
        if m:
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            doc = kb_db.get_document(m.group(1))
            if not doc:
                return self._send(404, {'error': '文档不存在'})
            payload = data.get('payload')
            if payload is None:
                return self._send(400, {'error': '缺少 payload'})
            # 即使客户端没传顶层 item_count/block_count，也从 payload 提取出来
            # （Worker 只传 {status, payload} 时由服务端兜底解析）
            item_count = data.get('item_count')
            block_count = data.get('block_count')
            filtered_block_count = data.get('filtered_block_count')
            candidate_item_count = data.get('candidate_item_count')
            if item_count is None or block_count is None:
                try:
                    payload_obj = json.loads(payload) if isinstance(payload, str) else payload
                    if isinstance(payload_obj, dict):
                        if item_count is None and isinstance(payload_obj.get('final_items'), list):
                            item_count = len(payload_obj['final_items'])
                        if block_count is None and isinstance(payload_obj.get('blocks'), list):
                            block_count = len(payload_obj['blocks'])
                        if filtered_block_count is None and isinstance(payload_obj.get('filtered_blocks'), list):
                            filtered_block_count = len(payload_obj['filtered_blocks'])
                        if candidate_item_count is None and isinstance(payload_obj.get('candidate_items'), list):
                            candidate_item_count = len(payload_obj['candidate_items'])
                except (TypeError, ValueError):
                    pass
            if not isinstance(payload, str):
                payload = json.dumps(payload, ensure_ascii=False)
            kb_db.save_team_analysis(
                m.group(1),
                data.get('status') or 'success',
                payload,
                item_count=item_count,
                block_count=block_count,
                analyzer_id=employee['id'],
                analyzer_name=employee.get('display_name') or employee.get('username'),
            )
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee.get('username'),
                role=employee.get('role'), action='doc', target_type='document', target_id=m.group(1),
                detail='团队库分析写回（全员共享）', ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '分析已保存，全员可共享'})

        # ==================== 团队库分析重试：重新触发服务器侧 Worker 分析 ====================
        m = re.match(r'^/api/documents/(\d+)/analysis/retry$', path)
        if m:
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            doc = kb_db.get_document(m.group(1))
            if not doc:
                return self._send(404, {'error': '文档不存在'})
            # 清除旧的共享分析结果，让重新分析从干净状态开始
            try:
                kb_db.delete_team_analysis(m.group(1))
            except Exception:
                pass
            threading.Thread(
                target=_trigger_worker_analysis,
                args=(m.group(1), 'team'),
                daemon=True,
            ).start()
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee.get('username'),
                role=employee.get('role'), action='doc', target_type='document', target_id=m.group(1),
                detail='团队库分析重试', ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '已重新触发分析'})

        # ==================== 个人库分析写回（Worker 回写；随文档同步，owner 隔离）====================
        # 文档 ID 可能是普通十六进制，也可能是从团队库同步下来的 team-<team_id>-<user_id>。
        m = re.match(r'^/api/personal/documents/([0-9a-fA-F]+|team-\d+-\d+)/analysis$', path)
        if m:
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            doc, err = self._personal_doc_owner_check(m.group(1), employee)
            if err is not None:
                return
            payload = data.get('payload')
            if payload is None:
                return self._send(400, {'error': '缺少 payload'})
            # 即使客户端没传顶层统计字段，也从 payload 提取（与个人库字段保持一致）
            item_count = data.get('item_count')
            block_count = data.get('block_count')
            filtered_block_count = data.get('filtered_block_count')
            candidate_item_count = data.get('candidate_item_count')
            if item_count is None or block_count is None:
                try:
                    payload_obj = json.loads(payload) if isinstance(payload, str) else payload
                    if isinstance(payload_obj, dict):
                        if item_count is None and isinstance(payload_obj.get('final_items'), list):
                            item_count = len(payload_obj['final_items'])
                        if block_count is None and isinstance(payload_obj.get('blocks'), list):
                            block_count = len(payload_obj['blocks'])
                        if filtered_block_count is None and isinstance(payload_obj.get('filtered_blocks'), list):
                            filtered_block_count = len(payload_obj['filtered_blocks'])
                        if candidate_item_count is None and isinstance(payload_obj.get('candidate_items'), list):
                            candidate_item_count = len(payload_obj['candidate_items'])
                except (TypeError, ValueError):
                    pass
            if not isinstance(payload, str):
                payload = json.dumps(payload, ensure_ascii=False)
            _master_save_analysis(
                m.group(1),
                data.get('status') or 'success',
                payload,
                item_count=item_count,
                block_count=block_count,
                analyzer_id=employee['id'],
                analyzer_name=employee.get('display_name') or employee.get('username'),
            )
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee.get('username'),
                role=employee.get('role'), action='doc', target_type='personal_document', target_id=m.group(1),
                detail='个人库分析写回', ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '分析已保存'})

        # ==================== 个人库分析重试：重新触发 Worker 分析 ====================
        m = re.match(r'^/api/personal/documents/([0-9a-fA-F]+|team-\d+-\d+)/analysis/retry$', path)
        if m:
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            doc, err = self._personal_doc_owner_check(m.group(1), employee)
            if err is not None:
                return
            try:
                _master_delete_analysis(m.group(1))
            except Exception:
                pass
            threading.Thread(
                target=_trigger_worker_analysis,
                args=(m.group(1), 'personal'),
                daemon=True,
            ).start()
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee.get('username'),
                role=employee.get('role'), action='doc', target_type='personal_document', target_id=m.group(1),
                detail='个人库分析重试', ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '已重新触发分析'})

        # ==================== 个人库写接口（需登录会话）====================
        if path == '/api/personal/folders':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            name = (data.get('name') or '').strip()
            if not name:
                return self._send(400, {'error': '文件夹名称不能为空'})
            folder, err = self._personal_create_folder(name, data.get('parent_id'), employee)
            if err:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='folder', target_type='personal_folder',
                target_id=folder.get('id'), detail='个人库创建文件夹: %s' % name, ip=_client_ip(self))
            return self._send(200, {'success': True, 'data': folder})

        if path == '/api/personal/documents':
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
            doc, err = self._personal_upload(folder_id, f['filename'], f['data'], employee)
            if err:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='doc', target_type='personal_document',
                target_id=doc.get('id'),
                detail='个人库上传文档: %s (%.1fKB)' % (doc['file_name'], len(f['data']) / 1024),
                ip=_client_ip(self))
            return self._send(200, {'success': True, 'data': doc})

        # ==================== 双向同步 ====================
        if path == '/api/import/personal':
            # 个人库 → 团队库（需登录会话）
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            if not data or 'documents' not in data:
                return self._send(400, {'error': '缺少 documents 数组'})
            folder_id = data.get('folder_id')
            auto_folder = False
            folder_name = None
            if folder_id:
                ok, err = self._can_write_folder(employee, folder_id)
                if not ok:
                    return self._send(403, {'error': err})
            else:
                # 未指定目标文件夹：自动在团队库创建（用选中的个人库文件夹名，否则用时间戳）
                name = self._auto_team_folder_name(data.get('folders') or [], employee)
                folder, ferr = kb_db.create_folder(name, None, employee['id'])
                if ferr or not folder:
                    return self._send(400, {'error': ferr or '创建目标团队文件夹失败'})
                folder_id = folder['id']
                auto_folder = True
                folder_name = folder['name']
            created, failed = [], []
            for pfid in (data.get('folders') or []):
                collected = []
                self._collect_master_folder_docs(str(pfid), collected)
                for did in collected:
                    remote, rname, ierr, asyn = self._import_personal_doc_to_team(str(did), int(folder_id), employee)
                    if remote is None:
                        failed.append({'document_id': did, 'error': ierr or '导入失败'})
                        continue
                    created.append({'document_id': did, 'remote_id': remote, 'file_name': rname, 'analysis_synced': asyn})
            for item in data['documents']:
                doc_id = item.get('document_id') or item.get('id')
                if not doc_id:
                    continue
                remote, rname, ierr, asyn = self._import_personal_doc_to_team(str(doc_id), int(folder_id), employee)
                if remote is None:
                    failed.append({'document_id': doc_id, 'error': ierr or '导入失败'})
                    continue
                created.append({'document_id': doc_id, 'remote_id': remote, 'file_name': rname, 'analysis_synced': asyn})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='import', target_type='document',
                detail='个人库→团队库: 成功 %d, 失败 %d' % (len(created), len(failed)),
                ip=_client_ip(self))
            return self._send(200, {'success': True, 'created': created, 'failed': failed,
                                    'auto_folder': auto_folder, 'folder_name': folder_name,
                                    'folder_id': folder_id})

        if path == '/api/import/team':
            # 团队库 → 个人库（需登录会话）
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            if not data or 'documents' not in data:
                return self._send(400, {'error': '缺少 documents 数组'})
            synced = []
            for fid in (data.get('folders') or []):
                try:
                    tfid = int(fid)
                except (ValueError, TypeError):
                    continue
                collected = []
                self._collect_team_folder_docs(tfid, collected)
                for did in collected:
                    ok, personal_id, personal_folder_id, fname, msg = self._sync_team_to_master(did, employee)
                    synced.append({'id': did, 'ok': bool(ok), 'personal_id': personal_id,
                                   'folder_id': personal_folder_id, 'file_name': fname, 'msg': msg})
            for item in data['documents']:
                doc_id = item.get('id') or item.get('document_id')
                try:
                    did = int(doc_id)
                except (ValueError, TypeError):
                    continue
                ok, personal_id, personal_folder_id, fname, msg = self._sync_team_to_master(did, employee)
                synced.append({'id': did, 'ok': bool(ok), 'personal_id': personal_id,
                               'folder_id': personal_folder_id, 'file_name': fname, 'msg': msg})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='import', target_type='document',
                detail='团队库→个人库: %d 篇' % len(synced), ip=_client_ip(self))
            return self._send(200, {'success': True, 'synced': synced})

        if path == '/api/trash/restore':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            ttype = data.get('type')
            tid = data.get('id')
            if ttype == 'folder':
                f = kb_db.get_folder(tid, include_deleted=True)
                if not f:
                    return self._send(404, {'error': '文件夹不存在'})
                if employee['role'] != 'admin' and str(f.get('deleted_by')) != str(employee['id']):
                    return self._send(403, {'error': '只能恢复自己删除的文件夹'})
                ok, err = kb_db.restore_folder(tid)
            else:
                d = kb_db.get_document(tid)
                if not d:
                    return self._send(404, {'error': '文档不存在'})
                if employee['role'] != 'admin' and str(d.get('deleted_by')) != str(employee['id']):
                    return self._send(403, {'error': '只能恢复自己删除的文档'})
                ok, err = kb_db.restore_document(tid)
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='restore', target_type=ttype or 'document', target_id=tid,
                detail='从回收站恢复', ip=_client_ip(self))
            return self._send(200, {'success': True})
        if path == '/api/personal/trash/restore':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            ok, err = self._personal_restore(data.get('type'), data.get('id'), employee)
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='restore', target_type=data.get('type') or 'document',
                target_id=data.get('id'), detail='从回收站恢复个人文件', ip=_client_ip(self))
            return self._send(200, {'success': True})

        return self._send(404, {'error': '接口不存在'})

    # ==================== 个人库（主库 master.sqlite）辅助方法 ====================
    # 真实 schema（见 sync-server/merge.py SCHEMA_SQL）：
    #   knowledge_folders(folder_id TEXT PK, name, sort_order, created_at, updated_at [, parent_id 动态加列])
    #   knowledge_documents(document_id TEXT PK, folder_id TEXT, file_name, status, progress, ...)
    #   物理文件在 MASTER_KB/folders/<folder_id>/documents/<document_id>/ 下

    @staticmethod
    def _master_folder_cols(conn):
        return {r[1] for r in conn.execute("PRAGMA table_info(knowledge_folders)").fetchall()}

    @staticmethod
    def _ensure_parent_col(conn):
        """给主库 knowledge_folders 补 parent_id 列（子文件夹支持，向后兼容）。"""
        if 'parent_id' not in CombinedHandler._master_folder_cols(conn):
            conn.execute("ALTER TABLE knowledge_folders ADD COLUMN parent_id TEXT")
            conn.commit()

    @staticmethod
    def _ensure_owner_cols(conn):
        """给主库 knowledge_folders / knowledge_documents 补 owner 隔离列（向后兼容）。"""
        folder_cols = CombinedHandler._master_folder_cols(conn)
        if 'owner_id' not in folder_cols:
            conn.execute("ALTER TABLE knowledge_folders ADD COLUMN owner_id INTEGER")
        if 'owner_name' not in folder_cols:
            conn.execute("ALTER TABLE knowledge_folders ADD COLUMN owner_name TEXT")
        doc_cols = {c[1] for c in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()}
        if 'owner_id' not in doc_cols:
            conn.execute("ALTER TABLE knowledge_documents ADD COLUMN owner_id INTEGER")
        if 'owner_name' not in doc_cols:
            conn.execute("ALTER TABLE knowledge_documents ADD COLUMN owner_name TEXT")
        if 'content_text' not in doc_cols:
            conn.execute("ALTER TABLE knowledge_documents ADD COLUMN content_text TEXT")
        # 个人库分析结果表（对齐团队库 kb.sqlite 的 kb_analysis；主键为 TEXT document_id）。
        # 分析结果存 master.sqlite，随现有个人库同步机制走；可见性由 document 的 owner 隔离天然保证
        # （成员只看自己 + admin 看全部），因此本表不再单独存 owner 列。
        conn.execute('''
            CREATE TABLE IF NOT EXISTS kb_analysis (
                document_id   TEXT PRIMARY KEY,
                status        TEXT,
                payload       TEXT,
                item_count    INTEGER,
                block_count   INTEGER,
                analyzer_id   INTEGER,
                analyzer_name TEXT,
                updated_at    TEXT NOT NULL
            )
        ''')
        conn.commit()

    def _personal_folders(self, employee):
        """从 master.sqlite 读取当前用户的文件夹列表（含 parent_id，支持子文件夹）。"""
        conn = _master_db_conn()
        if conn is None:
            return []
        try:
            self._ensure_owner_cols(conn)
            has_parent = 'parent_id' in self._master_folder_cols(conn)
            has_owner = 'owner_id' in self._master_folder_cols(conn)
            sel = "folder_id, name, sort_order, created_at, updated_at" + (", parent_id" if has_parent else "") + (", owner_id" if has_owner else "")
            q = "SELECT %s FROM knowledge_folders" % sel
            args = ()
            where = []
            if has_owner and employee and employee.get('role') != 'admin':
                where.append("(owner_id=? OR owner_id IS NULL)")
                args = (employee['id'],)
            where.append("(deleted_at IS NULL OR deleted_at='')")
            if where:
                q += " WHERE " + " AND ".join(where)
            q += " ORDER BY sort_order, name"
            rows = conn.execute(q, args).fetchall()
            out = []
            for r in rows:
                d = {
                    'id': r[0], 'name': r[1], 'sort_order': r[2],
                    'created_at': r[3], 'updated_at': r[4],
                    'parent_id': r[5] if has_parent else None,
                }
                if has_owner:
                    d['owner_id'] = r[6] if has_parent else r[5]
                out.append(d)
            return out
        finally:
            conn.close()

    def _personal_documents(self, folder_id, employee):
        """从 master.sqlite 读取当前用户的文档列表（folder_id 为空 = 全部）。"""
        conn = _master_db_conn()
        if conn is None:
            return []
        try:
            self._ensure_owner_cols(conn)
            cols = [c[1] for c in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()]
            want = ['document_id', 'folder_id', 'file_name', 'status', 'progress',
                    'item_count', 'block_count', 'created_at', 'updated_at', 'uploaded_by', 'owner_id', 'owner_name']
            sel = [c for c in want if c in cols]
            conditions = []
            args = []
            if 'is_deleted' in cols:
                conditions.append("COALESCE(is_deleted,0)=0")
            conditions.append("(deleted_at IS NULL OR deleted_at='')")
            if 'owner_id' in cols and employee and employee.get('role') != 'admin':
                conditions.append("(owner_id=? OR owner_id IS NULL)")
                args.append(employee['id'])
            q = "SELECT %s FROM knowledge_documents" % ','.join(sel)
            if conditions:
                q += " WHERE " + " AND ".join(conditions)
            if folder_id not in (None, '', '0', 'null'):
                q += (" AND " if conditions else " WHERE ") + "folder_id=?"
                args.append(str(folder_id))
            q += " ORDER BY created_at DESC"
            rows = conn.execute(q, tuple(args)).fetchall()
            out = []
            for r in rows:
                d = dict(zip(sel, r))
                d['id'] = d.get('document_id')
                d['title'] = d.get('file_name')
                out.append(d)
            return out
        finally:
            conn.close()

    def _personal_doc_dir(self, folder_id, doc_id):
        return os.path.join(MASTER_KB, 'folders', str(folder_id), 'documents', str(doc_id))

    def _personal_doc_owner_check(self, doc_id_str, employee):
        """校验个人库文档归属：返回 (doc_dict, error_response_sent)。
        非管理员只能访问自己的文档（owner_id 为空视为公共，允许访问）。
        error_response_sent 为 True 时调用方已发出响应，应直接 return。"""
        conn = _master_db_conn()
        if conn is None:
            return None, self._send(404, {'error': '个人库不可用'})
        try:
            self._ensure_owner_cols(conn)
            row = conn.execute(
                "SELECT document_id, folder_id, file_name, owner_id "
                "FROM knowledge_documents WHERE document_id=?", (str(doc_id_str),)).fetchone()
        finally:
            conn.close()
        if not row:
            return None, self._send(404, {'error': '文档不存在'})
        owner_id = row['owner_id']
        if employee and employee.get('role') != 'admin' and owner_id is not None and owner_id != employee['id']:
            return None, self._send(403, {'error': '无权访问该文档'})
        return {'document_id': row['document_id'], 'folder_id': row['folder_id'],
                'file_name': row['file_name'], 'owner_id': owner_id}, None

    def _send_personal_file(self, doc_id_str, employee):
        """发送个人库文件（document_id 为 TEXT 主键），非管理员只能访问自己的文件。"""
        conn = _master_db_conn()
        if conn is None:
            return self._send(404, {'error': '主库不可用'})
        try:
            self._ensure_owner_cols(conn)
            row = conn.execute(
                "SELECT document_id, folder_id, file_name, owner_id FROM knowledge_documents WHERE document_id=?",
                (str(doc_id_str),)).fetchone()
        finally:
            conn.close()
        if not row:
            return self._send(404, {'error': '文档不存在'})
        doc_id, folder_id, file_name, owner_id = row
        if employee and employee.get('role') != 'admin' and owner_id is not None and owner_id != employee['id']:
            return self._send(403, {'error': '无权访问该文档'})
        base = self._personal_doc_dir(folder_id, doc_id)
        candidates = []
        if os.path.isdir(base):
            for root, _dirs, files in os.walk(base):
                for f in files:
                    candidates.append(os.path.join(root, f))
        fp = None
        for c in candidates:  # 优先同名原始文件
            if os.path.basename(c) == file_name:
                fp = c
                break
        if fp is None and candidates:
            fp = candidates[0]
        if fp is None or not os.path.isfile(fp):
            return self._send(404, {'error': '文件已丢失'})
        import mimetypes
        mime = mimetypes.guess_type(fp)[0] or 'application/octet-stream'
        self._send_file(fp, file_name or os.path.basename(fp), mime)

    def _personal_create_folder(self, name, parent_id=None, employee=None):
        """个人库新建文件夹（支持 parent_id 子文件夹），写入当前用户 owner。"""
        with _MASTER_LOCK:
            conn = _master_db_conn()
            if conn is None:
                return None, '个人库尚未初始化（先在桌面端同步一次）'
            try:
                self._ensure_parent_col(conn)
                self._ensure_owner_cols(conn)
                if parent_id:
                    exists = conn.execute(
                        "SELECT 1 FROM knowledge_folders WHERE folder_id=?", (str(parent_id),)).fetchone()
                    if not exists:
                        return None, '父文件夹不存在'
                now = datetime.datetime.now().isoformat()
                fid = uuid.uuid4().hex
                owner_id = employee['id'] if employee else None
                owner_name = (employee.get('display_name') or employee.get('username')) if employee else None
                conn.execute(
                    "INSERT INTO knowledge_folders (folder_id, name, sort_order, created_at, updated_at, parent_id, owner_id, owner_name) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (fid, name, 0, now, now, str(parent_id) if parent_id else None, owner_id, owner_name))
                conn.commit()
                return {'id': fid, 'name': name, 'parent_id': parent_id,
                        'created_at': now, 'updated_at': now, 'owner_id': owner_id, 'owner_name': owner_name}, None
            finally:
                conn.close()

    def _personal_upload(self, folder_id, filename, data, employee):
        """个人库上传文档：写 master.sqlite + 落物理文件，绑定当前用户 owner。"""
        if not data:
            return None, '文件内容为空'
        filename = os.path.basename((filename or '').replace('\\', '/')) or 'file'
        with _MASTER_LOCK:
            conn = _master_db_conn()
            if conn is None:
                return None, '个人库尚未初始化（先在桌面端同步一次）'
            try:
                self._ensure_owner_cols(conn)
                exists = conn.execute(
                    "SELECT 1 FROM knowledge_folders WHERE folder_id=?", (str(folder_id),)).fetchone()
                if not exists:
                    return None, '目标文件夹不存在'
                # 非管理员只能上传到自己的文件夹
                if employee and employee.get('role') != 'admin':
                    folder_owner = conn.execute(
                        "SELECT owner_id FROM knowledge_folders WHERE folder_id=?", (str(folder_id),)).fetchone()
                    if folder_owner and folder_owner[0] is not None and folder_owner[0] != employee['id']:
                        return None, '只能上传到自己创建的个人文件夹'
                cols = {c[1] for c in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()}
                # 补 content_text 列并抽取正文，供个人库全文检索（mode=content）使用。
                if 'content_text' not in cols:
                    conn.execute("ALTER TABLE knowledge_documents ADD COLUMN content_text TEXT")
                    cols.add('content_text')
                now = datetime.datetime.now().isoformat()
                doc_id = uuid.uuid4().hex
                doc_dir_rel = 'folders/%s/documents/%s' % (folder_id, doc_id)
                owner_id = employee['id'] if employee else None
                owner_name = (employee.get('display_name') or employee.get('username')) if employee else None
                import mimetypes as _mt
                _mime = _mt.guess_type(filename)[0] or 'application/octet-stream'
                content_text = kb_db._extract_text_for_search(data, filename, _mime)
                fields = {
                    'document_id': doc_id, 'folder_id': str(folder_id), 'file_name': filename,
                    'document_dir': doc_dir_rel, 'source_path': '%s/%s' % (doc_dir_rel, filename),
                    'markdown_path': '', 'status': 'success', 'progress': 100,
                    'message': '通过服务器上传', 'created_at': now, 'updated_at': now,
                    'owner_id': owner_id, 'owner_name': owner_name,
                    'content_text': content_text,
                }
                if 'uploaded_by' in cols:
                    fields['uploaded_by'] = owner_name
                if 'uploaded_at' in cols:
                    fields['uploaded_at'] = now
                if 'is_deleted' in cols:
                    fields['is_deleted'] = 0
                keys = [k for k in fields if k in cols]
                conn.execute(
                    "INSERT INTO knowledge_documents (%s) VALUES (%s)" % (
                        ','.join(keys), ','.join('?' * len(keys))),
                    tuple(fields[k] for k in keys))
                conn.commit()
            finally:
                conn.close()
        dst_dir = self._personal_doc_dir(folder_id, doc_id)
        os.makedirs(dst_dir, exist_ok=True)
        with open(os.path.join(dst_dir, filename), 'wb') as fh:
            fh.write(data)
        # 触发个人库服务器侧分析（结构化条目抽取），与团队库对齐；fire-and-forget
        _trigger_worker_analysis(doc_id, 'personal')
        return {'id': doc_id, 'folder_id': folder_id, 'title': filename,
                'file_name': filename, 'file_size': len(data), 'created_at': now,
                'owner_id': owner_id, 'owner_name': owner_name}, None

    def _personal_delete_folder(self, folder_id, employee):
        """个人库软删文件夹（进回收站）：标记自身+后代文件夹+其文档的 deleted_at，保留物理文件。"""
        folder_id = str(folder_id)
        with _MASTER_LOCK:
            conn = _master_db_conn()
            if conn is None:
                return False, '个人库不可用'
            try:
                self._ensure_owner_cols(conn)
                self._ensure_deleted_col(conn)
                row = conn.execute(
                    "SELECT folder_id, name, owner_id FROM knowledge_folders WHERE folder_id=?",
                    (folder_id,)).fetchone()
                if not row:
                    return False, '文件夹不存在'
                if employee and employee.get('role') != 'admin' and row['owner_id'] is not None and row['owner_id'] != employee['id']:
                    return False, '只能删除自己创建的个人文件夹'
                ids = self._collect_master_descendant_folders(folder_id)
                ts = datetime.datetime.now().isoformat()
                by = str(employee['id']) if employee else None
                ph = ','.join('?' * len(ids))
                conn.execute(
                    "UPDATE knowledge_folders SET deleted_at=?, deleted_by=? WHERE folder_id IN (%s)" % ph,
                    [ts, by] + ids)
                docs = conn.execute(
                    "SELECT document_id FROM knowledge_documents WHERE folder_id IN (%s)" % ph, ids).fetchall()
                if docs:
                    dph = ','.join('?' * len(docs))
                    conn.execute(
                        "UPDATE knowledge_documents SET deleted_at=?, deleted_by=? WHERE document_id IN (%s)" % dph,
                        [ts, by] + [d['document_id'] for d in docs])
                conn.commit()
                return True, row['name']
            finally:
                conn.close()

    def _personal_move_folder(self, folder_id, new_parent_id, employee):
        """个人库移动文件夹：修改 parent_id，并防止循环嵌套。"""
        folder_id = str(folder_id)
        new_parent_id = str(new_parent_id) if new_parent_id not in (None, '', '0', 'null') else None
        with _MASTER_LOCK:
            conn = _master_db_conn()
            if conn is None:
                return False, '个人库不可用'
            try:
                self._ensure_parent_col(conn)
                self._ensure_owner_cols(conn)
                row = conn.execute(
                    "SELECT folder_id, owner_id FROM knowledge_folders WHERE folder_id=?",
                    (folder_id,)).fetchone()
                if not row:
                    return False, '文件夹不存在'
                if employee and employee.get('role') != 'admin' and row['owner_id'] is not None and row['owner_id'] != employee['id']:
                    return False, '只能移动自己创建的个人文件夹'
                if new_parent_id:
                    parent = conn.execute(
                        "SELECT folder_id FROM knowledge_folders WHERE folder_id=?",
                        (new_parent_id,)).fetchone()
                    if not parent:
                        return False, '目标父文件夹不存在'
                    # 防止移动到自身或子文件夹下
                    descendants = set()
                    frontier = [folder_id]
                    while frontier:
                        placeholders = ','.join('?' * len(frontier))
                        rows = conn.execute(
                            "SELECT folder_id FROM knowledge_folders WHERE parent_id IN (%s)" % placeholders,
                            frontier).fetchall()
                        frontier = []
                        for r in rows:
                            fid = r[0]
                            if fid not in descendants:
                                descendants.add(fid)
                                frontier.append(fid)
                    if new_parent_id == folder_id or new_parent_id in descendants:
                        return False, '不能将文件夹移动到自身或其子文件夹下'
                now = datetime.datetime.now().isoformat()
                conn.execute(
                    "UPDATE knowledge_folders SET parent_id=?, updated_at=? WHERE folder_id=?",
                    (new_parent_id, now, folder_id))
                conn.commit()
                return True, None
            finally:
                conn.close()

    def _personal_move_document(self, doc_id, new_folder_id, employee):
        """个人库移动文档：修改 folder_id，校验文档与目标文件夹存在且归属正确。"""
        doc_id = str(doc_id)
        new_folder_id = str(new_folder_id)
        with _MASTER_LOCK:
            conn = _master_db_conn()
            if conn is None:
                return False, '个人库不可用'
            try:
                self._ensure_owner_cols(conn)
                self._ensure_deleted_col(conn)
                row = conn.execute(
                    "SELECT document_id, owner_id FROM knowledge_documents WHERE document_id=?",
                    (doc_id,)).fetchone()
                if not row:
                    return False, '文档不存在'
                if employee and employee.get('role') != 'admin' and row['owner_id'] is not None and row['owner_id'] != employee['id']:
                    return False, '只能移动自己上传的个人文档'
                parent = conn.execute(
                    "SELECT folder_id FROM knowledge_folders WHERE folder_id=?",
                    (new_folder_id,)).fetchone()
                if not parent:
                    return False, '目标文件夹不存在'
                now = datetime.datetime.now().isoformat()
                conn.execute(
                    "UPDATE knowledge_documents SET folder_id=?, updated_at=? WHERE document_id=?",
                    (new_folder_id, now, doc_id))
                conn.commit()
                return True, None
            finally:
                conn.close()

    # ==================== 个人库：重命名 / 软删 / 回收站 / 恢复 / 搜索 / 导出 ====================

    def _ensure_deleted_col(self, conn):
        """给主库 knowledge_folders / knowledge_documents 补回收站软删列。"""
        for tbl in ('knowledge_folders', 'knowledge_documents'):
            cols = {c[1] for c in conn.execute("PRAGMA table_info(%s)" % tbl).fetchall()}
            if 'deleted_at' not in cols:
                conn.execute("ALTER TABLE %s ADD COLUMN deleted_at TEXT" % tbl)
            if 'deleted_by' not in cols:
                conn.execute("ALTER TABLE %s ADD COLUMN deleted_by TEXT" % tbl)
        conn.commit()

    def _personal_rename_folder(self, folder_id, name, employee):
        folder_id = str(folder_id)
        name = (name or '').strip()
        if not name:
            return False, '文件夹名不能为空'
        with _MASTER_LOCK:
            conn = _master_db_conn()
            if conn is None:
                return False, '个人库不可用'
            try:
                self._ensure_deleted_col(conn)
                row = conn.execute(
                    "SELECT folder_id, owner_id FROM knowledge_folders WHERE folder_id=?", (folder_id,)).fetchone()
                if not row:
                    return False, '文件夹不存在'
                if employee and employee.get('role') != 'admin' and row['owner_id'] is not None and row['owner_id'] != employee['id']:
                    return False, '只能重命名自己创建的个人文件夹'
                now = datetime.datetime.now().isoformat()
                conn.execute("UPDATE knowledge_folders SET name=?, updated_at=? WHERE folder_id=?", (name, now, folder_id))
                conn.commit()
                return True, None
            finally:
                conn.close()

    def _personal_delete_document(self, doc_id, employee):
        """个人库软删文档（进回收站）。"""
        doc_id = str(doc_id)
        with _MASTER_LOCK:
            conn = _master_db_conn()
            if conn is None:
                return False, '个人库不可用'
            try:
                self._ensure_deleted_col(conn)
                row = conn.execute(
                    "SELECT document_id, owner_id FROM knowledge_documents WHERE document_id=?", (doc_id,)).fetchone()
                if not row:
                    return False, '文档不存在'
                if employee and employee.get('role') != 'admin' and row['owner_id'] is not None and row['owner_id'] != employee['id']:
                    return False, '只能删除自己上传的个人文档'
                ts = datetime.datetime.now().isoformat()
                by = str(employee['id']) if employee else None
                conn.execute(
                    "UPDATE knowledge_documents SET deleted_at=?, deleted_by=? WHERE document_id=?", (ts, by, doc_id))
                conn.commit()
                return True, None
            finally:
                conn.close()

    def _personal_trash(self, employee):
        conn = _master_db_conn()
        if conn is None:
            return {'folders': [], 'documents': []}
        try:
            self._ensure_deleted_col(conn)
            folders = conn.execute(
                "SELECT folder_id,name,parent_id,owner_id,created_at,deleted_at,deleted_by "
                "FROM knowledge_folders WHERE deleted_at IS NOT NULL AND deleted_at<>'' ORDER BY deleted_at DESC").fetchall()
            docs = conn.execute(
                "SELECT document_id,folder_id,owner_id,file_name,created_at,deleted_at,deleted_by "
                "FROM knowledge_documents WHERE deleted_at IS NOT NULL AND deleted_at<>'' ORDER BY deleted_at DESC").fetchall()
            out_f = [{'id': r[0], 'name': r[1], 'parent_id': r[2], 'owner_id': r[3],
                     'created_at': r[4], 'deleted_at': r[5], 'deleted_by': r[6]} for r in folders]
            out_d = [{'id': r[0], 'folder_id': r[1], 'owner_id': r[2], 'title': r[3],
                     'created_at': r[4], 'deleted_at': r[5], 'deleted_by': r[6]} for r in docs]
            return {'folders': out_f, 'documents': out_d}
        finally:
            conn.close()

    def _personal_restore(self, target_type, target_id, employee):
        conn = _master_db_conn()
        if conn is None:
            return False, '个人库不可用'
        try:
            self._ensure_deleted_col(conn)
            by = str(employee['id'])
            if target_type == 'folder':
                row = conn.execute(
                    "SELECT folder_id,deleted_by FROM knowledge_folders WHERE folder_id=?", (str(target_id),)).fetchone()
                if not row:
                    return False, '文件夹不存在'
                if employee.get('role') != 'admin' and str(row['deleted_by']) != by:
                    return False, '只能恢复自己删除的文件夹'
                ids = self._collect_master_descendant_folders(str(target_id))
                ph = ','.join('?' * len(ids))
                conn.execute("UPDATE knowledge_folders SET deleted_at=NULL WHERE folder_id IN (%s)" % ph, ids)
                docs = conn.execute(
                    "SELECT document_id FROM knowledge_documents WHERE folder_id IN (%s)" % ph, ids).fetchall()
                if docs:
                    dph = ','.join('?' * len(docs))
                    conn.execute("UPDATE knowledge_documents SET deleted_at=NULL WHERE document_id IN (%s)" % dph,
                                 [d['document_id'] for d in docs])
                conn.commit()
                return True, None
            else:
                row = conn.execute(
                    "SELECT document_id,deleted_by FROM knowledge_documents WHERE document_id=?", (str(target_id),)).fetchone()
                if not row:
                    return False, '文档不存在'
                if employee.get('role') != 'admin' and str(row['deleted_by']) != by:
                    return False, '只能恢复自己删除的文档'
                conn.execute("UPDATE knowledge_documents SET deleted_at=NULL WHERE document_id=?", (str(target_id),))
                conn.commit()
                return True, None
        finally:
            conn.close()

    def _personal_search(self, kw, mode, employee=None):
        conn = _master_db_conn()
        if conn is None:
            return []
        try:
            self._ensure_owner_cols(conn)
            pattern = '%' + kw.replace('%', '').replace('_', '') + '%'
            owner_filter = ''
            args = []
            if employee and employee.get('role') != 'admin':
                owner_filter = " AND (owner_id=? OR owner_id IS NULL)"
                args = [employee['id']]
            if mode == 'content':
                cols = [c[1] for c in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()]
                if 'content_text' in cols:
                    q = ("SELECT document_id,folder_id,file_name,owner_id,created_at FROM knowledge_documents "
                         "WHERE (deleted_at IS NULL OR deleted_at='') AND "
                         "(file_name LIKE ? OR COALESCE(content_text,'') LIKE ?)" + owner_filter + " ORDER BY created_at DESC")
                    rows = conn.execute(q, (pattern, pattern) + tuple(args)).fetchall()
                else:
                    q = ("SELECT document_id,folder_id,file_name,owner_id,created_at FROM knowledge_documents "
                         "WHERE (deleted_at IS NULL OR deleted_at='') AND file_name LIKE ?" + owner_filter + " ORDER BY created_at DESC")
                    rows = conn.execute(q, (pattern,) + tuple(args)).fetchall()
            else:
                q = ("SELECT document_id,folder_id,file_name,owner_id,created_at FROM knowledge_documents "
                     "WHERE (deleted_at IS NULL OR deleted_at='') AND file_name LIKE ?" + owner_filter + " ORDER BY created_at DESC")
                rows = conn.execute(q, (pattern,) + tuple(args)).fetchall()
            return [{'id': r[0], 'folder_id': r[1], 'title': r[2], 'owner_id': r[3], 'created_at': r[4]}
                    for r in rows]
        finally:
            conn.close()

    def _qa_keyword_patterns(self, kw):
        """把自然语言问句拆成多个检索词（整句 + 中文2-gram + 英文/数字词），用于 OR 匹配提升召回。"""
        import re
        raw = (kw or '').strip()
        if not raw:
            return []
        patterns = [raw]
        for seg in re.split(r'[\s,，。.、；;：:！!？?""\'\'（）()【】\[\]<>《》/\\|+\-=~`@#$%^&*_]+', raw):
            seg = seg.strip()
            if not seg:
                continue
            if re.search(r'[\u4e00-\u9fff]', seg):
                for m in re.finditer(r'[\u4e00-\u9fff]+', seg):
                    s = m.group(0)
                    if len(s) >= 2:
                        for i in range(len(s) - 1):
                            patterns.append(s[i:i + 2])
                    elif len(s) == 1:
                        patterns.append(s)
                if re.search(r'[0-9A-Za-z]', seg):
                    patterns.append(seg)
            else:
                if len(seg) >= 2:
                    patterns.append(seg)
        # 年份归一化：让"25年"也能匹配文档里的"2025年"（当前世纪），提升召回
        _year_norm = []
        for _p in patterns:
            _year_norm.append(_p)
            _m = re.search(r'(\d{2})年', _p)
            if _m:
                _year_norm.append(_p.replace(_m.group(0), '20' + _m.group(1) + '年', 1))
        patterns = _year_norm
        seen = set()
        uniq = []
        for p in patterns:
            p = p.replace('%', '').replace('_', '')
            if not p or p in seen:
                continue
            seen.add(p)
            uniq.append('%' + p + '%')
        return uniq[:16]

    def _qa_team_retrieve(self, kw, limit=3, snippet_chars=2500):
        """团队库 QA 召回：按正文/标题多词 OR 匹配，返回含 content_text 片段的文档列表。"""
        import sqlite3 as _sql
        patterns = self._qa_keyword_patterns(kw)
        if not patterns:
            return []
        conn = _sql.connect(kb_db.DB_PATH)
        try:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.row_factory = _sql.Row
            cols = [c[1] for c in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()]
            if 'content_text' not in cols:
                return []
            or_clauses = []
            args = []
            for pat in patterns:
                or_clauses.append("(title LIKE ? OR file_name LIKE ? OR COALESCE(content_text,'') LIKE ?)")
                args.extend([pat, pat, pat])
            q = ("SELECT id, folder_id, title, file_name, mime_type, content_text, created_at "
                 "FROM knowledge_documents "
                 "WHERE (deleted_at IS NULL OR deleted_at='') AND (" + " OR ".join(or_clauses) + ") "
                 "ORDER BY created_at DESC LIMIT ?")
            rows = conn.execute(q, tuple(args) + (limit,)).fetchall()
            out = []
            for r in rows:
                text = (r['content_text'] or '')
                if len(text) > snippet_chars:
                    text = text[:snippet_chars] + '\n...（内容已截断）'
                out.append({
                    'id': r['id'],
                    'folder_id': r['folder_id'],
                    'title': r['title'] or r['file_name'],
                    'file_name': r['file_name'],
                    'mime_type': r['mime_type'],
                    'created_at': r['created_at'],
                    'content_text': text,
                })
            return out
        finally:
            conn.close()

    def _qa_personal_retrieve(self, kw, employee, limit=3, snippet_chars=2500):
        """个人库 QA 召回：按正文/标题多词 OR 匹配，返回含 content_text 片段的文档列表。"""
        conn = _master_db_conn()
        if conn is None:
            return []
        try:
            self._ensure_owner_cols(conn)
            patterns = self._qa_keyword_patterns(kw)
            if not patterns:
                return []
            owner_filter = ''
            args = []
            if employee and employee.get('role') != 'admin':
                owner_filter = " AND (owner_id=? OR owner_id IS NULL)"
                args = [employee['id']]
            cols = [c[1] for c in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()]
            if 'content_text' not in cols:
                return []
            or_clauses = []
            pat_args = []
            for pat in patterns:
                or_clauses.append("(file_name LIKE ? OR COALESCE(content_text,'') LIKE ?)")
                pat_args.extend([pat, pat])
            q = ("SELECT document_id,folder_id,file_name,COALESCE(content_text,'') AS content_text,created_at "
                 "FROM knowledge_documents "
                 "WHERE (deleted_at IS NULL OR deleted_at='') AND (" + " OR ".join(or_clauses) + ")" + owner_filter +
                 " ORDER BY created_at DESC LIMIT ?")
            rows = conn.execute(q, tuple(pat_args) + tuple(args) + (limit,)).fetchall()
            out = []
            for r in rows:
                text = (r['content_text'] or '')
                if len(text) > snippet_chars:
                    text = text[:snippet_chars] + '\n...（内容已截断）'
                out.append({
                    'id': r['document_id'],
                    'folder_id': r['folder_id'],
                    'title': r['file_name'],
                    'file_name': r['file_name'],
                    'created_at': r['created_at'],
                    'content_text': text,
                })
            return out
        finally:
            conn.close()

    def _qa_team_corpus(self, max_chars=30000):
        """团队库 QA 语料：返回所有未删除文档的 {id,title,file_name,content_text,created_at}。
        仅供客户端 RAG 向量化使用（只读）。content_text 截断到 max_chars。"""
        import sqlite3 as _sql
        conn = _sql.connect(kb_db.DB_PATH)
        try:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.row_factory = _sql.Row
            cols = [c[1] for c in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()]
            if 'content_text' not in cols:
                return []
            rows = conn.execute(
                "SELECT id, folder_id, title, file_name, mime_type, COALESCE(content_text,'') AS content_text, created_at "
                "FROM knowledge_documents "
                "WHERE (deleted_at IS NULL OR deleted_at='') "
                "ORDER BY created_at DESC"
            ).fetchall()
            out = []
            for r in rows:
                text = (r['content_text'] or '')
                if len(text) > max_chars:
                    text = text[:max_chars]
                out.append({
                    'id': r['id'],
                    'folder_id': r['folder_id'],
                    'title': r['title'] or r['file_name'],
                    'file_name': r['file_name'],
                    'mime_type': r['mime_type'],
                    'created_at': r['created_at'],
                    'content_text': text,
                })
            return out
        finally:
            conn.close()

    def _qa_personal_corpus(self, employee, max_chars=30000):
        """个人库 QA 语料：返回当前用户可见的所有未删除文档（非 admin 加 owner 过滤）。"""
        conn = _master_db_conn()
        if conn is None:
            return []
        try:
            self._ensure_owner_cols(conn)
            owner_filter = ''
            args = []
            if employee and employee.get('role') != 'admin':
                owner_filter = " AND (owner_id=? OR owner_id IS NULL)"
                args = [employee['id']]
            cols = [c[1] for c in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()]
            if 'content_text' not in cols:
                return []
            q = ("SELECT document_id,folder_id,file_name,COALESCE(content_text,'') AS content_text,created_at "
                 "FROM knowledge_documents "
                 "WHERE (deleted_at IS NULL OR deleted_at='')" + owner_filter +
                 " ORDER BY created_at DESC")
            rows = conn.execute(q, tuple(args)).fetchall()
            out = []
            for r in rows:
                text = (r['content_text'] or '')
                if len(text) > max_chars:
                    text = text[:max_chars]
                out.append({
                    'id': r['document_id'],
                    'folder_id': r['folder_id'],
                    'title': r['file_name'],
                    'file_name': r['file_name'],
                    'created_at': r['created_at'],
                    'content_text': text,
                })
            return out
        finally:
            conn.close()

    def _export_team_zip(self, ids, employee):
        import io
        buf = io.BytesIO()
        wanted = [int(i) for i in ids if str(i).isdigit()]
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
            for did in wanted:
                # 用 get_document（SELECT *）而非 list_documents（不含 file_path），
                # 否则 d['file_path'] 会 KeyError 崩溃导致导出 503。
                d = kb_db.get_document(did)
                if not d:
                    continue
                if d.get('deleted_at'):
                    continue
                if employee and employee.get('role') != 'admin' and d.get('owner_id') is not None and d['owner_id'] != employee['id']:
                    continue
                fp = d.get('file_path') or ''
                if not fp:
                    continue
                full = os.path.join(kb_db.KB_DATA_DIR, fp)
                if os.path.isfile(full):
                    z.write(full, '%s/%s' % (did, d.get('file_name') or 'file'))
        return buf.getvalue()

    def _export_personal_zip(self, ids, employee):
        import io
        buf = io.BytesIO()
        conn = _master_db_conn()
        if conn is None:
            return None
        try:
            self._ensure_owner_cols(conn)
            ph = ','.join('?' * len(ids)) or '?'
            rows = conn.execute(
                "SELECT document_id, folder_id, file_name, owner_id FROM knowledge_documents WHERE document_id IN (%s)" % ph,
                ids).fetchall()
            with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
                for r in rows:
                    if employee and employee.get('role') != 'admin' and r['owner_id'] is not None and r['owner_id'] != employee['id']:
                        continue
                    base = self._personal_doc_dir(r['folder_id'], r['document_id'])
                    fp = None
                    if os.path.isdir(base):
                        cands = []
                        for root, _d, files in os.walk(base):
                            for f in files:
                                cands.append(os.path.join(root, f))
                        for c in cands:
                            if os.path.basename(c) == r['file_name']:
                                fp = c
                                break
                        if fp is None and cands:
                            fp = cands[0]
                    if fp and os.path.isfile(fp):
                        z.write(fp, '%s/%s' % (r['document_id'], r['file_name'] or 'file'))
            return buf.getvalue()
        finally:
            conn.close()

    def _personal_hard_delete_folder_tree(self, folder_id):
        conn = _master_db_conn()
        if conn is None:
            return
        try:
            ids = self._collect_master_descendant_folders(str(folder_id))
            ph = ','.join('?' * len(ids))
            docs = conn.execute(
                "SELECT document_id,folder_id FROM knowledge_documents WHERE folder_id IN (%s)" % ph, ids).fetchall()
            for doc in docs:
                ddir = self._personal_doc_dir(doc['folder_id'], doc['document_id'])
                if os.path.isdir(ddir):
                    shutil.rmtree(ddir, ignore_errors=True)
            conn.execute("DELETE FROM knowledge_documents WHERE folder_id IN (%s)" % ph, ids)
            conn.execute("DELETE FROM knowledge_folders WHERE folder_id IN (%s)" % ph, ids)
            conn.commit()
        finally:
            conn.close()

    def _personal_purge_expired_trash(self, hours=24):
        cutoff = (datetime.datetime.now() - datetime.timedelta(hours=hours)).isoformat()
        conn = _master_db_conn()
        if conn is None:
            return (0, 0)
        try:
            # 主库可能尚未有 deleted_at/deleted_by 列（用户从未删过东西），
            # 而 purge 会在每次访问回收站与后台线程中先于任何删除操作运行，
            # 必须先补列，否则 SELECT deleted_at 会抛 OperationalError 崩连接。
            self._ensure_deleted_col(conn)
            frows = conn.execute(
                "SELECT folder_id FROM knowledge_folders WHERE deleted_at IS NOT NULL AND deleted_at<>'' AND deleted_at<?",
                (cutoff,)).fetchall()
            for f in frows:
                self._personal_hard_delete_folder_tree(f['folder_id'])
            drows = conn.execute(
                "SELECT document_id,folder_id FROM knowledge_documents WHERE deleted_at IS NOT NULL AND deleted_at<>'' AND deleted_at<?",
                (cutoff,)).fetchall()
            for d in drows:
                ddir = self._personal_doc_dir(d['folder_id'], d['document_id'])
                if os.path.isdir(ddir):
                    shutil.rmtree(ddir, ignore_errors=True)
                conn.execute("DELETE FROM knowledge_documents WHERE document_id=?", (d['document_id'],))
            conn.commit()
            return (len(frows), len(drows))
        finally:
            conn.close()

    def _ensure_team_transfer_folder(self, name, admin_id):
        """A4：在团队库根目录找到或创建「xxx账户转交待处理」文件夹，返回 folder_id。"""
        folder_name = '%s账户转交待处理' % name
        for f in kb_db.list_folders():
            if f['name'] == folder_name and f.get('owner_id') == admin_id and f.get('parent_id') in (None, '', 0, '0'):
                return f['id']
        folder, err = kb_db.create_folder(folder_name, None, admin_id)
        if err:
            return None
        return folder['id']

    def _transfer_personal_on_disable(self, user_id, admin):
        """A4：账号被禁用时，自动把其个人库（master.sqlite）转交 admin 并同步到团队库。

        - 在 admin 个人库建「xxx账户转交待处理」文件夹，拷贝该用户全部个人文档进去（保留物理文件）。
        - 同时在团队库建同名文件夹，把每份文档上传到团队库（复制模式）。
        """
        user_id = int(user_id)
        try:
            kbconn = kb_db._conn()
            try:
                emp = kbconn.execute(
                    "SELECT display_name,username FROM employees WHERE id=?", (user_id,)).fetchone()
            finally:
                kbconn.close()
            if not emp:
                return
            name = emp['display_name'] or emp['username']
            admin_id = admin['id']
            admin_name = admin.get('display_name') or admin.get('username')
            with _MASTER_LOCK:
                conn = _master_db_conn()
                if conn is None:
                    log('[A4] 主库不可用，跳过个人库转交'); return
                try:
                    self._ensure_owner_cols(conn)
                    self._ensure_parent_col(conn)
                    self._ensure_deleted_col(conn)
                    now = datetime.datetime.now().isoformat()
                    folder_name = '%s账户转交待处理' % name
                    existing = conn.execute(
                        "SELECT folder_id FROM knowledge_folders WHERE owner_id=? AND name=? "
                        "AND (deleted_at IS NULL OR deleted_at='') LIMIT 1",
                        (admin_id, folder_name)).fetchone()
                    if existing:
                        transfer_folder = existing['folder_id']
                    else:
                        transfer_folder = uuid.uuid4().hex
                        conn.execute(
                            "INSERT INTO knowledge_folders "
                            "(folder_id,name,sort_order,created_at,updated_at,parent_id,owner_id,owner_name) "
                            "VALUES (?,?,?,?,?,?,?,?)",
                            (transfer_folder, folder_name, 0, now, now, None, admin_id, admin_name))
                    cols = {c[1] for c in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()}
                    docs = conn.execute(
                        "SELECT document_id,folder_id,file_name FROM knowledge_documents "
                        "WHERE owner_id=? AND (is_deleted IS NULL OR is_deleted=0) "
                        "AND (deleted_at IS NULL OR deleted_at='')",
                        (user_id,)).fetchall()
                    team_folder = self._ensure_team_transfer_folder(name, admin_id)
                    copied = 0
                    for d in docs:
                        src_dir = self._personal_doc_dir(d['folder_id'], d['document_id'])
                        fp = None
                        if os.path.isdir(src_dir):
                            cands = []
                            for root, _dd, files in os.walk(src_dir):
                                for f in files:
                                    cands.append(os.path.join(root, f))
                            for c in cands:
                                if os.path.basename(c) == d['file_name']:
                                    fp = c
                                    break
                            if fp is None and cands:
                                fp = cands[0]
                        new_doc_id = uuid.uuid4().hex
                        doc_dir_rel = 'folders/%s/documents/%s' % (transfer_folder, new_doc_id)
                        fields = {
                            'document_id': new_doc_id, 'folder_id': transfer_folder,
                            'file_name': d['file_name'], 'document_dir': doc_dir_rel,
                            'source_path': '%s/%s' % (doc_dir_rel, d['file_name']),
                            'markdown_path': '', 'status': 'success', 'progress': 100,
                            'message': '离职转交', 'created_at': now, 'updated_at': now,
                            'owner_id': admin_id, 'owner_name': admin_name,
                        }
                        if 'uploaded_by' in cols:
                            fields['uploaded_by'] = admin_name
                        if 'is_deleted' in cols:
                            fields['is_deleted'] = 0
                        keys = [k for k in fields if k in cols]
                        conn.execute(
                            "INSERT INTO knowledge_documents (%s) VALUES (%s)" % (
                                ','.join(keys), ','.join('?' * len(keys))),
                            tuple(fields[k] for k in keys))
                        copied += 1
                        dst_dir = os.path.join(MASTER_KB, doc_dir_rel)
                        os.makedirs(dst_dir, exist_ok=True)
                        data = b''
                        if fp and os.path.isfile(fp):
                            shutil.copy2(fp, os.path.join(dst_dir, d['file_name']))
                            with open(fp, 'rb') as fh:
                                data = fh.read()
                        # 同步到团队库（复制模式）
                        try:
                            if data and team_folder:
                                import mimetypes as _mt
                                mime = _mt.guess_type(d['file_name'] or '')[0] or 'application/octet-stream'
                                kb_db.upload_document(team_folder, admin_id, d['file_name'], d['file_name'], mime, data)
                        except Exception as e:
                            log('[A4] 同步到团队失败 doc=%s: %s' % (d['document_id'], e))
                    conn.commit()
                    log('[A4] 账号 %s 个人库已转交 admin（%d 篇，文件夹=%s）' % (name, copied, folder_name))
                finally:
                    conn.close()
        except Exception as e:
            log('[A4] 转交异常: %s' % e)

    def _sync_team_to_master(self, doc_id, employee=None):
        """团队库文档 → 当前用户的个人库（写入 master.sqlite '团队库导入' 文件夹）。返回 (ok, new_doc_id, folder_id, file_name, msg)。"""
        team_doc = kb_db.get_document(doc_id)
        if not team_doc:
            return False, None, None, None, '文档不存在'
        owner_id = employee['id'] if employee else None
        owner_name = (employee.get('display_name') or employee.get('username')) if employee else 'system'
        fname = team_doc.get('file_name') or team_doc.get('title') or 'file'
        with _MASTER_LOCK:
            conn = _master_db_conn()
            if conn is None:
                return False, None, None, fname, '个人库尚未初始化（先在桌面端同步一次）'
            try:
                self._ensure_owner_cols(conn)
                # 确保 knowledge_folders 有 deleted_at/deleted_by 列（向后兼容）
                fcols = {c[1] for c in conn.execute("PRAGMA table_info(knowledge_folders)").fetchall()}
                for col in ('deleted_at', 'deleted_by', 'parent_id'):
                    if col not in fcols:
                        conn.execute("ALTER TABLE knowledge_folders ADD COLUMN %s TEXT" % col)
                        fcols.add(col)
                now = datetime.datetime.now().isoformat()
                new_doc_id = 'team-%s-%s' % (team_doc['id'], owner_id)
                folder_id = 'team-import-%s' % owner_id
                if conn.execute("SELECT 1 FROM knowledge_documents WHERE document_id=?",
                                (new_doc_id,)).fetchone():
                    return True, new_doc_id, folder_id, fname, '已存在，跳过'
                # 创建/恢复「团队库导入」文件夹；若之前被软删则复活，避免文档无家可归。
                existing_folder = conn.execute(
                    "SELECT deleted_at FROM knowledge_folders WHERE folder_id=?", (folder_id,)).fetchone()
                if existing_folder is None:
                    conn.execute(
                        "INSERT INTO knowledge_folders "
                        "(folder_id, name, sort_order, created_at, updated_at, owner_id, owner_name, parent_id, deleted_at) "
                        "VALUES (?,?,?,?,?,?,?,?,?)",
                        (folder_id, '团队库导入', 9999, now, now, owner_id, owner_name, None, None))
                elif existing_folder['deleted_at']:
                    conn.execute(
                        "UPDATE knowledge_folders SET deleted_at=NULL, deleted_by=NULL, updated_at=? WHERE folder_id=?",
                        (now, folder_id))
                cols = {c[1] for c in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()}
                doc_dir_rel = 'folders/%s/documents/%s' % (folder_id, new_doc_id)
                # 团队库 knowledge_documents 没有 status/progress 字段，状态以 kb_analysis 为准
                team_analysis = kb_db.get_team_analysis(doc_id)
                analysis_status = (team_analysis.get('status') or '').lower() if team_analysis else ''
                analysis_payload = team_analysis.get('payload') if team_analysis else None
                if analysis_status == 'success' and analysis_payload:
                    team_status = 'success'
                    team_progress = 100
                    team_message = '来自团队库（已分析）'
                else:
                    team_status = 'pending'
                    team_progress = 0
                    team_message = '等待处理'
                team_item_count = team_analysis.get('item_count') if team_analysis else 0
                team_block_count = team_analysis.get('block_count') if team_analysis else 0
                # payload 中若存在候选条目/已过滤块，也同步计数（兼容旧 payload 结构）
                payload_candidate_count = 0
                payload_filtered_count = 0
                if analysis_payload:
                    payload_candidate_count = len(analysis_payload.get('candidate_items') or []) or len(analysis_payload.get('candidates') or [])
                    payload_filtered_count = len(analysis_payload.get('filtered_blocks') or [])
                fields = {
                    'document_id': new_doc_id, 'folder_id': folder_id, 'file_name': fname,
                    'title': team_doc.get('title') or fname,
                    'document_dir': doc_dir_rel, 'source_path': '%s/%s' % (doc_dir_rel, fname),
                    'markdown_path': team_doc.get('markdown_path') or '',
                    'status': team_status, 'progress': team_progress,
                    'message': team_message, 'created_at': now, 'updated_at': now,
                    'owner_id': owner_id, 'owner_name': owner_name,
                    'item_count': team_item_count or 0,
                    'block_count': team_block_count or 0,
                    'candidate_item_count': payload_candidate_count,
                    'filtered_block_count': payload_filtered_count,
                }
                # 个人库全文检索/RAG 需要 content_text；优先复制团队库已抽取的正文，没有则现场抽取。
                if 'content_text' in cols:
                    content_text = team_doc.get('content_text') or ''
                    if not content_text:
                        src = os.path.join(kb_db.KB_DATA_DIR, team_doc['file_path'])
                        if os.path.isfile(src):
                            try:
                                with open(src, 'rb') as fh:
                                    content_text = kb_db._extract_text_for_search(
                                        fh.read(), team_doc.get('file_name') or fname,
                                        team_doc.get('mime_type') or 'application/octet-stream')
                            except Exception:
                                content_text = ''
                    fields['content_text'] = content_text
                if 'uploaded_by' in cols:
                    fields['uploaded_by'] = owner_name
                if 'uploaded_at' in cols:
                    fields['uploaded_at'] = now
                if 'is_deleted' in cols:
                    fields['is_deleted'] = 0
                keys = [k for k in fields if k in cols]
                conn.execute(
                    "INSERT INTO knowledge_documents (%s) VALUES (%s)" % (
                        ','.join(keys), ','.join('?' * len(keys))),
                    tuple(fields[k] for k in keys))
                conn.commit()
                src = os.path.join(kb_db.KB_DATA_DIR, team_doc['file_path'])
                dst_dir = os.path.join(MASTER_KB, doc_dir_rel)
                os.makedirs(dst_dir, exist_ok=True)
                if os.path.isfile(src):
                    shutil.copy2(src, os.path.join(dst_dir, fname))
            except Exception as e:
                return False, None, None, fname, str(e)
            finally:
                conn.close()
        # 团队库若已有分析结果，直接复制到个人库 kb_analysis（避免重跑 Worker）。
        # 在 master 连接关闭后单独进行，_master_save_analysis 内部自持锁。
        try:
            team_analysis = kb_db.get_team_analysis(doc_id)
            if team_analysis and team_analysis.get('payload'):
                _master_save_analysis(
                    new_doc_id, team_analysis.get('status') or 'success',
                    team_analysis.get('payload'),
                    item_count=team_analysis.get('item_count'),
                    block_count=team_analysis.get('block_count'),
                    analyzer_id=owner_id, analyzer_name=owner_name)
        except Exception:
            pass
        return True, new_doc_id, folder_id, fname, '同步成功'

    def _import_personal_doc_to_team(self, master_doc_id, team_folder_id, employee):
        """个人库（master.sqlite）文档 → 团队库（kb.sqlite），只能导入自己的文档。返回 (团队文档id, 文件名, 错误, analysis_synced)。"""
        conn = _master_db_conn()
        if conn is None:
            return None, None, '个人库不可用', False
        try:
            self._ensure_owner_cols(conn)
            row = conn.execute(
                "SELECT document_id, folder_id, file_name, owner_id FROM knowledge_documents WHERE document_id=?",
                (str(master_doc_id),)).fetchone()
        finally:
            conn.close()
        if not row:
            return None, None, '个人库文档不存在', False
        doc_id, folder_id, file_name, owner_id = row
        if employee and employee.get('role') != 'admin' and owner_id is not None and owner_id != employee['id']:
            return None, file_name, '只能导入自己个人库中的文档', False
        base = self._personal_doc_dir(folder_id, doc_id)
        fp = None
        if os.path.isdir(base):
            cands = []
            for root, _dirs, files in os.walk(base):
                for f in files:
                    cands.append(os.path.join(root, f))
            for c in cands:
                if os.path.basename(c) == file_name:
                    fp = c
                    break
            if fp is None and cands:
                fp = cands[0]
        if fp is None or not os.path.isfile(fp):
            return None, file_name, '个人库物理文件缺失', False
        with open(fp, 'rb') as fh:
            data = fh.read()
        import mimetypes
        mime = mimetypes.guess_type(file_name or fp)[0] or 'application/octet-stream'
        title = file_name or os.path.basename(fp)
        # B3 命名规则：个人库文档若来源于团队库（document_id 形如 team-<id>-<user>），
        # 则视为「个人修改后的版本」，同步回团队库时文件名追加「（账户名 YYYY年MM月DD日HH时修改版）」，
        # 括号加在扩展名前；原团队文件保留，新增带后缀副本（复制模式）。
        if re.match(r'^team-\d+-\d+$', str(master_doc_id)):
            acct = ((employee.get('display_name') or employee.get('username')) if employee else None) or '用户'
            ts = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y年%m月%d日%H时')
            base_name, ext = os.path.splitext(title)
            title = '%s（%s %s修改版）%s' % (base_name, acct, ts, ext)
        doc, err = kb_db.upload_document(team_folder_id, employee['id'] if employee else owner_id, title, title, mime, data)
        if err:
            return None, title, err, False
        # 个人库若已有分析结果，直接复制到团队库 kb_analysis（避免重跑 Worker）。
        analysis_synced = False
        try:
            analysis = _master_get_analysis(master_doc_id)
            if analysis and analysis.get('payload'):
                kb_db.save_team_analysis(
                    doc['id'],
                    analysis.get('status') or 'success',
                    analysis.get('payload'),
                    item_count=analysis.get('item_count'),
                    block_count=analysis.get('block_count'),
                    analyzer_id=employee['id'] if employee else owner_id,
                    analyzer_name=(employee.get('display_name') or employee.get('username')) if employee else None)
                analysis_synced = True
        except Exception:
            pass  # 分析同步失败不阻塞文档导入
        return doc['id'], title, None, analysis_synced

    def _auto_team_folder_name(self, folder_ids, employee):
        """自动同步到团队库时，根据选中的个人库文件夹名决定新建文件夹名；无文件夹则用工号时间戳。"""
        for pfid in (folder_ids or []):
            conn = _master_db_conn()
            try:
                row = conn.execute(
                    "SELECT name FROM knowledge_folders WHERE folder_id=?", (str(pfid),)).fetchone()
            finally:
                conn.close()
            if row and row[0]:
                return row[0]
        ts = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d-%H%M')
        return '个人库导入-%s' % ts

    # ---- P0-2 文件夹级同步辅助（扁平递归：整文件夹内容同步到目标库） ----
    def _collect_master_descendant_folders(self, root_id):
        """返回个人库中以 root_id 为根的全部后代文件夹 folder_id（含自身）。"""
        result, stack = [], [str(root_id)]
        while stack:
            fid = stack.pop()
            result.append(fid)
            conn = _master_db_conn()
            try:
                subs = conn.execute("SELECT folder_id FROM knowledge_folders WHERE parent_id=?", (fid,)).fetchall()
            finally:
                conn.close()
            for s in subs:
                stack.append(s[0])
        return result

    def _collect_master_folder_docs(self, root_id, out):
        """递归收集个人库某文件夹（含子文件夹）下所有文档 document_id（扁平）。"""
        fids = self._collect_master_descendant_folders(root_id)
        conn = _master_db_conn()
        try:
            ph = ','.join('?' * len(fids)) or '?'
            rows = conn.execute(
                "SELECT document_id FROM knowledge_documents WHERE folder_id IN (%s)" % ph, fids).fetchall()
        finally:
            conn.close()
        for r in rows:
            out.append(r[0])

    def _collect_team_folder_docs(self, root_id, out):
        """递归收集团队库某文件夹（含子文件夹）下所有文档 id（扁平，内存遍历 folders 树）。"""
        docs = kb_db.list_documents(root_id)
        for d in docs:
            out.append(d['id'])
        all_folders = kb_db.list_folders()
        children = [f for f in all_folders if f.get('parent_id') == root_id]
        for c in children:
            self._collect_team_folder_docs(c['id'], out)

    def _kb_GET(self):
        path = urlparse(self.path).path
        if path in ('/', '/admin'):
            return self._serve_html('kb_admin.html')
        if path == '/register':
            return self._serve_html('kb_register.html')
        if path == '/api/health':
            return self._send(200, {'status': 'ok'})
        # ==================== 全局模型配置（GET，管理员）====================
        if path == '/api/admin/model-config':
            admin = self._is_admin()
            if not admin:
                return self._send(403, {'error': '需要管理员权限'})
            cfg = kb_db.get_model_config()
            return self._send(200, {
                'success': True,
                'data': {
                    'base_url': cfg['base_url'],
                    'analysis_model': cfg['analysis_model'],
                    'qa_model': cfg['qa_model'],
                    'embedding_model': cfg['embedding_model'],
                    'has_api_key': bool(cfg['api_key']),
                    'updated_at': cfg['updated_at'],
                },
            })
        # ==================== 代理 sub2api 模型列表（GET）====================
        if path == '/api/models':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            cfg = kb_db.get_model_config()
            if not cfg.get('api_key'):
                return self._send(200, {'success': True, 'models': [], 'message': '服务端尚未配置 API Key'})
            try:
                import urllib.request
                req = urllib.request.Request(cfg['base_url'].rstrip('/') + '/models',
                                             headers={'Authorization': 'Bearer ' + cfg['api_key']})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    body = json.loads(resp.read().decode('utf-8'))
                models = []
                raw = body.get('data') if isinstance(body, dict) else None
                if isinstance(raw, list):
                    for m in raw:
                        if isinstance(m, dict) and m.get('id'):
                            models.append(m['id'])
                return self._send(200, {'success': True, 'models': models})
            except Exception as e:
                return self._send(200, {'success': False, 'models': [], 'message': '拉取模型列表失败: %s' % str(e)})
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
        # ==================== 分析进度（代理 Worker 状态，供客户端轮询）====================
        m = re.match(r'^/api/documents/(\d+)/analysis/status$', path)
        if m:
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            try:
                import urllib.request
                req = urllib.request.Request(WORKER_URL + '/status/' + m.group(1))
                with urllib.request.urlopen(req, timeout=5) as resp:
                    st = json.loads(resp.read().decode('utf-8'))
                return self._send(200, st)
            except Exception as e:
                # Worker 不可达时回退：直接看服务器是否已有分析结果
                analysis = kb_db.get_team_analysis(m.group(1))
                if analysis:
                    return self._send(200, {'documentId': m.group(1), 'status': 'success', 'progress': 100, 'message': '分析完成'})
                return self._send(200, {'documentId': m.group(1), 'status': 'unknown', 'progress': 0, 'message': 'Worker 不可达: %s' % e})

        # ==================== 团队库分析共享：读取分析结果 ====================
        m = re.match(r'^/api/documents/(\d+)/analysis$', path)
        if m:
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            doc = kb_db.get_document(m.group(1))
            if not doc:
                return self._send(404, {'error': '文档不存在'})
            analysis = kb_db.get_team_analysis(m.group(1))
            if not analysis:
                return self._send(404, {'error': '暂无共享分析结果', 'analyzed': False})
            return self._send(200, {'success': True, 'analyzed': True, 'data': analysis})

        # ==================== 个人库分析状态（代理 Worker，owner 隔离）====================
        m = re.match(r'^/api/personal/documents/([0-9a-fA-F]+|team-\d+-\d+)/analysis/status$', path)
        if m:
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            doc, err = self._personal_doc_owner_check(m.group(1), employee)
            if err is not None:
                return
            try:
                import urllib.request
                req = urllib.request.Request(WORKER_URL + '/status/' + m.group(1))
                with urllib.request.urlopen(req, timeout=5) as resp:
                    st = json.loads(resp.read().decode('utf-8'))
                return self._send(200, st)
            except Exception as e:
                analysis = _master_get_analysis(m.group(1))
                if analysis:
                    return self._send(200, {'documentId': m.group(1), 'status': 'success', 'progress': 100, 'message': '分析完成'})
                return self._send(200, {'documentId': m.group(1), 'status': 'unknown', 'progress': 0, 'message': 'Worker 不可达: %s' % e})

        # ==================== 个人库分析读取（owner 隔离）====================
        m = re.match(r'^/api/personal/documents/([0-9a-fA-F]+|team-\d+-\d+)/analysis$', path)
        if m:
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            doc, err = self._personal_doc_owner_check(m.group(1), employee)
            if err is not None:
                return
            analysis = _master_get_analysis(m.group(1))
            if not analysis:
                return self._send(404, {'error': '暂无分析结果', 'analyzed': False})
            return self._send(200, {'success': True, 'analyzed': True, 'data': analysis})

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
                mode = self._query_param('mode') or 'name'
                if mode == 'content':
                    return self._send(200, {'data': kb_db.search_documents_fulltext(kw)})
                return self._send(200, {'data': kb_db.search_documents(kw)})
            if not folder:
                return self._send(200, {'data': kb_db.list_documents(None)})
            return self._send(200, {'data': kb_db.list_documents(folder)})
        # ==================== /api/personal/* （需登录会话，个人库/主库）====================
        if path == '/api/personal/folders':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            return self._send(200, {'data': self._personal_folders(employee)})
        if path == '/api/personal/documents':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            folder = self._query_param('folder')
            kw = self._query_param('q')
            if kw:
                mode = self._query_param('mode') or 'name'
                return self._send(200, {'data': self._personal_search(kw, mode, employee)})
            return self._send(200, {'data': self._personal_documents(folder, employee)})
        # ==================== /api/kb-qa/* 知识库问答召回 ====================
        if path == '/api/kb-qa/team':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            kw = (self._query_param('q') or '').strip()
            if not kw:
                return self._send(400, {'error': '缺少 q 参数'})
            try:
                limit = min(int(self._query_param('limit') or '3'), 10)
            except ValueError:
                limit = 3
            docs = self._qa_team_retrieve(kw, limit=limit)
            return self._send(200, {'success': True, 'data': docs})
        if path == '/api/kb-qa/personal':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            kw = (self._query_param('q') or '').strip()
            if not kw:
                return self._send(400, {'error': '缺少 q 参数'})
            try:
                limit = min(int(self._query_param('limit') or '3'), 10)
            except ValueError:
                limit = 3
            docs = self._qa_personal_retrieve(kw, employee, limit=limit)
            return self._send(200, {'success': True, 'data': docs})
        if path == '/api/kb-qa/corpus':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            docs = self._qa_team_corpus()
            return self._send(200, {'success': True, 'data': docs})
        if path == '/api/personal/kb-qa/corpus':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            docs = self._qa_personal_corpus(employee)
            return self._send(200, {'success': True, 'data': docs})
        if path.startswith('/api/personal/documents/') and path.endswith('/file'):
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            doc_id_str = path.split('/documents/')[1].split('/')[0]
            return self._send_personal_file(doc_id_str, employee)
        if path == '/api/trash':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            kb_db.purge_expired_trash(24)
            return self._send(200, {'data': kb_db.list_trash()})
        if path == '/api/personal/trash':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            self._personal_purge_expired_trash(24)
            return self._send(200, {'data': self._personal_trash(employee)})
        if path == '/api/documents/export':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            ids = [x for x in (self._query_param('ids') or '').split(',') if x.strip()]
            data = self._export_team_zip(ids, employee)
            return self._send_zip(data, 'team_documents.zip')
        if path == '/api/personal/documents/export':
            employee = self._auth()
            if not employee:
                return self._send(401, {'error': '未登录或会话已过期'})
            ids = [x for x in (self._query_param('ids') or '').split(',') if x.strip()]
            data = self._export_personal_zip(ids, employee)
            if data is None:
                return self._send(404, {'error': '主库不可用'})
            return self._send_zip(data, 'personal_documents.zip')
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
            ok, err = kb_db.delete_folder(m.group(1), employee['id'])
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
            ok, err = kb_db.delete_document(m.group(1), employee['id'])
            if not ok:
                return self._send(400, {'error': err})
            try:
                kb_db.delete_team_analysis(m.group(1))
            except Exception:
                pass
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='doc', target_type='document', target_id=m.group(1),
                detail='删除文档: %s' % (doc.get('title') or doc.get('file_name') or m.group(1)),
                ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '文档已删除'})
        m = re.match(r'^/api/personal/folders/([^/]+)$', path)
        if m:
            folder_id = m.group(1)
            ok, err_or_name = self._personal_delete_folder(folder_id, employee)
            if not ok:
                return self._send(400, {'error': err_or_name})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='folder', target_type='personal_folder', target_id=folder_id,
                detail='删除个人文件夹: %s' % err_or_name, ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '文件夹已删除'})
        m = re.match(r'^/api/personal/documents/([^/]+)$', path)
        if m:
            ok, err = self._personal_delete_document(m.group(1), employee)
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='doc', target_type='personal_document', target_id=m.group(1),
                detail='删除个人文档（进回收站）', ip=_client_ip(self))
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
        employee = self._auth()
        if not employee:
            return self._send(401, {'error': '未登录或会话已过期'})
        m = re.match(r'^/api/folders/(\d+)$', path)
        if m:
            folder = kb_db.get_folder(m.group(1))
            if not folder:
                return self._send(404, {'error': '文件夹不存在'})
            if employee['role'] != 'admin' and folder['owner_id'] != employee['id']:
                return self._send(403, {'error': '只能修改自己创建的文件夹'})
            # 重命名优先（传了 name）
            if data.get('name'):
                ok, err = kb_db.rename_folder(m.group(1), data.get('name'))
                if not ok:
                    return self._send(400, {'error': err})
                audit_event(
                    account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                    role=employee.get('role'), action='folder', target_type='folder', target_id=m.group(1),
                    detail='重命名文件夹: %s' % data.get('name'), ip=_client_ip(self))
                return self._send(200, {'success': True, 'message': '文件夹已重命名'})
            # 否则按移动处理（parent_id 可为 None/0 = 根目录）
            new_parent_id = data.get('parent_id')
            ok, err = kb_db.move_folder(m.group(1), new_parent_id)
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='folder', target_type='folder', target_id=m.group(1),
                detail='移动文件夹到: %s' % (new_parent_id or '根目录'), ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '文件夹已移动'})
        m = re.match(r'^/api/documents/(\d+)$', path)
        if m:
            doc = kb_db.get_document(m.group(1))
            if not doc:
                return self._send(404, {'error': '文档不存在'})
            if employee['role'] != 'admin' and doc.get('owner_id') is not None and doc['owner_id'] != employee['id']:
                return self._send(403, {'error': '只能移动自己上传的文档'})
            new_folder_id = data.get('folder_id')
            if new_folder_id in (None, '', 0, '0'):
                return self._send(400, {'error': '缺少目标文件夹'})
            ok, err = kb_db.move_document(m.group(1), new_folder_id)
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='doc', target_type='document', target_id=m.group(1),
                detail='移动文档到文件夹: %s' % new_folder_id, ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '文档已移动'})
        m = re.match(r'^/api/personal/documents/([^/]+)$', path)
        if m:
            doc_id = m.group(1)
            new_folder_id = data.get('folder_id')
            if new_folder_id in (None, '', 0, '0'):
                return self._send(400, {'error': '缺少目标文件夹'})
            ok, err = self._personal_move_document(doc_id, new_folder_id, employee)
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='doc', target_type='personal_document', target_id=doc_id,
                detail='移动个人文档到文件夹: %s' % new_folder_id, ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '文档已移动'})
        m = re.match(r'^/api/personal/folders/([^/]+)$', path)
        if m:
            folder_id = m.group(1)
            # 重命名优先（传了 name）
            if data.get('name'):
                ok, err = self._personal_rename_folder(folder_id, data.get('name'), employee)
                if not ok:
                    return self._send(400, {'error': err})
                audit_event(
                    account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                    role=employee.get('role'), action='folder', target_type='personal_folder', target_id=folder_id,
                    detail='重命名个人文件夹: %s' % data.get('name'), ip=_client_ip(self))
                return self._send(200, {'success': True, 'message': '文件夹已重命名'})
            # 否则按移动处理
            new_parent_id = data.get('parent_id')
            ok, err = self._personal_move_folder(folder_id, new_parent_id, employee)
            if not ok:
                return self._send(400, {'error': err})
            audit_event(
                account_id=employee['id'], account_name=employee.get('display_name') or employee['username'],
                role=employee.get('role'), action='folder', target_type='personal_folder', target_id=folder_id,
                detail='移动个人文件夹到: %s' % (new_parent_id or '根目录'), ip=_client_ip(self))
            return self._send(200, {'success': True, 'message': '文件夹已移动'})
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
            target_user_id = m.group(1)
            ok, err = kb_db.update_employee(target_user_id, data)
            if not ok:
                return self._send(400, {'error': err})
            # A4：账号被禁用时，自动把其个人库转交 admin 并同步到团队库
            if data.get('status') == 'disabled':
                try:
                    self._transfer_personal_on_disable(target_user_id, admin)
                except Exception as e:
                    log('[A4] 个人库转交失败: %s' % e)
            audit_event(
                account_id=admin['id'], account_name=admin.get('display_name') or admin['username'],
                role='admin', action='admin', target_type='employee', target_id=target_user_id,
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
    import time
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(MASTER_ZIP), exist_ok=True)
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    log('yibiao-combined single-port starting on :%d (sync=/sync/*, kb=/)' % PORT)
    srv = ThreadingHTTPServer(('', PORT), CombinedHandler)

    def _purge_loop():
        while True:
            try:
                kb_db.purge_expired_trash(24)
            except Exception:
                pass
            try:
                CombinedHandler._personal_purge_expired_trash(CombinedHandler, 24)
            except Exception:
                pass
            time.sleep(3600)

    threading.Thread(target=_purge_loop, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()
