/**
 * kbPersonalService.cjs —— 个人知识库（master.sqlite）服务层
 *
 * 通过 HTTP 15004 /api/personal/* 端点读取 master.sqlite 数据，
 * 仅支持浏览，不支持写入/删除。
 */

const fs = require('node:fs');
const path = require('node:path');

function createKbPersonalService({ app }) {
  const CACHE_DIR = path.join(app.getPath('userData'), 'personal-doc-cache');

  async function listFolders() {
    try {
      const base = process.env.YIBIAO_SERVER_URL || 'http://localhost:15004';
      const res = await fetch(`${base}/api/personal/folders`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.data) ? data.data : [];
    } catch {
      return [];
    }
  }

  async function listDocuments(folderId) {
    try {
      const base = process.env.YIBIAO_SERVER_URL || 'http://localhost:15004';
      const params = folderId ? `?folder=${encodeURIComponent(folderId)}` : '';
      const res = await fetch(`${base}/api/personal/documents${params}`);
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
      const base = process.env.YIBIAO_SERVER_URL || 'http://localhost:15004';
      const url = `${base}/api/personal/documents/${documentId}/file`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`下载文档失败（${res.status}）`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buffer);
      return destPath;
    } catch (err) {
      throw new Error(`下载文档失败: ${err.message}`);
    }
  }

  async function searchDocuments(keyword) {
    try {
      const base = process.env.YIBIAO_SERVER_URL || 'http://localhost:15004';
      const res = await fetch(`${base}/api/documents?q=${encodeURIComponent(keyword)}`, {
        headers: { Authorization: `Bearer ${process.env.KB_AUTH_TOKEN || ''}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.data) ? data.data : [];
    } catch {
      return [];
    }
  }

  return {
    listFolders,
    listDocuments,
    downloadDocument,
    searchDocuments,
  };
}

module.exports = createKbPersonalService;
