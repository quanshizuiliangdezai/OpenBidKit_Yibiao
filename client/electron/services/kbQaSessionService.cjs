/**
 * kbQaSessionService.cjs —— 知识库问答会话持久化（服务器存储，按账号隔离）
 *
 * 背景：问答页原先把消息放在组件 useState 里，用户切去「标书生成」页面时组件卸载，
 * 聊天记录连同正在进行的回答一起丢失。现在会话与消息全部落到服务器
 * kb_qa_sessions / kb_qa_messages 表，随账号走，换电脑登录也能看到历史。
 *
 * 服务端已按 employee_id 做了归属校验，这里只做薄封装 + 统一错误信息。
 */

function createKbQaSessionService({ kbAuthService }) {
  const api = kbAuthService.apiFetch.bind(kbAuthService);

  function unwrap(res, fallbackMsg) {
    const { ok, status, data } = res;
    if (!ok) {
      throw new Error(data?.error || `${fallbackMsg}（${status}）`);
    }
    return data?.data ?? data;
  }

  // ---- 会话 ----

  async function listSessions(limit = 100) {
    const res = await api(`/api/kb-qa/sessions?limit=${encodeURIComponent(limit)}`);
    const list = unwrap(res, '获取问答会话列表失败');
    return Array.isArray(list) ? list : [];
  }

  async function createSession({ title = null, libraryType = 'team' } = {}) {
    const res = await api('/api/kb-qa/sessions', {
      method: 'POST',
      body: { title, library_type: libraryType },
    });
    return unwrap(res, '创建问答会话失败');
  }

  async function renameSession(sessionId, title) {
    const res = await api(`/api/kb-qa/sessions/${sessionId}`, {
      method: 'PUT',
      body: { title },
    });
    return unwrap(res, '重命名会话失败');
  }

  async function setSessionStatus(sessionId, status) {
    const res = await api(`/api/kb-qa/sessions/${sessionId}`, {
      method: 'PUT',
      body: { status },
    });
    return unwrap(res, '更新会话状态失败');
  }

  async function deleteSession(sessionId) {
    const res = await api(`/api/kb-qa/sessions/${sessionId}`, { method: 'DELETE' });
    unwrap(res, '删除会话失败');
    return { success: true };
  }

  async function clearSessions() {
    const res = await api('/api/kb-qa/sessions', { method: 'DELETE' });
    return unwrap(res, '清空会话失败');
  }

  // ---- 消息 ----

  async function listMessages(sessionId, afterId = 0) {
    const res = await api(
      `/api/kb-qa/sessions/${sessionId}/messages?after=${encodeURIComponent(afterId)}`,
    );
    const list = unwrap(res, '获取会话消息失败');
    return Array.isArray(list) ? list : [];
  }

  async function addMessage(sessionId, { role, content = '', status = 'done', sources = null }) {
    const res = await api(`/api/kb-qa/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: { role, content, status, sources },
    });
    return unwrap(res, '保存消息失败');
  }

  async function updateMessage(messageId, { content, status, sources } = {}) {
    const body = {};
    if (content !== undefined) body.content = content;
    if (status !== undefined) body.status = status;
    if (sources !== undefined) body.sources = sources;
    const res = await api(`/api/kb-qa/messages/${messageId}`, { method: 'PUT', body });
    return unwrap(res, '更新消息失败');
  }

  return {
    listSessions,
    createSession,
    renameSession,
    setSessionStatus,
    deleteSession,
    clearSessions,
    listMessages,
    addMessage,
    updateMessage,
  };
}

module.exports = { createKbQaSessionService };
