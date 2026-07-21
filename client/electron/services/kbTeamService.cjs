/**
 * kbTeamService.cjs —— 方案 D 中央知识库服务器客户端（阶段④）
 *
 * 职责：文件夹/文档的 CRUD 全部走服务器 REST API，不碰本地 SQLite。
 * 分析管道（markdown/items/matching）仍在 knowledgeBaseService 本地跑，
 * 文件按需从服务器下载到临时目录供本地分析使用。
 *
 * 依赖 kbAuthService.apiFetch 自动注入 Bearer token。
 */

function createKbTeamService({ kbAuthService }) {
  const api = kbAuthService.apiFetch.bind(kbAuthService);

  // ---- 文件夹 ----

  async function listFolders(parentId) {
    const params = parentId ? `?parent=${encodeURIComponent(parentId)}` : '';
    const { ok, status, data } = await api(`/api/folders${params}`);
    if (!ok) throw new Error(`获取文件夹列表失败（${status}）`);
    const folders = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    return folders;
  }

  async function createFolder(name, parentId) {
    const body = { name };
    if (parentId) body.parent = parentId;
    const { ok, status, data } = await api('/api/folders', { method: 'POST', body });
    if (!ok) {
      const msg = data?.error || `创建文件夹失败（${status}）`;
      throw new Error(msg);
    }
    return data?.data || data;
  }

  async function deleteFolder(folderId) {
    const { ok, status, data } = await api(`/api/folders/${folderId}`, { method: 'DELETE' });
    if (!ok) {
      const msg = data?.error || `删除文件夹失败（${status}）`;
      throw new Error(msg);
    }
    return data?.data || data || { success: true };
  }

  // ---- 文档 ----

  async function listDocuments(folderId) {
    const params = folderId ? `?folder=${encodeURIComponent(folderId)}` : '';
    const { ok, status, data } = await api(`/api/documents${params}`);
    if (!ok) throw new Error(`获取文档列表失败（${status}）`);
    const docs = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    return docs;
  }

  async function uploadDocument(filePath, originalName, folderId) {
    const fs = require('node:fs');
    const path = require('node:path');
    const FormData = require('form-data');

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), {
      filename: originalName || path.basename(filePath),
      contentType: 'application/octet-stream',
    });
    if (folderId) form.append('folder_id', String(folderId));

    // form-data 需要自定义 headers（boundary）
    const headers = form.getHeaders();
    // apiFetch 支持 FormData 传入，但 Node 的 form-data 库对象不是浏览器 FormData
    // 所以手动注入 headers 并传 form 作为 body
    const { ok, status, data } = await api('/api/documents', {
      method: 'POST',
      body: form,
      headers,
    });
    if (!ok) {
      const msg = data?.error || `上传文档失败（${status}）`;
      throw new Error(msg);
    }
    return data?.data || data;
  }

  async function downloadDocument(documentId, destPath) {
    return downloadDocumentFile(documentId, destPath);
  }

  // 直接流式下载到本地文件（绕过 apiFetch 的 JSON 解析）
  async function downloadDocumentFile(documentId, destPath) {
    const fs = require('node:fs');
    const base = kbAuthService.getServerUrl().replace(/\/+$/, '');
    const url = `${base}/api/documents/${documentId}/file`;
    const res = await fetch(url, {
      headers: kbAuthService.getToken() ? { Authorization: `Bearer ${kbAuthService.getToken()}` } : {},
    });
    if (!res.ok) {
      throw new Error(`下载文档失败（${res.status}）`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(require('node:path').dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return destPath;
  }

  async function deleteDocument(documentId) {
    const { ok, status, data } = await api(`/api/documents/${documentId}`, { method: 'DELETE' });
    if (!ok) {
      const msg = data?.error || `删除文档失败（${status}）`;
      throw new Error(msg);
    }
    return data?.data || data || { success: true };
  }

  // ---- 组合查询 ----

  // 获取整棵树：所有文件夹 + 所有文档，一次性返回给前端
  async function getTree() {
    const [folders, documents] = await Promise.all([
      listFolders(),
      listDocuments(),
    ]);
    return { folders, documents };
  }

  return {
    listFolders,
    createFolder,
    deleteFolder,
    listDocuments,
    uploadDocument,
    downloadDocument: downloadDocumentFile,
    deleteDocument,
    getTree,
  };
}

module.exports = { createKbTeamService };
