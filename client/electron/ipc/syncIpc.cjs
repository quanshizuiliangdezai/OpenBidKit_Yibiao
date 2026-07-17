const { ipcMain } = require('electron');

// 团队知识库同步通道：push（上传本机到团队库）/ pull（拉取团队库到本机）
// 另含自动同步守护的状态查询/开关/手动触发接口。
function registerSyncIpc({ syncService }) {
  ipcMain.handle('sync:push', () => syncService.pushToTeam());
  ipcMain.handle('sync:pull', () => syncService.pullFromTeam());
  ipcMain.handle('sync:get-auto-status', () => syncService.getAutoStatus());
  ipcMain.handle('sync:set-auto-enabled', (_event, enabled) => syncService.setAutoEnabled(enabled));
  ipcMain.handle('sync:auto-run-now', () => syncService.runAutoSyncNow());
}

module.exports = { registerSyncIpc };
