# OpenBidKit 自有更新渠道 —— 搭建与维护指南

## 目标
让同事软件的"自动更新"从 **咱们自己的仓库** 拉包，而不是官方的 `FB208/OpenBidKit_Yibiao`。
这样上游出新版时，流水线会自动合并 + 打包 + 发版，**上游新功能照样进来，咱们的同步/账户功能永远在**，且你零操作。

## 已经改好的代码（本机源码已就绪）
- `client/electron/services/updateService.cjs`：更新渠道指向 `quanshizuiliangdezai/OpenBidKit_Yibiao`
- `client/package.json`：`publish` 也指向咱们仓库
- `client/electron/services/syncService.cjs`：Samba 的 IP/密码改为读 `sync-config.local.json`（已 gitignore，**仓库零密**）
- `.github/workflows/auto-build.yml`：自动合并上游 + 打包 + 发版
- `.gitignore`：排除 node_modules / release / 含密配置 / 本地保险库

## 你这边要做的（一次性）
> 需要 GitHub 账号 `quanshizuiliangdezai` 的操作权限。

1. **建私有仓库**
   在 GitHub 新建私有仓库 `OpenBidKit_Yibiao`（私有！别公开）。

2. **推源码**
   本机没装 git，用 VPS 中转把本目录推上去（或你本地有 git 直接推）：
   ```bash
   # 在 OpenBidKit_Yibiao 目录内
   git init
   git remote add origin https://github.com/quanshizuiliangdezai/OpenBidKit_Yibiao.git
   git add -A
   git commit -m "init: our fork with sync/account mods"
   git push -u origin main
   ```
   （本机无法直连 GitHub 时，走 VPS SSH 中转：`git config http.proxy socks5://<vps>:端口` 或 SSH ProxyCommand）

3. **配置密钥（Settings → Secrets and variables → Actions）**
   - `YIBIAO_SYNC_CONFIG`：值为下面这段 JSON（即本机 `client/electron/sync-config.local.json` 的内容）：
     ```json
     {"host":"59.49.48.147","share":"toubiao","user":"yibiao","pass":"Yibiao@2026","incoming":"incoming","masterZip":"master.zip"}
     ```
   - `GITHUB_TOKEN` 不需要额外建，仓库自带的 `GITHUB_TOKEN` 已够用（已配 `permissions: contents: write`）。

4. **首次发版**
   - 进仓库 Actions → `Auto Build & Publish` → `Run workflow` → 勾选 `force_build` → Run。
   - 跑完会在咱们仓库 Releases 生成 `Yibiao-x.x.x-win-x64.exe` 等。把这个安装包发给同事装一次（覆盖原官方版）。

## 之后全自动
- 上游 `FB208` 发新版 → 流水线每 6 小时自动检测到 → 合并 + 打包 + 发版到咱们渠道。
- 同事软件打开时会自动从咱们渠道更新，拿到"上游新功能 + 咱们 mods"。
- **冲突兜底**：若上游改了咱们也改过的文件导致合并冲突，流水线会暂停并标红失败，**不会发坏包**；此时你手动解决冲突后重跑即可（极少发生）。

## 回退 / 安全
- 若想临时停更新：仓库 Settings → Actions 可禁用该 workflow；或把某次发版设为草稿。
- 官方"Cloudflare"渠道仍指向上游原版，**同事不要在设置里选 Cloudflare**，保持默认 GitHub（即咱们渠道）即可。
- 内部 IP/密码只在 `sync-config.local.json`（本机/CI 密钥）里，源码与仓库均无明文。
