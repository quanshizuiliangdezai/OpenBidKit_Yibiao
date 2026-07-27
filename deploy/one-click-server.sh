#!/usr/bin/env bash
# =============================================================================
# one-click-server.sh —— 服务器端一键更新 yibiao 后端
# =============================================================================
# 说明：本脚本直接运行在服务器上（root），自动拉取 deploy 分支并部署后端。
#       无需 SSH/密码，无需本地开发机，适合服务器上紧急修复后快速上线。
#
# 前置：
#   1) 服务器已安装 git、python3、systemd
#   2) 当前用户有权限操作 /toubiao 目录与 systemctl
#   3) 网络可访问 github.com（或已配置镜像）
#
# 用法（在服务器上执行）：
#   cd /opt
#   curl -fsSL -o one-click-server.sh \
#     https://raw.githubusercontent.com/quanshizuiliangdezai/OpenBidKit_Yibiao/deploy/deploy/one-click-server.sh
#   bash one-click-server.sh
#
# 或克隆后执行：
#   git clone -b deploy https://github.com/quanshizuiliangdezai/OpenBidKit_Yibiao.git /opt/yibiao-deploy
#   bash /opt/yibiao-deploy/deploy/one-click-server.sh
#
# 本脚本会：
#   ① 拉取/更新 deploy 分支到 /opt/yibiao-deploy
#   ② 备份当前运行的 yibiao-combined 与 merge.py
#   ③ 部署 server.py / kb_db.py / kb_audit.html → /toubiao/yibiao-combined
#   ④ 部署 merge.py → /toubiao/yibiao-sync/merge.py（权限 755）
#   ⑤ 语法检查并重启 yibiao-combined
#   ⑥ 健康检查
# =============================================================================

set -euo pipefail

REPO_URL="${YIBIAO_REPO_URL:-https://github.com/quanshizuiliangdezai/OpenBidKit_Yibiao.git}"
DEPLOY_BRANCH="${YIBIAO_DEPLOY_BRANCH:-deploy}"
DEPLOY_DIR="${YIBIAO_DEPLOY_DIR:-/opt/yibiao-deploy}"

SERVER_SRC="${DEPLOY_DIR}/server/yibiao-combined"
SYNC_SRC="${DEPLOY_DIR}/sync-server"

SERVER_DEST="${YIBIAO_SERVER_DEST:-/toubiao/yibiao-combined}"
SYNC_DEST="${YIBIAO_SYNC_DEST:-/toubiao/yibiao-sync}"

echo "==> [0/6] 拉取/更新部署分支 ${DEPLOY_BRANCH}"
if [[ -d "${DEPLOY_DIR}/.git" ]]; then
    cd "${DEPLOY_DIR}"
    git fetch origin "${DEPLOY_BRANCH}"
    git checkout "${DEPLOY_BRANCH}"
    git reset --hard "origin/${DEPLOY_BRANCH}"
else
    git clone -b "${DEPLOY_BRANCH}" --depth 1 "${REPO_URL}" "${DEPLOY_DIR}"
fi

echo "==> [1/6] 创建目标目录"
mkdir -p "${SERVER_DEST}" "${SYNC_DEST}"

echo "==> [2/6] 备份当前运行文件"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/tmp/yibiao-server-backup-${TS}"
mkdir -p "${BACKUP_DIR}"
for f in server.py kb_db.py kb_audit.html; do
    src="${SERVER_DEST}/${f}"
    if [[ -f "${src}" ]]; then
        cp "${src}" "${BACKUP_DIR}/${f}.bak"
        echo "[backup] ${src} -> ${BACKUP_DIR}/${f}.bak"
    fi
done
if [[ -f "${SYNC_DEST}/merge.py" ]]; then
    cp "${SYNC_DEST}/merge.py" "${BACKUP_DIR}/merge.py.bak"
    echo "[backup] ${SYNC_DEST}/merge.py -> ${BACKUP_DIR}/merge.py.bak"
fi

echo "==> [3/6] 部署 yibiao-combined 服务文件"
for f in server.py kb_db.py kb_audit.html; do
    src="${SERVER_SRC}/${f}"
    if [[ -f "${src}" ]]; then
        cp "${src}" "${SERVER_DEST}/${f}"
        echo "[deploy] ${src} -> ${SERVER_DEST}/${f}"
    else
        echo "[skip] ${src} 不存在"
    fi
done

echo "==> [4/6] 部署跨设备同步合并脚本 merge.py"
if [[ -f "${SYNC_SRC}/merge.py" ]]; then
    cp "${SYNC_SRC}/merge.py" "${SYNC_DEST}/merge.py"
    chmod 755 "${SYNC_DEST}/merge.py"
    echo "[deploy] ${SYNC_SRC}/merge.py -> ${SYNC_DEST}/merge.py"
else
    echo "[skip] ${SYNC_SRC}/merge.py 不存在"
fi

echo "==> [5/6] 语法检查并清理缓存"
find "${SERVER_DEST}" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
find "${SERVER_DEST}" -name "*.pyc" -delete 2>/dev/null || true
python3 - <<'PYEOF'
import ast, sys
for f in ("/toubiao/yibiao-combined/server.py", "/toubiao/yibiao-combined/kb_db.py",
          "/toubiao/yibiao-sync/merge.py"):
    try:
        ast.parse(open(f, encoding="utf-8").read())
        print(f, "OK")
    except SyntaxError as e:
        print(f, "FAIL", e)
        sys.exit(1)
PYEOF

echo "==> [6/6] 重启服务并健康检查"
systemctl restart yibiao-combined

for i in {1..10}; do
    sleep 1
    if systemctl is-active yibiao-combined | grep -q active; then
        echo "[status] yibiao-combined active (after ${i}s)"
        break
    fi
    if [[ $i -eq 10 ]]; then
        echo "[status] WARN yibiao-combined 未进入 active 状态，请检查 journalctl -u yibiao-combined"
    fi
done

HEALTH=$(curl -s -m 5 http://127.0.0.1:15004/api/health || true)
echo "[health] ${HEALTH}"

echo "==> 服务器端一键部署完成：$(date +%H:%M:%S)"
echo "==> 备份目录：${BACKUP_DIR}"
