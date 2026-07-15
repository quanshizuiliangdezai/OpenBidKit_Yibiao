/**
 * syncService.cjs —— 团队知识库同步（push / pull）
 *
 * 设计要点（与服务器 merge.py 共用同一套同步语义）：
 * 1. 数据 = SQLite 里 11 张 knowledge_* 表 + workspace/knowledge-base/ 文件目录，二者缺一不可。
 * 2. 文档级幂等：以 document_id 为唯一键。目标库已有该 document_id → 整篇跳过（不 UPDATE、不覆盖）；
 *    目标库没有 → 整篇 INSERT（knowledge_documents + 所有子表 + 文件）。
 * 3. 子表（knowledge_blocks / candidate_items / items / item_blocks / discarded_groups 等）带有
 *    `INTEGER PRIMARY KEY AUTOINCREMENT` 的 id 列，跨库合并时必须**省略 id** 让目标库自增，
 *    否则不同来源的自增 id 会撞主键。所有复制逻辑统一排除名为 'id' 的列。
 * 4. push：本机 status='success' 的文档 → 打包为 knowledge.sqlite + kb/ + manifest.json → 写 Samba 共享 incoming/。
 *    pull：从 Samba 共享拉 master.zip → 把本机没有的 success 文档合并进本机（只 INSERT 新 docId）。
 * 5. 上传身份：push 时在 manifest 记录 account.username；服务器 merge 时写入主库 uploaded_by/uploaded_at。
 *
 * 本服务运行在 Electron 主进程，复用已加载的 better-sqlite3（无 ABI 问题），直接读已打开的本机库实例。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const paths = require('../utils/paths.cjs');

// Samba 共享配置：
// 优先级 env > ./sync-config.local.json（gitignore，不进仓库） > 留空
// 部署时把真实 host/share/user/pass 写进 sync-config.local.json，或用环境变量注入。
// 这样源码里不含任何内部 IP / 密码，仓库可安全托管（含私有仓库）。
function loadSmbConfig() {
  const fallback = {};
  try {
    const cfgPath = path.join(__dirname, 'sync-config.local.json');
    if (fs.existsSync(cfgPath)) {
      Object.assign(fallback, JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
    }
  } catch (e) {
    console.warn('[sync] 读取 sync-config.local.json 失败', e);
  }
  return {
    host: process.env.YIBIAO_SYNC_SMB_HOST || fallback.host || '',
    share: process.env.YIBIAO_SYNC_SMB_SHARE || fallback.share || 'toubiao',
    user: process.env.YIBIAO_SYNC_SMB_USER || fallback.user || 'yibiao',
    pass: process.env.YIBIAO_SYNC_SMB_PASS || fallback.pass || '',
    incoming: process.env.YIBIAO_SYNC_SMB_INCOMING || fallback.incoming || 'incoming',
    masterZip: process.env.YIBIAO_SYNC_SMB_MASTER || fallback.masterZip || 'master.zip',
  };
}
const SMB = loadSmbConfig();

// knowledge_* 表中按 document_id 关联的子表
const DOC_CHILD_TABLES = [
  'knowledge_blocks',
  'knowledge_candidate_items',
  'knowledge_items',
  'knowledge_item_blocks',
  'knowledge_discarded_groups',
  'knowledge_reports',
  'knowledge_document_steps',
  'knowledge_match_batches',
];

function uncRoot() {
  return `\\\\${SMB.host}\\${SMB.share}`;
}

// Windows 访问 Samba UNC 路径前确保已挂载（凭据持久化）。失败忽略，后续 IO 会暴露真实错误。
function ensureSmbMounted() {
  try {
    execSync(
      `net use "${uncRoot()}" /user:${SMB.user} "${SMB.pass}" /persistent:yes`,
      { stdio: 'ignore', windowsHide: true }
    );
  } catch (_) {
    /* 已挂载或凭据错误均忽略，写文件时若仍失败会如实返回 */
  }
}

function incomingDir() {
  return path.join(uncRoot(), SMB.incoming);
}

function masterZipPath() {
  return path.join(uncRoot(), SMB.masterZip);
}

// 从本机库复制 knowledge_* 建表语句到目标库（零硬编码，始终与软件 schema 同步）
function copyKnowledgeSchema(targetDb, srcDb) {
  const rows = srcDb
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_%'")
    .all();
  for (const r of rows) {
    if (r.sql) targetDb.exec(r.sql);
  }
}

// 复制整篇文档（knowledge_documents 行 + 所有子表行）。targetDb 若已有该 document_id 会被 INSERT OR IGNORE 跳过。
function copyDocument(srcDb, targetDb, documentId) {
  copyRowsByDoc(srcDb, targetDb, 'knowledge_documents', documentId);
  for (const t of DOC_CHILD_TABLES) {
    copyRowsByDoc(srcDb, targetDb, t, documentId);
  }
}

// 按 document_id 复制某表行；排除自增 id 列，靠业务 UNIQUE 键（document_id, ...）幂等。
function copyRowsByDoc(srcDb, targetDb, table, documentId) {
  const rows = srcDb.prepare(`SELECT * FROM ${table} WHERE document_id = ?`).all(documentId);
  if (!rows.length) return;
  const cols = Object.keys(rows[0]).filter((c) => c !== 'id');
  const placeholders = cols.map(() => '?').join(',');
  const stmt = targetDb.prepare(
    `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`
  );
  targetDb.transaction(() => {
    for (const r of rows) stmt.run(...cols.map((c) => r[c]));
  })();
}

// 按 folder_id 集合复制 knowledge_folders（INSERT OR IGNORE，靠 folder_id 幂等）
function copyFolders(srcDb, targetDb, folderIds) {
  if (!folderIds || !folderIds.size) return;
  const ids = Array.from(folderIds);
  const placeholders = ids.map(() => '?').join(',');
  const rows = srcDb
    .prepare(`SELECT * FROM knowledge_folders WHERE folder_id IN (${placeholders})`)
    .all(...ids);
  if (!rows.length) return;
  const cols = Object.keys(rows[0]).filter((c) => c !== 'id');
  const stmt = targetDb.prepare(
    `INSERT OR IGNORE INTO knowledge_folders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  );
  targetDb.transaction(() => {
    for (const r of rows) stmt.run(...cols.map((c) => r[c]));
  })();
}

// 复制单个文档的文件目录：srcKbRoot/folders/<fid>/documents/<did> → dstKbRoot/folders/<fid>/documents/<did>
function copyDocumentFiles(srcKbRoot, dstKbRoot, folderId, documentId) {
  const src = path.join(srcKbRoot, 'folders', folderId, 'documents', documentId);
  if (!fs.existsSync(src)) return;
  const dst = path.join(dstKbRoot, 'folders', folderId, 'documents', documentId);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

function createSyncService({ app, db, configStore }) {
  if (!db) {
    throw new Error('syncService 需要已打开的 workspace 数据库实例');
  }

  // 上传到团队库：导出本机 success 文档 → 写 Samba incoming/
  function pushToTeam() {
    const cfg = configStore ? configStore.load() : null;
    const account = cfg && cfg.account;
    if (!account || !account.username) {
      return { ok: false, error: '未注册账户：请先在「账户」页填写用户名后再同步' };
    }
    const username = account.username;

    const dbPath = paths.getWorkspaceDatabasePath(app);
    if (!fs.existsSync(dbPath)) {
      return { ok: false, error: '本地知识库数据库不存在' };
    }
    const kbRoot = paths.getKnowledgeBaseDir(app);

    const docs = db
      .prepare("SELECT document_id, folder_id FROM knowledge_documents WHERE status = 'success'")
      .all();
    if (!docs.length) {
      return { ok: false, error: '没有已处理成功(status=success)的文档可同步' };
    }

    const folderIds = new Set(docs.map((d) => d.folder_id));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-sync-'));
    try {
      const pkgPath = path.join(tmp, 'knowledge.sqlite');
      const pkgDb = new Database(pkgPath);
      try {
        copyKnowledgeSchema(pkgDb, db);
        copyFolders(db, pkgDb, folderIds);
        for (const d of docs) {
          copyDocument(db, pkgDb, d.document_id);
          copyDocumentFiles(kbRoot, path.join(tmp, 'kb'), d.folder_id, d.document_id);
        }
      } finally {
        pkgDb.close();
      }

      const manifest = {
        username,
        exported_at: new Date().toISOString(),
        app: 'yibiao',
        schema: 'knowledge-sync-v1',
        document_count: docs.length,
        documents: docs.map((d) => d.document_id),
      };
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const zip = new AdmZip();
      zip.addLocalFile(pkgPath);
      zip.addLocalFolder(path.join(tmp, 'kb'), 'kb');
      zip.addLocalFile(path.join(tmp, 'manifest.json'));

      ensureSmbMounted();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = Math.random().toString(36).slice(2, 8);
      const zipName = `${username}_${ts}_${rand}.zip`;
      const outZip = path.join(tmp, zipName);
      zip.writeZip(outZip);
      fs.copyFileSync(outZip, path.join(incomingDir(), zipName));

      return { ok: true, pushed_documents: docs.length, file: zipName };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 从团队库拉取：读 Samba 共享 master.zip → 合并本机没有的 success 文档（只 INSERT 新 docId）
  function pullFromTeam() {
    ensureSmbMounted();
    const mz = masterZipPath();
    if (!fs.existsSync(mz)) {
      return { ok: false, error: '服务器主库快照 master.zip 不存在，可能尚无任何人上传' };
    }
    const kbDst = paths.getKnowledgeBaseDir(app);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pull-'));
    try {
      const zip = new AdmZip(mz);
      zip.extractAllTo(tmp, true);
      const masterDbPath = path.join(tmp, 'knowledge.sqlite');
      if (!fs.existsSync(masterDbPath)) {
        return { ok: false, error: 'master.zip 结构异常：缺少 knowledge.sqlite' };
      }
      const mDb = new Database(masterDbPath, { readonly: true, fileMustExist: true });
      try {
        const masterDocs = mDb
          .prepare("SELECT document_id, folder_id FROM knowledge_documents WHERE status = 'success'")
          .all();
        if (!masterDocs.length) {
          return { ok: true, merged_documents: 0, skipped_documents: 0, note: '团队库暂无内容' };
        }
        // 先合并所有涉及的文件夹（保证文档外键存在）
        copyFolders(mDb, db, new Set(masterDocs.map((d) => d.folder_id)));

        let merged = 0;
        let skipped = 0;
        for (const d of masterDocs) {
          const exists = db
            .prepare('SELECT 1 FROM knowledge_documents WHERE document_id = ?')
            .get(d.document_id);
          if (exists) {
            skipped++;
            continue;
          }
          copyDocument(mDb, db, d.document_id);
          copyDocumentFiles(path.join(tmp, 'kb'), kbDst, d.folder_id, d.document_id);
          merged++;
        }
        return { ok: true, merged_documents: merged, skipped_documents: skipped };
      } finally {
        mDb.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return { pushToTeam, pullFromTeam };
}

module.exports = { createSyncService };
