#!/usr/bin/env python3
# 方案 D 认证服务（仅账号密码 + 自助注册 + 管理员审核）
# 标准库 http.server，多线程，HTTP/1.1；与现有 server.py 风格一致，无第三方依赖。
import http.server
import socketserver
import json
import os
import datetime
from urllib.parse import urlparse
import kb_db

PORT = int(os.environ.get('KB_PORT', '15004'))
DB_PATH = os.environ.get('KB_DB', '/toubiao/yibiao-kb-server/kb.sqlite')
kb_db.DB_PATH = DB_PATH
kb_db.init_db()


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

    def _serve_html(self):
        html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kb_admin.html')
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

    # ---------- 路由 ----------
    def do_OPTIONS(self):
        self._send(204)

    def do_POST(self):
        path = urlparse(self.path).path
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

        return self._send(404, {'error': '接口不存在'})

    def do_GET(self):
        path = urlparse(self.path).path

        if path in ('/', '/admin'):
            return self._serve_html()

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

        return self._send(404, {'error': '接口不存在'})

    def log_message(self, fmt, *args):
        pass


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    srv = ThreadedHTTPServer(('0.0.0.0', PORT), Handler)
    print('kb-auth server listening on :%d' % PORT, flush=True)
    srv.serve_forever()
