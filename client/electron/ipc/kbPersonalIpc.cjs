/**
 * kbPersonalIpc.cjs —— 个人知识库 IPC handlers
 *
 * 个人库通过 HTTP /api/personal/* 端点读取服务器上的 master.sqlite，
 * 仅支持只读浏览和下载。
 */

const path = require('node:path');
const fs = require('node:fs');

function registerKbPersonalIpc({ kbAuthService, app }) {
  const { ipcMain } = require('electron');
  const personalService = require('../services/kbPersonalService.cjs')({ app });

  // 获取文件夹树
  ipcMain.handle('kb-personal:get-tree', async () => {
    try {
      const folders = await personalService.listFolders();
      return { success: true, data: folders };
    } catch (err) {
      return { error: err.message || '获取个人库文件夹失败' };
    }
  });

  // 列出文件夹
  ipcMain.handle('kb-personal:list-folders', async () => {
    try {
      const folders = await personalService.listFolders();
      return { success: true, data: folders };
    } catch (err) {
      return { error: err.message || '获取文件夹列表失败' };
    }
  });

  // 列出文档
  ipcMain.handle('kb-personal:list-documents', async (_event, folderId) => {
    try {
      const docs = await personalService.listDocuments(folderId);
      return { success: true, data: docs };
    } catch (err) {
      return { error: err.message || '获取文档列表失败' };
    }
  });

  // 下载文档
  ipcMain.handle('kb-personal:download-document', async (event, documentId, destPath) => {
    try {
      if (!destPath) {
        destPath = path.join(app.getPath('userData'), 'personal-doc-cache', String(documentId));
      }
      const resolved = await personalService.downloadDocument(documentId, destPath);
      return { success: true, data: resolved };
    } catch (err) {
      return { error: err.message || '下载文档失败' };
    }
  });

  // 搜索文档（全局）
  ipcMain.handle('kb-personal:search', async (_event, keyword) => {
    try {
      const docs = await personalService.searchDocuments(keyword);
      return { success: true, data: docs };
    } catch (err) {
      return { error: err.message || '搜索文档失败' };
    }
  });
}

module.exports = { registerKbPersonalIpc };
