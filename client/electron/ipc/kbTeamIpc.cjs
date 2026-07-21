const { ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 方案 D 中央知识库服务器团队库通道（文件夹/文档 CRUD）。
function registerKbTeamIpc({ kbTeamService, kbAuthService }) {
  // 获取整棵树（文件夹 + 文档）
  ipcMain.handle('kb-team:get-tree', async () => {
    try {
      if (!kbAuthService.isLoggedIn()) {
        return { success: false, error: '未登录团队库', needLogin: true };
      }
      const tree = await kbTeamService.getTree();
      return { success: true, data: tree };
    } catch (error) {
      return { success: false, error: error?.message || '获取团队库失败' };
    }
  });

  // 创建文件夹
  ipcMain.handle('kb-team:create-folder', async (_event, name, parentId) => {
    try {
      if (!kbAuthService.isLoggedIn()) {
        return { success: false, error: '未登录团队库', needLogin: true };
      }
      const folder = await kbTeamService.createFolder(name, parentId);
      return { success: true, data: folder };
    } catch (error) {
      return { success: false, error: error?.message || '创建文件夹失败' };
    }
  });

  // 删除文件夹（级联删子文件夹 + 文档）
  ipcMain.handle('kb-team:delete-folder', async (_event, folderId) => {
    try {
      if (!kbAuthService.isLoggedIn()) {
        return { success: false, error: '未登录团队库', needLogin: true };
      }
      const result = await kbTeamService.deleteFolder(folderId);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error?.message || '删除文件夹失败' };
    }
  });

  // 删除文档
  ipcMain.handle('kb-team:delete-document', async (_event, documentId) => {
    try {
      if (!kbAuthService.isLoggedIn()) {
        return { success: false, error: '未登录团队库', needLogin: true };
      }
      const result = await kbTeamService.deleteDocument(documentId);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error?.message || '删除文档失败' };
    }
  });

  // 上传文档：弹文件选择对话框 → 上传到服务器
  ipcMain.handle('kb-team:upload-document', async (_event, folderId) => {
    try {
      if (!kbAuthService.isLoggedIn()) {
        return { success: false, error: '未登录团队库', needLogin: true };
      }
      const result = await dialog.showOpenDialog({
        title: '选择要上传的文档',
        filters: [
          { name: '文档', extensions: ['doc', 'docx', 'pdf', 'txt', 'md'] },
          { name: '所有文件', extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const uploaded = [];
      const errors = [];
      for (const filePath of result.filePaths) {
        try {
          const originalName = path.basename(filePath);
          const doc = await kbTeamService.uploadDocument(filePath, originalName, folderId);
          uploaded.push(doc);
        } catch (error) {
          errors.push({ file: path.basename(filePath), error: error?.message || '上传失败' });
        }
      }
      return { success: true, uploaded, errors };
    } catch (error) {
      return { success: false, error: error?.message || '上传文档失败' };
    }
  });

  // 下载文档到临时目录（供本地分析管道使用）
  ipcMain.handle('kb-team:download-document', async (_event, documentId, originalName) => {
    try {
      if (!kbAuthService.isLoggedIn()) {
        return { success: false, error: '未登录团队库', needLogin: true };
      }
      const tempDir = path.join(os.tmpdir(), 'yibiao-kb-cache');
      const safeName = (originalName || `document-${documentId}`).replace(/[<>:"/\\|?*]/g, '_');
      const destPath = path.join(tempDir, `${documentId}_${safeName}`);
      await kbTeamService.downloadDocument(documentId, destPath);
      return { success: true, data: { localPath: destPath } };
    } catch (error) {
      return { success: false, error: error?.message || '下载文档失败' };
    }
  });
}

module.exports = { registerKbTeamIpc };
