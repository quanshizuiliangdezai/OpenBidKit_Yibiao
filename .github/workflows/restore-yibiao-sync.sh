#!/bin/bash
# restore-yibiao-sync.sh —— 在合并上游后自动恢复我们的 HTTP 同步功能
# 原理：通过 git checkout 从旧 commit 恢复被上游删除的文件，然后 git add 提交

set -e

echo "🔧 Restoring yibiao sync features..."

# 恢复被上游删除的同步功能文件
# 这些文件来自 commit 6c199d6（HTTP 同步功能完整版本）
git show 6c199d6:client/electron/services/syncService.cjs > client/electron/services/syncService.cjs 2>/dev/null || echo "⚠️ syncService.cjs 恢复失败"
git show 6c199d6:client/electron/ipc/syncIpc.cjs > client/electron/ipc/syncIpc.cjs 2>/dev/null || echo "⚠️ syncIpc.cjs 恢复失败"
git show 6c199d6:client/src/features/settings/pages/AccountPage.tsx > client/src/features/settings/pages/AccountPage.tsx 2>/dev/null || echo "⚠️ AccountPage.tsx 恢复失败"

# 恢复 preload.cjs 中的同步通道（上游删除了部分）
git show 6c199d6:client/electron/preload.cjs > client/electron/preload.cjs 2>/dev/null || echo "⚠️ preload.cjs 恢复失败"

# 恢复 ipc.ts 中的同步类型
git show 6c199d6:client/src/shared/types/ipc.ts > client/src/shared/types/ipc.ts 2>/dev/null || echo "⚠️ ipc.ts 恢复失败"

# 恢复 config.ts 中的同步配置
git show 6c199d6:client/src/shared/types/config.ts > client/src/shared/types/config.ts 2>/dev/null || echo "⚠️ config.ts 恢复失败"

# 恢复 navigation.ts 中的同步路由
git show 6c199d6:client/src/shared/types/navigation.ts > client/src/shared/types/navigation.ts 2>/dev/null || echo "⚠️ navigation.ts 恢复失败"

# 恢复 AppRouter.tsx 中的同步路由
git show 6c199d6:client/src/app/AppRouter.tsx > client/src/app/AppRouter.tsx 2>/dev/null || echo "⚠️ AppRouter.tsx 恢复失败"

# 恢复 Sidebar.tsx 中的同步菜单项
git show 6c199d6:client/src/components/Sidebar.tsx > client/src/components/Sidebar.tsx 2>/dev/null || echo "⚠️ Sidebar.tsx 恢复失败"

# 恢复 menuConfig.ts 中的同步菜单
git show 6c199d6:client/src/app/menuConfig.ts > client/src/app/menuConfig.ts 2>/dev/null || echo "⚠️ menuConfig.ts 恢复失败"

# 恢复 license 弹窗中的同步配置
git show 6c199d6:client/src/app/LicenseStatusPrompt.tsx > client/src/app/LicenseStatusPrompt.tsx 2>/dev/null || echo "⚠️ LicenseStatusPrompt.tsx 恢复失败"

# 恢复 package.json 中的同步依赖
git show 6c199d6:client/package.json > client/package.json 2>/dev/null || echo "⚠️ package.json 恢复失败"

# 恢复 updateService.cjs 中的同步更新逻辑
git show 6c199d6:client/electron/services/updateService.cjs > client/electron/services/updateService.cjs 2>/dev/null || echo "⚠️ updateService.cjs 恢复失败"

# 恢复 opencodeEnvironment.cjs 中的同步配置
git show 6c199d6:client/electron/services/opencode/opencodeEnvironment.cjs > client/electron/services/opencode/opencodeEnvironment.cjs 2>/dev/null || echo "⚠️ opencodeEnvironment.cjs 恢复失败"

# 恢复 configStore.cjs 中的同步存储
git show 6c199d6:client/electron/services/configStore.cjs > client/electron/services/configStore.cjs 2>/dev/null || echo "⚠️ configStore.cjs 恢复失败"

# 恢复 sign-ignore.cjs 中的同步签名
git show 6c199d6:client/sign-ignore.cjs > client/sign-ignore.cjs 2>/dev/null || echo "⚠️ sign-ignore.cjs 恢复失败"

# 恢复 index.cjs 中的同步 IPC 注册
git show 6c199d6:client/electron/ipc/index.cjs > client/electron/ipc/index.cjs 2>/dev/null || echo "⚠️ index.cjs 恢复失败"

# 恢复 vite-env.d.ts 中的同步类型声明
git show 6c199d6:client/src/vite-env.d.ts > client/src/vite-env.d.ts 2>/dev/null || echo "⚠️ vite-env.d.ts 恢复失败"

echo "✅ Restore complete"
