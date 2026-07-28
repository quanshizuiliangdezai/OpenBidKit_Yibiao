#!/usr/bin/env bash
# =============================================================================
# deploy-server.sh —— 一键部署【服务器后端】到 59.49.48.147
# =============================================================================
# 说明：本脚本只部署服务器端（标讯/知识库后端），不碰任何前端/桌面端代码。
#       它把仓库里的后端源码同步到服务器并重启 systemd 服务。
#
# 前置：
#   1) 已安装 Python 3 + paramiko（Windows：用本仓库的 managed runtime 跑）
#   2) 已配置环境变量（见 deploy/env.example）：
#        KB_DEPLOY_SSH_PASSWORD  服务器 root 密码（必填）
#        KB_DEPLOY_HOST          默认 59.49.48.147
#        KB_DEPLOY_PORT          默认 5566（真实 Linux SSH，22 是路由器）
#        KB_DEPLOY_USER          默认 root
#
# 用法（Git Bash / Linux / macOS）：
#   cd deploy
#   export KB_DEPLOY_SSH_PASSWORD='你的密码'
#   bash deploy-server.sh
#
# 用法（Windows PowerShell）：
#   cd deploy
#   $env:KB_DEPLOY_SSH_PASSWORD='你的密码'
#   bash deploy-server.sh
#
# 本脚本会依次部署：
#   ① yibiao-combined 服务（server.py + kb_db.py + kb_audit.html）→ /toubiao/yibiao-combined
#   ② 同步合并脚本 merge.py → /toubiao/yibiao-sync/merge.py（跨设备同步用，已并入 deploy_kb_server.py）
#   ③ sub2api-image-proxy（proxy.py）→ /opt/sub2api-image-proxy/proxy.py（Agnes 生图改名代理）
#   ④ 重启相关服务并做健康检查
#
# 注意：所有密码从环境变量读取，绝不写死在脚本里。
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# Git Bash 下把 /c/... 转成 Windows 路径，避免 python 收到 C:\c\... 双重转义
if command -v cygpath &>/dev/null; then
  SCRIPT_DIR="$(cygpath -w "$SCRIPT_DIR")"
  REPO_ROOT="$(cygpath -w "$REPO_ROOT")"
fi
# 传给 Python 的路径统一用正斜杠（Windows 上 Python 也能识别），避免 \U 被当 unicode 转义
SCRIPT_DIR_PY="${SCRIPT_DIR//\\//}"
REPO_ROOT_PY="${REPO_ROOT//\\//}"

echo "==> 部署服务器后端（仅服务器端，不含前端）"
echo "==> 仓库根: ${REPO_ROOT_PY}"

# 1. 校验必备环境变量
if [[ -z "${KB_DEPLOY_SSH_PASSWORD:-}" ]]; then
  echo "错误：缺少环境变量 KB_DEPLOY_SSH_PASSWORD，请先 export 后再运行。" >&2
  exit 1
fi

# 2. 确定 python 解释器：优先用带 paramiko 的 python
#    （Windows Git Bash 的 python3 常指向 Windows Store 占位符，无 paramiko，故需检测）
detect_python() {
  # 用户可显式指定：export PYTHON_BIN=/path/to/python
  if [[ -n "${PYTHON_BIN:-}" ]]; then
    "$PYTHON_BIN" -c "import paramiko" &>/dev/null && { echo "$PYTHON_BIN"; return 0; }
    echo "错误：PYTHON_BIN 指定的解释器无 paramiko 模块" >&2
    return 1
  fi
  # 候选解释器（managed runtime 优先，兼容大多数环境）
  local candidates=(
    "C:/Users/13370/.workbuddy/binaries/python/versions/3.13.12/python.exe"
    "python3"
    "python"
  )
  for cand in "${candidates[@]}"; do
    if command -v "$cand" &>/dev/null || [[ -x "$cand" ]]; then
      if "$cand" -c "import paramiko" &>/dev/null; then
        echo "$cand"
        return 0
      fi
    fi
  done
  echo "错误：未找到带 paramiko 的 python，请先 pip install paramiko 或设置 PYTHON_BIN。" >&2
  return 1
}
PY="$(detect_python)" || exit 1
echo "==> 使用 python: ${PY}"

# 3. 部署 yibiao-combined 服务 + merge.py（复用 deploy_kb_server.py）
echo "==> [1/3] 部署 yibiao-combined 服务与 merge.py（端口 15004）"
"${PY}" "${SCRIPT_DIR_PY}/scripts/deploy_kb_server.py"

# 4. 部署 sub2api-image-proxy
echo "==> [2/3] 部署 sub2api-image-proxy（Agnes 生图改名代理）"
"${PY}" "${SCRIPT_DIR_PY}/scripts/deploy_image_proxy.py"

# 5. 健康检查
echo "==> [3/3] 健康检查"
sleep 3
"${PY}" - <<PYEOF
import os, sys, paramiko
sys.path.insert(0, "${SCRIPT_DIR_PY}/scripts")
import deploy_kb_server as d
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(d.HOST, port=d.PORT, username=d.USER, password=d.PASSWORD, timeout=15,
            allow_agent=False, look_for_keys=False,
            disabled_algorithms={'kex': ['curve25519-sha256','curve25519-sha256@libssh.org','curve448-sha512','ecdh-sha2-nistp521','ecdh-sha2-nistp384','diffie-hellman-group-exchange-sha256','diffie-hellman-group-exchange-sha1'],
                                 'ciphers': ['aes256-gcm@openssh.com','chacha20-poly1305@openssh.com','aes256-ctr','aes192-ctr','aes128-ctr']})
_, out, _ = ssh.exec_command('systemctl is-active yibiao-combined')
print("yibiao-combined 状态:", out.read().decode().strip())
_, out, _ = ssh.exec_command('systemctl is-active sub2api-image-proxy')
print("sub2api-image-proxy 状态:", out.read().decode().strip())
_, out, _ = ssh.exec_command('curl -s -m 5 http://127.0.0.1:15004/api/health')
print("health:", out.read().decode().strip())
ssh.close()
PYEOF

echo "==> 部署完成。仅服务器端已更新，前端/桌面端不受影响。"
