const { ipcMain } = require('electron');

/**
 * 知识库问答 RAG 语义检索 IPC。
 * kb-qa:retrieve-context —— 语义召回（未配 embedding 时抛错，渲染层回退关键词检索）。
 * kb-qa:clear-index —— 清空本地向量索引缓存。
 */
function registerKbQaIpc({ kbQaRetrievalService }) {
  ipcMain.handle('kb-qa:retrieve-context', async (_event, question, options) => {
    try {
      const result = await kbQaRetrievalService.retrieveContext(question, options || {});
      return { success: true, data: result.docs, warnings: result.warnings || [] };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('kb-qa:clear-index', async (_event, source) => {
    try {
      return { success: true, ...kbQaRetrievalService.clearIndex(source) };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });
}

module.exports = { registerKbQaIpc };
