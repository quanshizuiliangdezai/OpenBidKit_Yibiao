const { ipcMain } = require('electron');

// 方案 D 中央知识库服务器登录通道。
function registerKbAuthIpc({ kbAuthService }) {
  ipcMain.handle('kb-auth:login', async (_event, payload) => {
    try {
      const result = await kbAuthService.login(payload || {});
      return result;
    } catch (error) {
      return { success: false, error: error?.message || '登录失败' };
    }
  });

  ipcMain.handle('kb-auth:logout', () => {
    kbAuthService.logout();
    return { success: true };
  });

  ipcMain.handle('kb-auth:get-status', () => kbAuthService.getStatus());

  ipcMain.handle('kb-auth:me', async () => {
    const employee = await kbAuthService.getMe();
    return employee;
  });

  ipcMain.handle('kb-auth:set-server', (_event, serverUrl) => {
    kbAuthService.setServerUrl(serverUrl);
    return { success: true, serverUrl: kbAuthService.getServerUrl() };
  });
}

module.exports = { registerKbAuthIpc };
