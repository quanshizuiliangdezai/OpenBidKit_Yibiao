# 自动化执行记忆：OpenBidKit 上游同步

## 最近一次（2026-07-23 10:33 UTC+8）
- BEHIND=1：上游 FB208 有新提交 `69bc60a`（仅改 README.md / README.en.md）。
- 合并方式：ort 策略，无冲突（无 UU，无 DU）。
- 已推送 main：`27374a9..1af7510`，合并提交 `1af751060832086e39adb8d5ae501016784bcc4e`。
- 标签：`上游更新-20260723-1033`（已推送）。
- 同步后 origin==upstream（BEHIND=0）。
- tsc 检查：退出码 2，报错在 `KnowledgeBasePage.tsx`（`auth` / `KbLoginPanel`）。经排查为本地未提交的 kb-auth WIP（被后台 dev/IDE 进程在 stash 后重新写回工作树），与 README 合并无关；合并提交不触及 client 代码，判定安全后照常推送，并在报告中告警。
- 本地未提交改动已用 `git stash` 安全保留（未 reset --hard，避免丢工作）：
  - stash@{0} 2026-07-23：kb-auth session-expired（ipc/index.cjs、preload.cjs、kbAuthService.cjs、AuthContext.tsx）
  - stash@{1} 2026-07-20：含 sync-upstream.yml / syncService.cjs / server.py（保留，不推送，遵守「不动 sync-upstream.yml」）
- 未触碰 sync-upstream.yml，未改写任何业务代码。

## 注意事项（累积）
- 用户 dev 环境会在 stash 后自动把 WIP 写回工作树，导致每次同步后工作树又变脏；stash 列表会随时间增长，建议用户将 WIP 提交或同步时段暂停后台进程。
- 既有 tsc 错误属用户 kb-auth WIP，非上游合并引入；推送前无法在干净态验证，已告知用户自行 `npm run build` 确认。
