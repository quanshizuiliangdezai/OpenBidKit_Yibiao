/**
 * kbPersonalService.cjs —— 个人知识库（master.sqlite）服务层
 *
 * 通过 HTTP 15004 /api/personal/* 端点访问服务器上的 master.sqlite。
 * 服务端已要求登录会话（Bearer session token），统一走 kbAuthService。
 * 支持：浏览、下载、新建文件夹（含子文件夹）、上传文档（批量在 IPC 层循环）、
 *       个人库→团队库导入、团队库→个人库同步。
 */

const fs = require('node:fs');
const path = require('node:path');

function createKbPersonalService({ app, kbAuthService }) {
  const CACHE_DIR = path.join(app.getPath('userData'), 'personal-doc-cache');

  function baseUrl() {
    return (kbAuthService?.getServerUrl?.() || process.env.YIBIAO_SERVER_URL || 'http://localhost:15004').replace(/\/+$/, '');
  }

  function authHeaders() {
    const token = kbAuthService?.getToken?.();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function listFolders() {
    try {
      const res = await fetch(`${baseUrl()}/api/personal/folders`, { headers: authHeaders() });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.data) ? data.data : [];
    } catch {
      return [];
    }
  }

  async function listDocuments(folderId) {
    try {
      const params = folderId ? `?folder=${encodeURIComponent(folderId)}` : '';
      const res = await fetch(`${baseUrl()}/api/personal/documents${params}`, { headers: authHeaders() });
      if (!res.ok) return [];
      const data = await res.json();
      // personal docs 字段不统一，做适配
      const raw = data?.data || [];
      return raw.map(doc => ({
        id: doc.id || doc.document_id || 0,
        document_id: doc.document_id || doc.id || 0,
        folder_id: doc.folder_id || 0,
        title: doc.title || doc.file_name || '未知',
        file_name: doc.file_name || '',
        file_size: doc.file_size || 0,
        mime_type: doc.mime_type || 'application/octet-stream',
        status: doc.status || 'ok',
        created_at: doc.created_at || '',
        updated_at: doc.updated_at || doc.created_at || '',
      }));
    } catch {
      return [];
    }
  }

  async function downloadDocument(documentId, destPath) {
    try {
      const url = `${baseUrl()}/api/personal/documents/${documentId}/file`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`下载文档失败（${res.status}）`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buffer);
      return destPath;
    } catch (err) {
      throw new Error(`下载文档失败: ${err.message}`);
    }
  }

  /**
   * 个人库搜索。mode='name' 仅文件名；mode='content' 全文检索。
   * 服务端契约：GET /api/personal/documents?q=<kw>&mode=name|content
   */
  async function searchDocuments(keyword, mode) {
    try {
      const params = new URLSearchParams();
      params.set('q', keyword);
      if (mode) params.set('mode', mode);
      const res = await fetch(`${baseUrl()}/api/personal/documents?${params.toString()}`, {
        headers: authHeaders(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.data) ? data.data : [];
    } catch {
      return [];
    }
  }

  /** 个人库新建文件夹（parentId 可选，支持子文件夹） */
  async function createFolder(name, parentId) {
    const res = await fetch(`${baseUrl()}/api/personal/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name, parent_id: parentId || null }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `新建文件夹失败（${res.status}）`);
    return data?.data;
  }

  /** 个人库上传单个文档（批量由调用方循环） */
  async function uploadDocument(filePath, originalName, folderId) {
    const fileName = originalName || path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'application/octet-stream' });
    const formData = new FormData();
    formData.append('file', blob, fileName);
    formData.append('folder_id', String(folderId));
    const res = await fetch(`${baseUrl()}/api/personal/documents`, {
      method: 'POST',
      headers: authHeaders(),
      body: formData,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `上传文档失败（${res.status}）`);
    return data?.data;
  }

  /** 个人库删除文件夹 */
  async function deleteFolder(folderId) {
    const res = await fetch(`${baseUrl()}/api/personal/folders/${encodeURIComponent(folderId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `删除文件夹失败（${res.status}）`);
    return data;
  }

  /** 个人库删除文档（进回收站）：DELETE /api/personal/documents/{id} */
  async function deleteDocument(documentId) {
    try { fs.rmSync(path.join(CACHE_DIR, `${documentId}.json`), { force: true }); } catch { /* noop */ }
    const res = await fetch(`${baseUrl()}/api/personal/documents/${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `删除文档失败（${res.status}）`);
    return data?.data || data || { success: true };
  }

  /** 个人库移动文件夹（parentId 为空表示移动到根目录） */
  async function moveFolder(folderId, parentId) {
    const res = await fetch(`${baseUrl()}/api/personal/folders/${encodeURIComponent(folderId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ parent_id: parentId || null }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `移动文件夹失败（${res.status}）`);
    return data;
  }

  /** 个人库重命名文件夹：PUT /api/personal/folders/{id} body {name} */
  async function renameFolder(folderId, name) {
    const res = await fetch(`${baseUrl()}/api/personal/folders/${encodeURIComponent(folderId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `重命名文件夹失败（${res.status}）`);
    return data;
  }

  /** 个人库移动文档：PUT /api/personal/documents/{id} body {folder_id} */
  async function moveDocument(documentId, folderId) {
    const res = await fetch(`${baseUrl()}/api/personal/documents/${encodeURIComponent(documentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ folder_id: (folderId == null || folderId === '') ? null : folderId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `移动文档失败（${res.status}）`);
    return data;
  }

  /** 个人库回收站列表（24h 内可恢复） */
  async function listTrash() {
    try {
      const res = await fetch(`${baseUrl()}/api/personal/trash`, { headers: authHeaders() });
      if (!res.ok) return { folders: [], documents: [] };
      const data = await res.json();
      return data?.data || { folders: [], documents: [] };
    } catch {
      return { folders: [], documents: [] };
    }
  }

  /** 个人库从回收站恢复：POST /api/personal/trash/restore body {type, id} */
  async function restoreFromTrash(type, id) {
    const res = await fetch(`${baseUrl()}/api/personal/trash/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ type, id }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `恢复失败（${res.status}）`);
    return data || { success: true };
  }

  /** 个人库导出选中文档为 zip 保存到 destPath。ids: (string|number)[] */
  async function exportZip(ids, destPath) {
    const idStr = (Array.isArray(ids) ? ids : [ids]).map(String).join(',');
    const url = `${baseUrl()}/api/personal/documents/export?ids=${encodeURIComponent(idStr)}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      let msg = `导出失败（${res.status}）`;
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* noop */ }
      throw new Error(msg);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return destPath;
  }

  /** 个人库文档 → 团队库（documentIds: string[]，targetTeamFolderId: 团队库目标文件夹，folderIds: 个人库文件夹id[] 整文件夹同步） */
  async function importToTeam(documentIds, targetTeamFolderId, folderIds = []) {
    const res = await fetch(`${baseUrl()}/api/import/personal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        folder_id: targetTeamFolderId,
        documents: documentIds.map(id => ({ document_id: id })),
        folders: folderIds,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `同步到团队库失败（${res.status}）`);
    return data;
  }

  /** 团队库文档 → 个人库（documentIds: number[]，folderIds: 团队库文件夹id[] 整文件夹同步） */
  async function importFromTeam(documentIds, folderIds = []) {
    const res = await fetch(`${baseUrl()}/api/import/team`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ documents: documentIds.map(id => ({ id })), folders: folderIds }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `同步到个人库失败（${res.status}）`);
    return data;
  }

  return {
    listFolders,
    listDocuments,
    downloadDocument,
    searchDocuments,
    createFolder,
    uploadDocument,
    deleteFolder,
    deleteDocument,
    moveFolder,
    renameFolder,
    moveDocument,
    listTrash,
    restoreFromTrash,
    exportZip,
    importToTeam,
    importFromTeam,
  };
}

module.exports = createKbPersonalService;
