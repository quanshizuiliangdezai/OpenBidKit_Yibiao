const { ipcMain } = require('electron');

function registerAgentIpc({ agentService, mainWindow }) {
  ipcMain.handle('agent:run', async (_event, payload) => agentService.runTask(payload));
  ipcMain.handle('agent:self-check', async (_event, runtimeId) => agentService.selfCheck(runtimeId));
  ipcMain.handle('agent:export-self-check-report', async (_event, payload) => agentService.exportSelfCheckReport(payload));
  ipcMain.handle('agent:get-status', async () => agentService.getStatus());
  ipcMain.handle('agent:restart', async (_event, reason) => agentService.restart(reason || 'manual'));
  ipcMain.handle('agent:list-runtimes', async () => agentService.listRuntimes());

  agentService.onStatus?.((status) => {
    if (!mainWindow?.isDestroyed?.() && !mainWindow?.webContents?.isDestroyed?.()) {
      mainWindow.webContents.send('agent:status', status);
    }
  });
}

module.exports = {
  registerAgentIpc,
};
