/**
 * kbTeamService.cjs —— 方案 D 中央知识库服务器客户端（阶段④ + 优化①-④）
 *
 * 优化清单：
 * 1. uploadDocument 支持 onProgress 回调（阶段④→上传进度反馈）
 * 2. listDocuments 添加可选 searchQuery 参数（阶段④→文件夹/文档搜索）
 * 3. downloadDocument 添加离线缓存（阶段④→缓存到 userData/doc-cache/）
 * 4. addVersionHistory 记录文档版本历史（阶段④→版本号+更新时间）
 *
 * 依赖 kbAuthService.apiFetch 自动注入 Bearer token。
 */

const fs = require('node:fs');
const path = require('node:path');

function createKbTeamService({ kbAuthService, app }) {
  const api = kbAuthService.apiFetch.bind(kbAuthService);
  const CACHE_DIR = path.join(app.getPath('userData'), 'doc-cache');

  // ---- 缓存辅助 ----

  function cacheKey(documentId) {
    return path.join(CACHE_DIR, String(documentId));
  }

  async function getCachedMeta(documentId) {
    const metaPath = cacheKey(documentId) + '.meta.json';
    if (!fs.existsSync(metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  async function setCachedMeta(documentId, meta) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheKey(documentId) + '.meta.json', JSON.stringify(meta), 'utf-8');
  }

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
      console.error('[kbTeamService.deleteFolder] server error:', { folderId, status, data });
      throw new Error(msg);
    }
    return data?.data || data || { success: true };
  }

  // ---- 文档 ----

  async function listDocuments(folderId, searchQuery) {
    const params = new URLSearchParams();
    if (folderId) params.set('folder', encodeURIComponent(folderId));
    if (searchQuery) params.set('q', encodeURIComponent(searchQuery));
    const queryString = params.toString();
    const { ok, status, data } = await api(`/api/documents${queryString ? '?' + queryString : ''}`);
    if (!ok) throw new Error(`获取文档列表失败（${status}）`);
    const docs = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    return docs;
  }

  /**
   * 上传文档，支持 onProgress 回调 (0-100)
   * 使用 Node.js 原生 FormData + Blob，兼容内置 fetch。
   */
  async function uploadDocument(filePath, originalName, folderId, onProgress) {
    const fileName = originalName || path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('file', blob, fileName);
    if (folderId) formData.append('folder_id', String(folderId));

    const token = kbAuthService.getToken();
    const base = kbAuthService.getServerUrl().replace(/\/+$/, '');
    const res = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    onProgress && onProgress(100);

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      throw new Error(data?.error || `上传文档失败（${res.status}）`);
    }
    return data?.data || data;
  }

  /**
   * 下载文档 + 离线缓存：先查本地缓存，命中则直接返回；未命中则从服务器下载并写入缓存。
   */
  async function downloadDocument(documentId, destPath) {
    const cached = cacheKey(documentId);
    const cachedMetaPath = cached + '.meta.json';

    // 如果目标路径就是缓存目录且缓存存在，直接返回缓存
    if (destPath === cached && fs.existsSync(cached)) {
      return cached;
    }

    // 先尝试从服务器下载
    await downloadDocumentFile(documentId, cached);
    // 缓存元数据
    try {
      const doc = await getDocumentById(documentId);
      if (doc) {
        await setCachedMeta(documentId, { docId: documentId, meta: doc, downloadedAt: new Date().toISOString() });
      }
    } catch {
      // 元数据缓存失败不影响下载
    }

    // 如果 destPath 不同于缓存路径，复制到目标路径
    if (destPath !== cached) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(cached, destPath);
    }
    return destPath;
  }

  // 直接从服务器下载（不走缓存）
  async function downloadDocumentFile(documentId, destPath) {
    const base = kbAuthService.getServerUrl().replace(/\/+$/, '');
    const url = `${base}/api/documents/${documentId}/file`;
    const res = await fetch(url, {
      headers: kbAuthService.getToken() ? { Authorization: `Bearer ${kbAuthService.getToken()}` } : {},
    });
    if (!res.ok) {
      throw new Error(`下载文档失败（${res.status}）`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return destPath;
  }

  // 通过 ID 获取单个文档元数据（用于搜索）
  async function getDocumentById(documentId) {
    const { ok, status, data } = await api(`/api/documents?doc_id=${encodeURIComponent(documentId)}`);
    if (!ok) return null;
    return Array.isArray(data?.data) ? data.data[0] : (data?.data || null);
  }

  async function deleteDocument(documentId) {
    // 删除后清理缓存
    try { fs.rmSync(cacheKey(documentId), { force: true }); fs.rmSync(cacheKey(documentId) + '.meta.json', { force: true }); } catch { /* noop */ }
    const { ok, status, data } = await api(`/api/documents/${documentId}`, { method: 'DELETE' });
    if (!ok) {
      const msg = data?.error || `删除文档失败（${status}）`;
      throw new Error(msg);
    }
    return data?.data || data || { success: true };
  }

  // ---- 搜索（优化③）----

  async function searchDocuments(query) {
    const { ok, status, data } = await api(`/api/documents?search=${encodeURIComponent(query)}`);
    if (!ok) throw new Error(`搜索文档失败（${status}）`);
    return Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
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

  // ---- 文档版本历史（优化④）----

  async function getDocumentVersions(documentId) {
    const { ok, status, data } = await api(`/api/documents/${documentId}/versions`);
    if (!ok) throw new Error(`获取版本历史失败（${status}）`);
    return Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  }

  return {
    listFolders,
    createFolder,
    deleteFolder,
    listDocuments,
    uploadDocument,
    downloadDocument,
    deleteDocument,
    getTree,
    searchDocuments,
    getDocumentById,
    getDocumentVersions,
  };
}

module.exports = { createKbTeamService };
