/**
 * kbPersonalIpc.cjs —— 个人知识库 IPC handlers
 *
 * 个人库通过 HTTP /api/personal/* 端点访问服务器上的 master.sqlite。
 * 支持浏览、下载、新建文件夹（含子文件夹）、批量上传、双向同步。
 */

const path = require('node:path');
const fs = require('node:fs');

function registerKbPersonalIpc({ kbAuthService, app }) {
  const { ipcMain, dialog, BrowserWindow } = require('electron');
  const personalService = require('../services/kbPersonalService.cjs')({ app, kbAuthService });

  // 获取文件夹树 + 所有文档（loadPersonalTree 使用）
  ipcMain.handle('kb-personal:get-tree', async () => {
    try {
      const [folders, documents] = await Promise.all([
        personalService.listFolders(),
        personalService.listDocuments(null),  // null = 全部文件夹
      ]);
      return { success: true, data: { folders, documents } };
    } catch (err) {
      return { error: err.message || '获取个人库失败' };
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

  // 列出文档（按文件夹过滤）
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

  // 新建文件夹（parentId 可选 = 子文件夹）
  ipcMain.handle('kb-personal:create-folder', async (_event, name, parentId) => {
    try {
      const folder = await personalService.createFolder(name, parentId);
      return { success: true, data: folder };
    } catch (err) {
      return { error: err.message || '新建文件夹失败' };
    }
  });

  // 批量上传文档：弹出多选对话框，逐个上传，返回逐文件结果
  ipcMain.handle('kb-personal:upload-document', async (event, folderId) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: '选择要上传到个人知识库的文档（可多选）',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '文档', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'png', 'jpg', 'jpeg', 'zip'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (canceled || !filePaths.length) return { success: true, data: { uploaded: [], failed: [], canceled: true } };
      const uploaded = [];
      const failed = [];
      for (const fp of filePaths) {
        try {
          const doc = await personalService.uploadDocument(fp, path.basename(fp), folderId);
          uploaded.push({ file: path.basename(fp), doc });
        } catch (err) {
          failed.push({ file: path.basename(fp), error: err.message });
        }
      }
      return { success: true, data: { uploaded, failed, canceled: false } };
    } catch (err) {
      return { error: err.message || '上传文档失败' };
    }
  });

  // 个人库 → 团队库
  ipcMain.handle('kb-personal:import-to-team', async (_event, documentIds, targetTeamFolderId) => {
    try {
      const result = await personalService.importToTeam(documentIds, targetTeamFolderId);
      return { success: true, data: result };
    } catch (err) {
      return { error: err.message || '同步到团队库失败' };
    }
  });

  // 团队库 → 个人库
  ipcMain.handle('kb-personal:import-from-team', async (_event, documentIds) => {
    try {
      const result = await personalService.importFromTeam(documentIds);
      return { success: true, data: result };
    } catch (err) {
      return { error: err.message || '同步到个人库失败' };
    }
  });
}

module.exports = { registerKbPersonalIpc };
