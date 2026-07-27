# 服务器初始化 / 环境搭建手册（59.49.48.147）

从零重建服务器时需要以下步骤。基于 2026-07-27 实际环境采集。

## 1. 系统
- Ubuntu（OpenSSH_9.6p1，systemd）
- 真实 Linux SSH 在 **5566 端口**（22 端口被 H3C Comware 路由器占用，勿混淆）

## 2. 依赖

### Python 3.12（系统自带 /usr/bin/python3）
已装且 KB 服务依赖的包：
```
pip install paramiko==2.12.0 pillow==10.2.0 requests==2.31.0
```
> KB 服务 `yibiao-combined` 基于标准库 `http.server`，**不依赖 Flask**。
> `pillow` 用于图片处理；`paramiko` 仅部署脚本用。

### LibreOffice（文档转 Markdown 必需）
```
apt-get install -y libreoffice
```
实测版本 `LibreOffice 24.2.7.2`。客户端「自动分析」上传 .doc/.docx/.pdf/.xls 时需服务器无需 LibreOffice，
但 **桌面客户端本机**需安装 LibreOffice 才能把 Office/PDF 转 Markdown（见客户端文档）。

### Node.js
- 服务器无需运行 Node；客户端打包在 CI（Windows）完成。
- 版本参考：Node v22.x。

### sub2api 依赖（可选，仅生图链路需要）
- PostgreSQL + Redis（由 `sub2api.service` 的 `Wants=postgresql.service redis.service` 声明）
- 二进制 `/opt/sub2api/sub2api`，配置文件见该目录

## 3. 目录创建
```bash
mkdir -p /toubiao/yibiao-combined \
         /toubiao/yibiao-kb-server/knowledge-base \
         /toubiao/yibiao-master/knowledge-base \
         /toubiao/yibiao-incoming
```

## 4. 安装 systemd 单元
将 `systemd/*.service` 复制到 `/etc/systemd/system/`，去敏占位符改为真实值（或用 `EnvironmentFile`）：
```bash
cp systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now yibiao-combined weixing-15001 bidchecker sub2api-image-proxy sub2api
```
> 注：`bidchecker`/`weixing-15001`/`sub2api` 的源码目录需先就位（见 README 目录布局说明）。

## 5. 防火墙（如需外部访问）
确保 15001/15003/15004/15005 对外放行；5566 仅限可信 IP。

## 6. 验证
```bash
systemctl is-active yibiao-combined bidchecker weixing-15001 sub2api-image-proxy sub2api
curl -s http://127.0.0.1:15004/api/health
```
