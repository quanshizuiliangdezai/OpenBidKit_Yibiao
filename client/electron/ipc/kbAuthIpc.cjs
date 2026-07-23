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

  ipcMain.handle('kb-auth:register', async (_event, payload) => {
    try {
      return await kbAuthService.register(payload || {});
    } catch (error) {
      return { success: false, error: error?.message || '注册失败' };
    }
  });

  ipcMain.handle('kb-auth:list-employees', async () => {
    try {
      return { success: true, data: await kbAuthService.listEmployees() };
    } catch (error) {
      return { success: false, error: error?.message || '获取员工列表失败' };
    }
  });

  ipcMain.handle('kb-auth:list-pending', async () => {
    try {
      return { success: true, data: await kbAuthService.listPending() };
    } catch (error) {
      return { success: false, error: error?.message || '获取待审核列表失败' };
    }
  });

  ipcMain.handle('kb-auth:review', async (_event, payload) => {
    try {
      return { success: true, ...(await kbAuthService.review(payload?.user_id, payload?.action, payload?.reject_reason)) };
    } catch (error) {
      return { success: false, error: error?.message || '审核失败' };
    }
  });

  ipcMain.handle('kb-auth:reset-password', async (_event, payload) => {
    try {
      return { success: true, ...(await kbAuthService.resetPassword(payload?.user_id, payload?.new_password)) };
    } catch (error) {
      return { success: false, error: error?.message || '重置密码失败' };
    }
  });

  ipcMain.handle('kb-auth:set-status', async (_event, payload) => {
    try {
      return { success: true, ...(await kbAuthService.setEmployeeStatus(payload?.user_id, payload?.status)) };
    } catch (error) {
      return { success: false, error: error?.message || '更新状态失败' };
    }
  });

  ipcMain.handle('kb-auth:delete-employee', async (_event, payload) => {
    try {
      return { success: true, ...(await kbAuthService.deleteEmployee(payload?.user_id)) };
    } catch (error) {
      return { success: false, error: error?.message || '删除账号失败' };
    }
  });

  ipcMain.handle('kb-auth:update-employee', async (_event, payload) => {
    try {
      return { success: true, ...(await kbAuthService.adminUpdateEmployee(payload?.user_id, payload?.fields)) };
    } catch (error) {
      return { success: false, error: error?.message || '更新账号失败' };
    }
  });

  ipcMain.handle('kb-auth:list-permissions', async () => {
    try {
      return { success: true, data: await kbAuthService.listPermissions() };
    } catch (error) {
      return { success: false, error: error?.message || '获取权限目录失败' };
    }
  });

  ipcMain.handle('kb-auth:list-groups', async () => {
    try {
      return { success: true, data: await kbAuthService.listGroups() };
    } catch (error) {
      return { success: false, error: error?.message || '获取权限分组失败' };
    }
  });

  ipcMain.handle('kb-auth:create-group', async (_event, payload) => {
    try {
      return { success: true, data: await kbAuthService.createGroup(payload || {}) };
    } catch (error) {
      return { success: false, error: error?.message || '创建分组失败' };
    }
  });

  ipcMain.handle('kb-auth:delete-group', async (_event, payload) => {
    try {
      return { success: true, ...(await kbAuthService.deleteGroup(payload?.group_id)) };
    } catch (error) {
      return { success: false, error: error?.message || '删除分组失败' };
    }
  });

  ipcMain.handle('kb-auth:set-group-permissions', async (_event, payload) => {
    try {
      return { success: true, ...(await kbAuthService.setGroupPermissions(payload?.group_id, payload?.permissions)) };
    } catch (error) {
      return { success: false, error: error?.message || '保存分组权限失败' };
    }
  });

  ipcMain.handle('kb-auth:add-group-member', async (_event, payload) => {
    try {
      return { success: true, ...(await kbAuthService.addGroupMember(payload?.group_id, payload?.employee_id)) };
    } catch (error) {
      return { success: false, error: error?.message || '加入分组失败' };
    }
  });

  ipcMain.handle('kb-auth:remove-group-member', async (_event, payload) => {
    try {
      return { success: true, ...(await kbAuthService.removeGroupMember(payload?.group_id, payload?.employee_id)) };
    } catch (error) {
      return { success: false, error: error?.message || '移出分组失败' };
    }
  });

  ipcMain.handle('kb-auth:admin-create-employee', async (_event, payload) => {
    try {
      return { success: true, ...(await kbAuthService.adminCreateEmployee(payload || {})) };
    } catch (error) {
      return { success: false, error: error?.message || '创建账号失败' };
    }
  });
}

module.exports = { registerKbAuthIpc };
