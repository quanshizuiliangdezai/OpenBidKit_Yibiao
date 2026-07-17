#!/usr/bin/env python3
# 稳健版易标同步服务端
# 修复链：
#  1) ETIMEDOUT  -> ufw 未放行 15002（已 ufw allow，不在此文件范围）
#  2) ECONNRESET -> 单线程 HTTP/1.0 不回 100-continue；改为 HTTP/1.1 + 多线程
#  3) Parse Error -> 手动重复发 100-continue；删除，交给基类自动处理
#  4) Bad request syntax ('5a83a') -> Node 客户端用 Transfer-Encoding: chunked 上传，
#     Python http.server 不原生支持 chunked 请求体；此处自行解码 chunked。
import http.server
import socketserver
import json
import os
import datetime
import tempfile
import shutil
import sqlite3
import zipfile
from urllib.parse import parse_qs

PORT = 15002
UPLOAD_DIR = '/toubiao/yibiao-incoming'
MASTER_ZIP = '/toubiao/yibiao-master/master.zip'
AUTH_TOKEN = 'yibiao-sync-2026'
LOG_FILE = '/toubiao/yibiao-http-server/server.log'


def log(msg):
    line = '[{}] {}'.format(datetime.datetime.now().isoformat(timespec='seconds'), msg)
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def _extract_master_sqlite():
    """解压 master.zip 里的 knowledge.sqlite 到临时目录，返回 (sqlite_path, tmp_dir)。调用方负责 shutil.rmtree(tmp_dir)。"""
    tmp = tempfile.mkdtemp(prefix='yibiao-srv-')
    with zipfile.ZipFile(MASTER_ZIP, 'r') as z:
        z.extractall(tmp)
    return os.path.join(tmp, 'knowledge.sqlite'), tmp


def build_manifest():
    """返回主库文档清单（轻量 JSON），供客户端增量 pull 时比对，避免每次下载整个 zip。"""
    if not os.path.exists(MASTER_ZIP):
        return None
    sqlite_path, tmp = _extract_master_sqlite()
    try:
        conn = sqlite3.connect(sqlite_path)
        cols = [c[1] for c in conn.execute('PRAGMA table_info(knowledge_documents)').fetchall()]
        need = ['document_id', 'folder_id', 'is_deleted', 'updated_at']
        have = [c for c in need if c in cols]
        docs = [dict(zip(have, r)) for r in conn.execute(
            'SELECT {} FROM knowledge_documents'.format(','.join(have))
        ).fetchall()]
        conn.close()
        return {'documents': docs, 'generated_at': datetime.datetime.now().isoformat()}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def build_incremental_zip(ids):
    """按需打包：全量 metadata（knowledge.sqlite，体积小）+ 仅指定文档的 kb 源文件（大文件按需）。"""
    sqlite_path, tmp = _extract_master_sqlite()
    out_path = tempfile.mktemp(suffix='.zip')
    try:
        conn = sqlite3.connect(sqlite_path)
        placeholders = ','.join('?' * len(ids))
        rows = conn.execute(
            'SELECT document_id, folder_id FROM knowledge_documents WHERE document_id IN ({})'.format(placeholders),
            ids,
        ).fetchall()
        conn.close()
        kb_root = os.path.join(tmp, 'kb')
        with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
            z.write(sqlite_path, 'knowledge.sqlite')
            for doc_id, folder_id in rows:
                src = os.path.join(kb_root, 'folders', folder_id, 'documents', doc_id)
                if not os.path.isdir(src):
                    continue
                for root, _dirs, files in os.walk(src):
                    for f in files:
                        fp = os.path.join(root, f)
                        arc = os.path.join('kb', os.path.relpath(fp, kb_root))
                        z.write(fp, arc)
        return out_path
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class SyncHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'  # 必须：基类据此自动处理 Expect:100-continue

    def _read_body(self):
        """读取完整请求体，兼容 Content-Length 与 Transfer-Encoding: chunked。"""
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
        # 两者皆无：读到连接关闭为止
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
                # 读掉可能的 trailing headers，直到空行
                while True:
                    tail = self.rfile.readline()
                    if tail in (b'\r\n', b'\n', b''):
                        break
                break
            chunk = self.rfile.read(size)
            self.rfile.read(2)  # 吃掉 chunk 后的 \r\n
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

    def do_GET(self):
        try:
            if not self._check_auth():
                return
            path = self.path.split('?')[0].rstrip('/')
            # 清单接口：返回主库文档清单（轻量），供客户端判断是否真的需要下载
            # 空库时返回 200 + documents: []，让客户端提示"团队库为空"而非"服务器错误"
            if path.endswith('/yibiao/manifest'):
                manifest = build_manifest()
                if manifest is None:
                    self._send_json(200, {'documents': [], 'generated_at': datetime.datetime.now().isoformat()})
                    return
                self._send_json(200, manifest)
                return
            # 下载接口：支持 ?ids= 按需下载（只含指定文档的源文件），无 ids 则返回全量（兼容旧客户端）
            if not os.path.exists(MASTER_ZIP):
                self._send_json(404, {'error': 'master.zip 不存在'})
                return
            ids = None
            if '?' in self.path:
                qs = parse_qs(self.path.split('?', 1)[1])
                ids = qs.get('ids', [None])[0]
            if ids:
                id_list = [x for x in ids.split(',') if x]
                if id_list:
                    tmp_zip = build_incremental_zip(id_list)
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
            with open(MASTER_ZIP, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            log('GET error: %s' % e)
            try:
                self._send_json(500, {'error': 'server error'})
            except Exception:
                pass

    def do_POST(self):
        try:
            if not self._check_auth():
                return
            ctype = self.headers.get('Content-Type', '')
            if 'boundary=' not in ctype:
                self._send_json(400, {'error': '缺少 boundary'})
                return
            boundary = ctype.split('boundary=')[1].split(';')[0].strip().strip('"')
            # 关键：兼容 chunked 与 Content-Length 两种上传方式
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
                self._send_json(200, {'ok': True, 'received': zip_name, 'size': len(zip_content)})
            else:
                self._send_json(400, {'error': '未找到 zip 文件'})
        except Exception as e:
            log('POST error: %s' % e)
            try:
                self._send_json(500, {'error': 'server error: %s' % e})
            except Exception:
                pass

    def log_message(self, fmt, *args):
        log(fmt % args)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(MASTER_ZIP), exist_ok=True)
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    log('Yibiao sync server starting on port %d' % PORT)
    with ThreadingHTTPServer(('', PORT), SyncHandler) as httpd:
        httpd.serve_forever()
