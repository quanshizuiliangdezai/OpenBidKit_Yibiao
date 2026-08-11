const { ipcMain } = require('electron');
const { createKbVault } = require('../services/kbVault.cjs');

// 本地知识库 Obsidian Vault 镜像通道：导出到 Vault（单向）/ 从 Vault 写回本地库（手动确认）。
function registerKbVaultIpc({ app, knowledgeBaseStore }) {
  const vault = createKbVault({ app, store: knowledgeBaseStore });

  ipcMain.handle('kb-vault:get-path', async () => {
    try {
      return { success: true, data: { vaultPath: vault.getVaultPath() } };
    } catch (error) {
      return { success: false, error: error?.message || '获取 Vault 路径失败' };
    }
  });

  ipcMain.handle('kb-vault:set-path', async (_event, p) => {
    try {
      return { success: true, data: { vaultPath: vault.setVaultPath(p) } };
    } catch (error) {
      return { success: false, error: error?.message || '设置 Vault 路径失败' };
    }
  });

  ipcMain.handle('kb-vault:export', async () => {
    try {
      return vault.exportToVault();
    } catch (error) {
      return { success: false, error: error?.message || '导出到 Vault 失败' };
    }
  });

  ipcMain.handle('kb-vault:import', async () => {
    try {
      return vault.importFromVault();
    } catch (error) {
      return { success: false, error: error?.message || '从 Vault 写回失败' };
    }
  });
}

module.exports = { registerKbVaultIpc };
