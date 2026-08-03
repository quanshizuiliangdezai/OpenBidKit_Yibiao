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
      console.error('[kb-team:delete-folder] error:', error);
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

  // 服务器侧分析实时状态轮询（上传后前端轮询直到 success/error）
  ipcMain.handle('kb-team:get-analysis-status', async (_event, documentId) => {
    try {
      if (!kbAuthService.isLoggedIn()) {
        return { success: false, error: '未登录团队库', needLogin: true };
      }
      const data = await kbTeamService.getAnalysisStatus(documentId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error?.message || '获取分析状态失败' };
    }
  });

  // 团队库分析重试：重新触发服务器侧 Worker 分析
  ipcMain.handle('kb-team:retry-analysis', async (_event, documentId) => {
    try {
      if (!kbAuthService.isLoggedIn()) {
        return { success: false, error: '未登录团队库', needLogin: true };
      }
      const data = await kbTeamService.retryAnalysis(documentId);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error?.message || '重试分析失败' };
    }
  });

  // C1 重命名文件夹
  ipcMain.handle('kb-team:rename-folder', async (_event, folderId, name) => {
    try {
      if (!kbAuthService.isLoggedIn()) return { success: false, error: '未登录团队库', needLogin: true };
      const result = await kbTeamService.renameFolder(folderId, name);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error?.message || '重命名文件夹失败' };
    }
  });

  // E2 移动文件夹
  ipcMain.handle('kb-team:move-folder', async (_event, folderId, parentId) => {
    try {
      if (!kbAuthService.isLoggedIn()) return { success: false, error: '未登录团队库', needLogin: true };
      const result = await kbTeamService.moveFolder(folderId, parentId);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error?.message || '移动文件夹失败' };
    }
  });

  // C1 重命名文档
  ipcMain.handle('kb-team:rename-document', async (_event, documentId, name) => {
    try {
      if (!kbAuthService.isLoggedIn()) return { success: false, error: '未登录团队库', needLogin: true };
      const result = await kbTeamService.renameDocument(documentId, name);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error?.message || '重命名文档失败' };
    }
  });

  // E2 移动文档
  ipcMain.handle('kb-team:move-document', async (_event, documentId, folderId) => {
    try {
      if (!kbAuthService.isLoggedIn()) return { success: false, error: '未登录团队库', needLogin: true };
      const result = await kbTeamService.moveDocument(documentId, folderId);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error?.message || '移动文档失败' };
    }
  });

  // C5 搜索（name / content 双模式）
  ipcMain.handle('kb-team:search', async (_event, query, mode) => {
    try {
      if (!kbAuthService.isLoggedIn()) return { success: false, error: '未登录团队库', needLogin: true };
      const docs = await kbTeamService.searchDocuments(query, mode);
      return { success: true, data: docs };
    } catch (error) {
      return { success: false, error: error?.message || '搜索失败' };
    }
  });

  // 知识库问答召回（带 content_text 片段）
  ipcMain.handle('kb-team:qa-retrieve', async (_event, query, limit) => {
    try {
      console.log('[kb-team:qa-retrieve] query=%s limit=%s', query, limit);
      if (!kbAuthService.isLoggedIn()) return { success: false, error: '未登录团队库', needLogin: true };
      const docs = await kbTeamService.qaRetrieve(query, limit);
      console.log('[kb-team:qa-retrieve] returned %d docs for query=%s', docs?.length || 0, query);
      return { success: true, data: docs };
    } catch (error) {
      console.error('[kb-team:qa-retrieve] failed:', error);
      return { success: false, error: error?.message || '召回失败' };
    }
  });

  // C3 回收站列表
  ipcMain.handle('kb-team:list-trash', async () => {
    try {
      if (!kbAuthService.isLoggedIn()) return { success: false, error: '未登录团队库', needLogin: true };
      const data = await kbTeamService.listTrash();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error?.message || '获取回收站失败' };
    }
  });

  // C3 从回收站恢复
  ipcMain.handle('kb-team:restore-from-trash', async (_event, type, id) => {
    try {
      if (!kbAuthService.isLoggedIn()) return { success: false, error: '未登录团队库', needLogin: true };
      const data = await kbTeamService.restoreFromTrash(type, id);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error?.message || '恢复失败' };
    }
  });

  // C2 批量导出 zip（弹保存对话框）
  ipcMain.handle('kb-team:export-zip', async (_event, ids) => {
    try {
      if (!kbAuthService.isLoggedIn()) return { success: false, error: '未登录团队库', needLogin: true };
      if (!Array.isArray(ids) || ids.length === 0) return { success: false, error: '未选择文档' };
      const result = await dialog.showSaveDialog({
        title: '导出为 ZIP',
        defaultPath: path.join(os.homedir(), 'team_documents.zip'),
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      await kbTeamService.exportZip(ids, result.filePath);
      return { success: true, data: { localPath: result.filePath } };
    } catch (error) {
      return { success: false, error: error?.message || '导出失败' };
    }
  });
}

module.exports = { registerKbTeamIpc };
