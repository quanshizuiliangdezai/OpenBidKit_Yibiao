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
      const { folders, documents } = await personalService.getTree();
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
      return { success: true, data: { localPath: resolved } };
    } catch (err) {
      return { error: err.message || '下载文档失败' };
    }
  });

  // 搜索文档（全局，C5 name / content 双模式）
  ipcMain.handle('kb-personal:search', async (_event, keyword, mode) => {
    try {
      const docs = await personalService.searchDocuments(keyword, mode);
      return { success: true, data: docs };
    } catch (err) {
      return { error: err.message || '搜索文档失败' };
    }
  });

  // 知识库问答召回（带 content_text 片段）
  ipcMain.handle('kb-personal:qa-retrieve', async (_event, keyword, limit) => {
    try {
      console.log('[kb-personal:qa-retrieve] keyword=%s limit=%s', keyword, limit);
      const docs = await personalService.qaRetrieve(keyword, limit);
      console.log('[kb-personal:qa-retrieve] returned %d docs for keyword=%s', docs?.length || 0, keyword);
      return { success: true, data: docs };
    } catch (err) {
      console.error('[kb-personal:qa-retrieve] failed:', err);
      return { success: false, error: err.message || '召回失败' };
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

  // 删除文件夹
  ipcMain.handle('kb-personal:delete-folder', async (_event, folderId) => {
    try {
      const result = await personalService.deleteFolder(folderId);
      return { success: true, data: result };
    } catch (err) {
      return { error: err.message || '删除文件夹失败' };
    }
  });

  // 删除文档（进回收站）
  ipcMain.handle('kb-personal:delete-document', async (_event, documentId) => {
    try {
      const result = await personalService.deleteDocument(documentId);
      return { success: true, data: result };
    } catch (err) {
      return { error: err.message || '删除文档失败' };
    }
  });

  // 移动文件夹
  ipcMain.handle('kb-personal:move-folder', async (_event, folderId, parentId) => {
    try {
      const result = await personalService.moveFolder(folderId, parentId);
      return { success: true, data: result };
    } catch (err) {
      return { error: err.message || '移动文件夹失败' };
    }
  });

  // C1 重命名文件夹
  ipcMain.handle('kb-personal:rename-folder', async (_event, folderId, name) => {
    try {
      const result = await personalService.renameFolder(folderId, name);
      return { success: true, data: result };
    } catch (err) {
      return { error: err.message || '重命名文件夹失败' };
    }
  });

  // E2 移动文档
  ipcMain.handle('kb-personal:move-document', async (_event, documentId, folderId) => {
    try {
      const result = await personalService.moveDocument(documentId, folderId);
      return { success: true, data: result };
    } catch (err) {
      return { error: err.message || '移动文档失败' };
    }
  });

  // C3 回收站列表
  ipcMain.handle('kb-personal:list-trash', async () => {
    try {
      const data = await personalService.listTrash();
      return { success: true, data };
    } catch (err) {
      return { error: err.message || '获取回收站失败' };
    }
  });

  // C3 从回收站恢复
  ipcMain.handle('kb-personal:restore-from-trash', async (_event, type, id) => {
    try {
      const data = await personalService.restoreFromTrash(type, id);
      return { success: true, data };
    } catch (err) {
      return { error: err.message || '恢复失败' };
    }
  });

  // C2 批量导出 zip（弹保存对话框）
  ipcMain.handle('kb-personal:export-zip', async (event, ids) => {
    try {
      if (!Array.isArray(ids) || ids.length === 0) return { success: false, error: '未选择文档' };
      const win = BrowserWindow.fromWebContents(event.sender);
      const os = require('node:os');
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: '导出为 ZIP',
        defaultPath: path.join(os.homedir(), 'personal_documents.zip'),
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      });
      if (canceled || !filePath) return { success: false, canceled: true };
      await personalService.exportZip(ids, filePath);
      return { success: true, data: { localPath: filePath } };
    } catch (err) {
      return { error: err.message || '导出失败' };
    }
  });

  // 个人库 → 团队库（folderIds 整文件夹同步透传）
  ipcMain.handle('kb-personal:import-to-team', async (_event, documentIds, targetTeamFolderId, folderIds) => {
    try {
      const result = await personalService.importToTeam(documentIds, targetTeamFolderId, folderIds || []);
      return { success: true, data: result };
    } catch (err) {
      return { error: err.message || '同步到团队库失败' };
    }
  });

  // 团队库 → 个人库（folderIds 整文件夹同步透传）
  ipcMain.handle('kb-personal:import-from-team', async (_event, documentIds, folderIds) => {
    try {
      const result = await personalService.importFromTeam(documentIds, folderIds || []);
      return { success: true, data: result };
    } catch (err) {
      return { error: err.message || '同步到个人库失败' };
    }
  });
}

module.exports = { registerKbPersonalIpc };
