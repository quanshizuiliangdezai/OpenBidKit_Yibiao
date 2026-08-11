const fs = require('node:fs');
const path = require('node:path');
const { getKnowledgeBaseDir } = require('../utils/paths.cjs');

function slugify(name) {
  return String(name || '未命名').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').trim() || '未命名';
}

// 输出为 YAML 双引号标量，转义反斜杠与双引号，避免标题/文件名中的特殊字符破坏 frontmatter。
function yamlScalar(value) {
  const s = String(value == null ? '' : value);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function splitFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { front: {}, body: raw };
  const front = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (mm) front[mm[1]] = mm[2].trim();
  }
  return { front, body: m[2] };
}

/**
 * 本地知识库的 Obsidian Vault 镜像（P2/P3 改造核心）。
 *
 * 设计三原则（对应隐患 H5/H6）：
 * 1. 单向镜像：exportToVault 把本地库文档写出为 Vault 的 content.md（带 YAML frontmatter：
 *    id/title/source/folder/tags/aliases），绝不回写本地库，绝不污染本地库 content.md。
 * 2. 隔离副本：Vault 是独立目录（默认 <知识库目录>/obsidian-vault），与本地库 database/文件隔离；
 *    Obsidian 的 [[wikilinks]]/标签只存在于 Vault 副本，不会进入本地库正文。
 * 3. 手动写回：importFromVault 仅在用户显式触发时，把 Vault 里被改动的 content.md 写回本地库
 *    （经 knowledgeBaseStore.writeMarkdown，仅更新正文与元数据，不重分析），再由现有同步逻辑上推服务器。
 */
function createKbVault({ app, store }) {
  const defaultVaultDir = path.join(getKnowledgeBaseDir(app), 'obsidian-vault');
  let vaultPath = defaultVaultDir;

  function getVaultPath() {
    return vaultPath;
  }

  function setVaultPath(p) {
    if (typeof p === 'string' && p.trim()) {
      vaultPath = p.trim();
    }
    return vaultPath;
  }

  function docVaultFilePath(doc, folderName) {
    const folder = slugify(folderName || '未分类');
    const name = slugify(doc.file_name || doc.title || doc.id);
    return path.join(vaultPath, folder, name, 'content.md');
  }

  function frontmatter(doc, folderName) {
    const source = doc.source || 'local';
    const tags = ['kb', source, slugify(folderName || '未分类')].filter(Boolean);
    const aliases = [doc.file_name || doc.title].filter(Boolean);
    const lines = [
      '---',
      `id: ${yamlScalar(doc.id)}`,
      `title: ${yamlScalar(doc.title || doc.file_name || '')}`,
      `source: ${yamlScalar(source)}`,
      `folder: ${yamlScalar(folderName || '未分类')}`,
      'tags:',
    ];
    for (const t of tags) lines.push(`  - ${yamlScalar(t)}`);
    lines.push('aliases:');
    for (const a of aliases) lines.push(`  - ${yamlScalar(a)}`);
    lines.push(`updated: ${yamlScalar(new Date().toISOString())}`);
    lines.push('---', '');
    return lines.join('\n');
  }

  function collectContentMd(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    const walk = (cur) => {
      const entries = fs.readdirSync(cur, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(cur, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'content.md') out.push(p);
      }
    };
    walk(dir);
    return out;
  }

  // 导出本地库 -> Obsidian Vault（单向，不改动本地库）。
  function exportToVault() {
    const { folders, documents } = store.list();
    const folderNameById = new Map();
    for (const f of folders) folderNameById.set(f.id, f.name);
    let exported = 0;
    let skipped = 0;
    for (const doc of documents) {
      const content = store.readMarkdown(doc.id);
      if (!content || !content.trim()) {
        skipped += 1;
        continue;
      }
      const folderName = folderNameById.get(doc.folder_id) || '未分类';
      const filePath = docVaultFilePath(doc, folderName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, frontmatter(doc, folderName) + content, 'utf-8');
      exported += 1;
    }
    return { success: true, exported, skipped, vaultPath };
  }

  // 从 Vault 写回本地库（手动触发）。仅覆盖被改动的文档正文，不动分析结果，不擅自新建文档。
  function importFromVault() {
    if (!fs.existsSync(vaultPath)) {
      return { success: true, changed: [], message: 'Vault 目录不存在，未做任何改动' };
    }
    const changed = [];
    for (const filePath of collectContentMd(vaultPath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { front, body } = splitFrontmatter(raw);
      const id = front.id;
      if (!id) continue;
      let current;
      try {
        current = store.readMarkdown(id);
      } catch {
        continue; // 本地库无此文档则跳过，避免擅自新建破坏同步逻辑
      }
      if (current === body) continue;
      store.writeMarkdown(id, body);
      changed.push({ id, file: filePath });
    }
    return { success: true, changed, vaultPath };
  }

  return {
    getVaultPath,
    setVaultPath,
    exportToVault,
    importFromVault,
  };
}

module.exports = { createKbVault };
