const { ipcMain } = require('electron');

// 团队知识库同步通道：push（上传本机到团队库）/ pull（拉取团队库到本机）
function registerSyncIpc({ syncService }) {
  ipcMain.handle('sync:push', () => syncService.pushToTeam());
  ipcMain.handle('sync:pull', () => syncService.pullFromTeam());
}

module.exports = { registerSyncIpc };
