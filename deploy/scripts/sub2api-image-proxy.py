#!/usr/bin/env python3
# sub2api -> agnes 图片模型改名代理
# sub2api 图片白名单硬编码（只认 gpt-image-*/dall-e-*），把 gpt-image-2 映射成
# agnes-image-2.1-flash 后会在转发前被二次校验拒掉。此代理放在 sub2api 与 agnes 之间：
#   - sub2api 账户 base_url 指向本代理（gpt-image-2 直通，能通过白名单）
#   - 本代理把请求里的 gpt-image-2 等改写成 agnes 真名再转发 agnes
# 文本等非图片请求透明转发，行为与原 base_url 直连 agnes 一致。
#
# 修复记录：
#   2026-07-24 P2a/P2b/P3a 全面审查修复
#   2026-07-28 默认生图模型从 agnes-image-2.0-flash 升级到 agnes-image-2.1-flash
import http.server
import socketserver
import urllib.request
import urllib.error
import json
import os
import time
import logging
from datetime import datetime

UPSTREAM_BASE = "https://apihub.agnes-ai.cn"
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 18080
LOG_PATH = "/var/log/sub2api-image-proxy.log"

# OpenAI 风格图片模型名 -> agnes 真名
# sub2api 图片白名单只认 gpt-image-* / dall-e-*，这里全部映射到当前默认 Agnes 生图模型
IMAGE_RENAME = {
    "gpt-image-2": "agnes-image-2.1-flash",
    "gpt-image-2.1": "agnes-image-2.1-flash",
    "gpt-image-2.0": "agnes-image-2.0-flash",
    "gpt-image-1.5": "agnes-image-2.1-flash",
    "gpt-image-1": "agnes-image-2.1-flash",
    "dall-e-3": "agnes-image-2.1-flash",
}

# agnes (经 LiteLLM) 不支持的 OpenAI 图片生成参数，代理层剔除
IMAGE_DROP_PARAMS = {"response_format", "quality", "style"}

# sub2api 内部路径（计费/配额等），不应转发给 agnes，本地直接应答
INTERNAL_PREFIXES = ("/v1/sub2api/",)

UPSTREAM_TIMEOUT = 180          # agnes 生图偶发 60-120s，保持充裕
MAX_RETRY = 4                   # 5xx 重试次数（含首次共 3 次内）
BACKOFF_BASE = 3.0              # 指数退避基数（秒）：第1次重试 2s，第2次 4s

os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("proxy")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        content_type = self.headers.get("Content-Type", "")
        is_json = "application/json" in content_type
        data = None
        if is_json and body:
            try:
                data = json.loads(body.decode("utf-8"))
            except Exception:
                data = None
        original_model = None
        body_modified = False
        if isinstance(data, dict) and isinstance(data.get("model"), str):
            original_model = data["model"]
            if original_model in IMAGE_RENAME:
                data["model"] = IMAGE_RENAME[original_model]
                body_modified = True

        # agnes 经 LiteLLM 时不认 response_format/quality/style 等 OpenAI 参数，
        # 在图片生成路径上剔除，避免 400/422
        if self.path == "/v1/images/generations" and isinstance(data, dict):
            dropped = [k for k in IMAGE_DROP_PARAMS if k in data]
            for k in dropped:
                del data[k]
            if dropped:
                log.info("dropped unsupported image params: %s", ",".join(dropped))
                body_modified = True

        if body_modified:
            body = json.dumps(data).encode("utf-8")

        # P2a: sub2api 内部路径（计费/配额等）本地应答，不转发 agnes
        if any(self.path.startswith(p) for p in INTERNAL_PREFIXES):
            log.info("intercept internal path=%s (no upstream)", self.path)
            self._send_json(200, {"ok": True})
            return

        target = UPSTREAM_BASE + self.path
        headers = {}
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in ("host", "connection", "transfer-encoding", "content-length"):
                continue
            headers[k] = v
        method = self.command
        # agnes 上游偶发 503 Service busy，对 5xx 做有限重试（指数退避）提升成功率
        resp_body = None
        status = None
        resp_headers = None
        last_exc = None
        for attempt in range(MAX_RETRY):
            req = urllib.request.Request(
                target,
                data=body if method != "GET" else None,
                headers=headers,
                method=method,
            )
            try:
                with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
                    resp_body = resp.read()
                    status = resp.status
                    resp_headers = resp.getheaders()
                # agnes 图片路径偶发 422 Invalid request（与 5xx 同为上游瞬时错误，重试常成功）
                retryable = (status and 500 <= status < 600) or (
                    self.path == "/v1/images/generations" and status == 422
                )
                if retryable:
                    reason = "5xx" if (status and 500 <= status < 600) else "agnes-422"
                    log.warning("upstream %s attempt=%d status=%s, retrying", reason, attempt + 1, status)
                    last_exc = "upstream %s %s" % (reason, status)
                    if attempt < MAX_RETRY - 1:
                        time.sleep(BACKOFF_BASE * (2 ** attempt))
                    continue
                break
            except urllib.error.HTTPError as e:
                resp_body = e.read()
                status = e.code
                resp_headers = e.headers.items()
                # agnes 图片路径偶发 422 Invalid request（与 5xx 同为上游瞬时错误，重试常成功）
                retryable = (500 <= status < 600) or (
                    self.path == "/v1/images/generations" and status == 422
                )
                if retryable:
                    reason = "5xx" if 500 <= status < 600 else "agnes-422"
                    log.warning("upstream HTTPError %s attempt=%d status=%s, retrying", reason, attempt + 1, status)
                    last_exc = "upstream %s %s" % (reason, status)
                    if attempt < MAX_RETRY - 1:
                        time.sleep(BACKOFF_BASE * (2 ** attempt))
                    continue
                break
            except Exception as e:
                last_exc = str(e)
                log.warning("upstream error attempt=%d err=%s", attempt + 1, e)
                if attempt < MAX_RETRY - 1:
                    time.sleep(BACKOFF_BASE * (2 ** attempt))
                    continue
                break
        if resp_body is None:
            log.error("upstream failed after %d attempts path=%s err=%s", MAX_RETRY, self.path, last_exc)
            self._send_json(502, {"error": {"message": "proxy upstream error: %s" % last_exc}})
            return
        new_model = data.get("model") if isinstance(data, dict) else None
        # P3a: 日志脱敏，不记录 Authorization 任何片段
        auth_present = "yes" if self.headers.get("Authorization") else "no"
        # 增强：4xx 时记录响应体前 500 字符，便于定位上游具体拒绝原因
        if status and 400 <= status < 500:
            try:
                err_txt = resp_body.decode("utf-8", "replace")[:500]
            except Exception:
                err_txt = str(resp_body[:500])
            log.warning("path=%s model=%s->%s status=%s bytes=%d auth_present=%s upstream_4xx_body=%s",
                        self.path, original_model, new_model, status, len(resp_body), auth_present, err_txt)
        else:
            log.info("path=%s model=%s->%s status=%s bytes=%d auth_present=%s",
                     self.path, original_model, new_model, status, len(resp_body), auth_present)
        self.send_response(status)
        for k, v in resp_headers:
            lk = k.lower()
            if lk in ("transfer-encoding", "connection", "content-length", "keep-alive"):
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(resp_body)))
        self.end_headers()
        self.wfile.write(resp_body)

    def do_POST(self):
        self._proxy()

    def do_GET(self):
        self._proxy()

    def do_PUT(self):
        self._proxy()

    def do_DELETE(self):
        self._proxy()

    def do_PATCH(self):
        self._proxy()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    log.info("starting proxy on %s:%d -> %s (timeout=%ds retry=%d backoff=%.0fs)",
             LISTEN_HOST, LISTEN_PORT, UPSTREAM_BASE, UPSTREAM_TIMEOUT, MAX_RETRY, BACKOFF_BASE)
    Server((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()
