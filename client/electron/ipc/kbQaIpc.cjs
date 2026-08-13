const { ipcMain } = require('electron');

/**
 * 知识库问答 RAG 语义检索 IPC。
 * kb-qa:retrieve-context —— 语义召回（未配 embedding 时抛错，渲染层回退关键词检索）。
 * kb-qa:clear-index —— 清空本地向量索引缓存。
 *
 * 另含 kb-qa-session:* 一组通道：问答会话与消息的服务器持久化（按账号隔离）。
 */
function registerKbQaIpc({ kbQaRetrievalService, kbQaSessionService }) {
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

  ipcMain.handle('kb-qa:expand-related', async (_event, seedDocs, source, limit) => {
    try {
      const result = await kbQaRetrievalService.expandRelated(seedDocs || [], source, limit || 8);
      return { success: true, data: result.docs };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  // P3 知识图谱：构建（流式进度）/ 子图检索 / 状态 / 清空
  ipcMain.handle('kb-qa:build-graph', async (event, source) => {
    try {
      const result = await kbQaRetrievalService.buildGraph(source, {
        onProgress: (p) => {
          try {
            event.sender.send('kb-qa:build-graph-progress', p);
          } catch {
            /* ignore */
          }
        },
      });
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('kb-qa:graph-find', async (_event, question, source, limit) => {
    try {
      const result = await kbQaRetrievalService.graphFind(question, source, limit || 8);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('kb-qa:graph-status', async (_event, source) => {
    try {
      return { success: true, ...kbQaRetrievalService.graphStatus(source) };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('kb-qa:graph-clear', async (_event, source) => {
    try {
      return { success: true, ...kbQaRetrievalService.clearGraph(source) };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  if (!kbQaSessionService) return;

  // 统一包装：任何异常都转成 { success:false, error }，渲染层不必 try/catch
  const wrap = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { success: true, data: await fn(...args) };
      } catch (error) {
        return { success: false, error: error?.message || String(error) };
      }
    });
  };

  wrap('kb-qa-session:list', (limit) => kbQaSessionService.listSessions(limit || 100));
  wrap('kb-qa-session:create', (options) => kbQaSessionService.createSession(options || {}));
  wrap('kb-qa-session:rename', (sessionId, title) => kbQaSessionService.renameSession(sessionId, title));
  wrap('kb-qa-session:set-status', (sessionId, status) => kbQaSessionService.setSessionStatus(sessionId, status));
  wrap('kb-qa-session:delete', (sessionId) => kbQaSessionService.deleteSession(sessionId));
  wrap('kb-qa-session:clear', () => kbQaSessionService.clearSessions());
  wrap('kb-qa-session:list-messages', (sessionId, afterId) => kbQaSessionService.listMessages(sessionId, afterId || 0));
  wrap('kb-qa-session:add-message', (sessionId, payload) => kbQaSessionService.addMessage(sessionId, payload || {}));
  wrap('kb-qa-session:update-message', (messageId, payload) => kbQaSessionService.updateMessage(messageId, payload || {}));
}

module.exports = { registerKbQaIpc };
