# Yibiao 服务器部署总览

本目录存档 **59.49.48.147** 上各后端服务的部署配置，便于灾难恢复与新人接手。
所有敏感凭证均已去敏（占位符 `CHANGE_ME_*` / `__填写...__`），**绝不入库**。

## 一键部署（仅服务器端）

### 方案 A：直接在服务器上执行（无需本地开发机 / 无需 SSH 密码）

适合服务器上紧急修复后快速上线，或没有本地 paramiko 环境时使用。

```bash
# 方式 1：curl 下载脚本后执行
cd /opt
curl -fsSL -o one-click-server.sh \
  https://raw.githubusercontent.com/quanshizuiliangdezai/OpenBidKit_Yibiao/deploy/deploy/one-click-server.sh
bash one-click-server.sh

# 方式 2：先克隆 deploy 分支再执行
sudo -i
git clone -b deploy --depth 1 https://github.com/quanshizuiliangdezai/OpenBidKit_Yibiao.git /opt/yibiao-deploy
bash /opt/yibiao-deploy/deploy/one-click-server.sh
```

脚本会：① 拉取/更新 `deploy` 分支到 `/opt/yibiao-deploy`；② 备份当前运行文件；
③ 部署 `server.py`/`kb_db.py`/`kb_audit.html` → `/toubiao/yibiao-combined`；
④ 部署 `sync-server/merge.py` → `/toubiao/yibiao-sync/merge.py`（权限 755）；⑤ 语法检查并重启 `yibiao-combined`；⑥ 健康检查。

### 方案 B：从本地开发机推送到服务器

`deploy-server.sh` 从 Windows/Linux/macOS 本地通过 SSH 上传并部署，不碰任何前端/桌面端代码。

```bash
cd deploy
export KB_DEPLOY_SSH_PASSWORD='服务器 root 密码'
bash deploy-server.sh
```

脚本会：① 备份并上传 `server/yibiao-combined/{kb_db.py,server.py,kb_audit.html}` → `/toubiao/yibiao-combined`；
② 部署 `sync-server/merge.py` → `/toubiao/yibiao-sync/merge.py`（跨设备同步用）；③ 重启 `yibiao-combined` 并做健康检查。

## 服务器与端口

| 端口 | 服务 | systemd 单元 | 运行用户 | 说明 |
|------|------|--------------|----------|------|
| 5566 | SSH（真实 Linux） | — | root | 22 端口是 H3C 路由器网关，非 Linux SSH |
| 15001 | 卫星设备系统前端 | `weixing-15001.service` | bhkj | 静态 `http.server` |
| 15003 | BidChecker Pro | `bidchecker.service` | bhkj | 投标检查工具 |
| 15004 | yibiao-combined（知识库+同步） | `yibiao-combined.service` | root | 单端口：知识库 `/api/*` + 同步 `/sync/*` |
| 15005 | sub2api AI 网关 | `sub2api.service` | sub2api | PostgreSQL + Redis |
| 127.0.0.1:18080 | sub2api→agnes 改名代理 | `sub2api-image-proxy.service` | root | 图片模型改名 |

## 目录布局（服务器 /toubiao）

```
/toubiao/
├── yibiao-combined/      # KB 服务运行目录（部署目标，源码来自仓库 server/yibiao-combined）
├── yibiao-kb-server/     # 团队知识库 SQLite（kb.sqlite）+ knowledge-base 数据
├── yibiao-master/        # 个人知识库主库 master.sqlite + master.zip + knowledge-base
└── yibiao-incoming/      # 桌面客户端同步上传的临时落盘目录
```

## 部署方式

### 1. 知识库服务（yibiao-combined）+ 同步合并脚本
**推荐使用一键部署脚本**（见上方「一键部署」）。
若需单独部署该服务，源码 = 仓库 `server/yibiao-combined/` + `sync-server/merge.py`，脚本：
```bash
cd deploy
export KB_DEPLOY_SSH_PASSWORD='服务器 root 密码'
python3 scripts/deploy_kb_server.py
```
脚本会：备份 → 上传 `kb_db.py`/`server.py`/`kb_audit.html` → `/toubiao/yibiao-combined`；
同步部署 `sync-server/merge.py` → `/toubiao/yibiao-sync/merge.py`（权限 755）；
清缓存 → 语法校验 → 重启 `yibiao-combined` → 健康检查。

### 2. 其他服务
- `weixing-15001`、`bidchecker`、`sub2api` 的源码不在本仓库（分别在 `/project/02-weixingxitong`、`/home/bhkj/03-BidChecker-Pro`、`/opt/sub2api`），
  这里只存档其 systemd 单元文件（`systemd/`），重启命令：`systemctl restart <unit>`。

## 环境变量（yibiao-combined.service）

完整变量清单见 `env.example` 与 `systemd/yibiao-combined.service`。
生产建议用 `EnvironmentFile=/etc/yibiao/deploy.env`（权限 600）替代内联明文。

## 去敏说明

- `systemd/yibiao-combined.service` 中 `KB_ADMIN_PASSWORD`、`YIBIAO_SYNC_TOKEN` 为占位符。
- 部署脚本 `scripts/deploy_kb_server.py`、`deploy-server.sh` 不含任何密码，全部走环境变量。
- 切勿把 `.env`、含真实值的 `systemd` 文件提交到本仓库。
