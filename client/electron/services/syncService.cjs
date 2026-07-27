/**
 * syncService.cjs —— 团队知识库同步（push / pull，HTTP 增量版 ★4）
 *
 * 设计要点（与服务器 merge.py 共用同一套同步语义）：
 * 1. 数据 = SQLite 里 11 张 knowledge_* 表 + workspace/knowledge-base/ 文件目录，二者缺一不可。
 * 2. 文档级幂等：以 document_id 为唯一键。目标库已有该 document_id → 整篇跳过（不 UPDATE、不覆盖）；
 *    目标库没有 → 整篇 INSERT（knowledge_documents + 所有子表 + 文件）。
 * 3. 子表（knowledge_blocks / candidate_items / items / item_blocks / discarded_groups 等）带有
 *    `INTEGER PRIMARY KEY AUTOINCREMENT` 的 id 列，跨库合并时必须**省略 id** 让目标库自增，
 *    否则不同来源的自增 id 会撞主键。所有复制逻辑统一排除名为 'id' 的列。
 * 4. ★4 增量同步（基于服务器 manifest 游标，只传变更）：
 *    push：先 GET /sync/yibiao/manifest 拿服务器已有 document_id 集合，
 *          只打包服务器**没有**的本机 success 文档 → 流式 POST /sync/upload。
 *          （merge 语义是"已有 docId 整篇跳过"，推已有文档纯属浪费带宽，故只推新增。）
 *    pull：用 manifest 对比出本机缺失的 document_id → GET /sync/download?ids=a,b,c 只拉增量包；
 *          manifest 拉取失败时自动回退全量 master.zip，保证可用性。
 * 5. ★3 流式上传：zip 打包落盘后经 fs.createReadStream 分块推给服务器，
 *    不再把整个 zip readFileSync 进内存（大库不再 OOM）。
 * 6. 上传身份：push 时在 manifest.json 记录 account.username；服务器 merge 时写入主库 uploaded_by/uploaded_at。
 *
 * 本服务运行在 Electron 主进程，复用已加载的 better-sqlite3（无 ABI 问题），直接读已打开的本机库实例。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const paths = require('../utils/paths.cjs');

// HTTP 同步配置（默认指向 15004 单端口合并服务的 /sync/*）
// authToken 加载优先级：
//   1) 环境变量 YIBIAO_SYNC_AUTH_TOKEN
//   2) client/electron/sync-config.local.json（已被 .gitignore，CI 构建时从 secrets.YIBIAO_SYNC_CONFIG 写入）
//   3) 用户数据目录下的 yibiao-sync-config.json
//   4) 兜底默认值（内置团队同步令牌，未配置时也能直接同步）
const DEFAULT_HTTP_CONFIG = {
  baseUrl: 'http://59.49.48.147:15004',
  uploadPath: '/sync/upload',
  downloadPath: '/sync/download',
  manifestPath: '/sync/yibiao/manifest',
  authToken: 'yibiao-sync-2026',
};

function loadLocalSyncConfig() {
  // 1) 开发/CI 构建时：源码树内的 sync-config.local.json
  const devPath = path.join(__dirname, '..', 'sync-config.local.json');
  // 2) 运行时安装包：用户数据目录下的 yibiao-sync-config.json（便于发版后不改安装包也能换 token）
  const configDir = paths.getConfigFilePath ? path.dirname(paths.getConfigFilePath()) : null;
  const runtimePath = configDir ? path.join(configDir, 'yibiao-sync-config.json') : null;
  for (const p of [devPath, runtimePath]) {
    if (p && fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        console.warn('[sync] 读取同步配置失败:', p, e.message);
      }
    }
  }
  return null;
}

function loadHttpConfig() {
  const local = loadLocalSyncConfig() || {};
  return {
    baseUrl: process.env.YIBIAO_SYNC_BASE_URL || local.baseUrl || DEFAULT_HTTP_CONFIG.baseUrl,
    uploadPath: process.env.YIBIAO_SYNC_UPLOAD_PATH || local.uploadPath || DEFAULT_HTTP_CONFIG.uploadPath,
    downloadPath: process.env.YIBIAO_SYNC_DOWNLOAD_PATH || local.downloadPath || DEFAULT_HTTP_CONFIG.downloadPath,
    manifestPath: process.env.YIBIAO_SYNC_MANIFEST_PATH || local.manifestPath || DEFAULT_HTTP_CONFIG.manifestPath,
    authToken: process.env.YIBIAO_SYNC_AUTH_TOKEN || local.authToken || DEFAULT_HTTP_CONFIG.authToken,
  };
}
const HTTP = loadHttpConfig();
if (!HTTP.authToken) {
  console.warn('[sync] 团队库同步令牌为空，无法同步：请设置 YIBIAO_SYNC_AUTH_TOKEN 环境变量，或创建 client/electron/sync-config.local.json');
} else if (HTTP.authToken === DEFAULT_HTTP_CONFIG.authToken) {
  console.warn('[sync] 未显式配置团队库同步令牌，正在使用内置默认令牌（yibiao-sync-2026）。如需更换请在环境变量或 sync-config.local.json 中配置。');
}

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

// ---------------------------------------------------------------
// HTTP 基础函数
// ---------------------------------------------------------------
function transportFor(urlObj) {
  return urlObj.protocol === 'https:' ? https : http;
}

// GET JSON（用于 manifest）
function httpGetJson(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = transportFor(urlObj).request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${HTTP.authToken}` },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

// GET 二进制流式下载到本地文件（不整包进内存）
function httpDownloadToFile(url, destPath, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = transportFor(urlObj).request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${HTTP.authToken}` },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`)));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(destPath)));
        out.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
    req.end();
  });
}

// ★3 流式 multipart 上传：zip 文件经 createReadStream 分块写入请求（不整包进内存）
function httpUploadZipFile(url, zipPath, zipName, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const boundary = '----YibiaoSyncBoundary' + Date.now() + Math.random().toString(36).slice(2, 8);
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${zipName}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
    const zipSize = fs.statSync(zipPath).size;
    const contentLength = preamble.length + zipSize + epilogue.length;

    const req = transportFor(urlObj).request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': contentLength,
          Authorization: `Bearer ${HTTP.authToken}`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`上传失败 HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(data)); } catch (_) { resolve({ ok: true, raw: data }); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('上传超时')));
    req.on('error', reject);

    req.write(preamble);
    const stream = fs.createReadStream(zipPath, { highWaterMark: 64 * 1024 });
    stream.on('error', (e) => req.destroy(e));
    stream.on('end', () => {
      req.write(epilogue);
      req.end();
    });
    stream.pipe(req, { end: false });
  });
}

// 拉服务器 manifest（★4 游标）；失败返回 null（调用方自行回退全量）
async function fetchServerManifest() {
  try {
    const m = await httpGetJson(`${HTTP.baseUrl}${HTTP.manifestPath}`);
    if (m && Array.isArray(m.documents)) return m;
    return null;
  } catch (e) {
    console.warn('[sync] 拉取 manifest 失败，回退全量模式:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------
// 库间复制（与 merge.py 同语义）
// ---------------------------------------------------------------
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

// 获取配置文件路径（用于同步到团队库）
function getConfigFilePath(app) {
  const p = require('../utils/paths.cjs');
  return p.getConfigFilePath(app);
}

function createSyncService({ app, db, configStore }) {
  if (!db) {
    throw new Error('syncService 需要已打开的 workspace 数据库实例');
  }

  // 上传到团队库（★4 增量）：只打包服务器没有的本机 success 文档 → 流式 HTTP 上传
  async function pushToTeam() {
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
    const configPath = getConfigFilePath(app);

    const allDocs = db
      .prepare("SELECT document_id, folder_id FROM knowledge_documents WHERE status = 'success'")
      .all();
    if (!allDocs.length) {
      return { ok: false, error: '没有已处理成功(status=success)的文档可同步' };
    }

    // ★4 增量：对比服务器 manifest，只推服务器没有的文档；manifest 失败则回退全量（幂等，服务器会跳过已有）
    const serverManifest = await fetchServerManifest();
    let docs = allDocs;
    let mode = 'full';
    if (serverManifest) {
      const serverIds = new Set(serverManifest.documents.map((d) => d.document_id));
      docs = allDocs.filter((d) => !serverIds.has(d.document_id));
      mode = 'incremental';
      if (!docs.length) {
        return {
          ok: true,
          pushed_documents: 0,
          skipped_documents: allDocs.length,
          mode,
          note: '服务器已包含本机全部文档，无需上传',
        };
      }
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
        sync_mode: mode,
        document_count: docs.length,
        documents: docs.map((d) => d.document_id),
      };
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const zip = new AdmZip();
      zip.addLocalFile(pkgPath);
      if (fs.existsSync(path.join(tmp, 'kb'))) {
        zip.addLocalFolder(path.join(tmp, 'kb'), 'kb');
      }
      zip.addLocalFile(path.join(tmp, 'manifest.json'));

      // 如果本地存在 user_config.json，也打包进去（供服务器 merge 时同步给全员）
      if (configPath && fs.existsSync(configPath)) {
        zip.addLocalFile(configPath);
      }

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = Math.random().toString(36).slice(2, 8);
      const zipName = `${username}_${ts}_${rand}.zip`;
      const outZip = path.join(tmp, zipName);
      zip.writeZip(outZip);

      // ★3 流式上传（分块推流，不整包进内存）
      const uploadUrl = `${HTTP.baseUrl}${HTTP.uploadPath}`;
      const resp = await httpUploadZipFile(uploadUrl, outZip, zipName);
      if (resp && resp.ok === false) {
        return { ok: false, error: `服务器拒绝: ${JSON.stringify(resp).slice(0, 200)}` };
      }

      return { ok: true, pushed_documents: docs.length, mode, file: zipName };
    } catch (e) {
      return { ok: false, error: `上传失败: ${e.message}` };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 把一个已解压的同步包目录合并进本机库（返回 {merged, skipped}）
  function mergePackageDir(tmp, wantedIds) {
    const kbDst = paths.getKnowledgeBaseDir(app);
    const masterDbPath = path.join(tmp, 'knowledge.sqlite');
    if (!fs.existsSync(masterDbPath)) {
      throw new Error('同步包结构异常：缺少 knowledge.sqlite');
    }
    const mDb = new Database(masterDbPath, { readonly: true, fileMustExist: true });
    try {
      let masterDocs = mDb
        .prepare("SELECT document_id, folder_id FROM knowledge_documents WHERE status = 'success'")
        .all();
      if (wantedIds) {
        masterDocs = masterDocs.filter((d) => wantedIds.has(d.document_id));
      }
      if (!masterDocs.length) return { merged: 0, skipped: 0 };
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
      return { merged, skipped };
    } finally {
      mDb.close();
    }
  }

  // 同步 user_config.json（AI API Key 等全局配置），失败不影响文档同步
  // 安全策略：本地已配置的 API Key / 模型 / provider 优先保留，绝不覆盖；
  // 仅当本地某字段为空时，才用远程配置补充。避免不同用户互相同步时冲掉各自 Key。
  function mergeRemoteConfig(tmp) {
    const configPath = getConfigFilePath(app);
    const remoteConfigPath = path.join(tmp, 'user_config.json');
    if (!configPath || !fs.existsSync(remoteConfigPath)) return false;
    try {
      const remoteCfg = JSON.parse(fs.readFileSync(remoteConfigPath, 'utf8'));
      const localCfg = configStore ? configStore.load() : null;
      // 只同步 AI 相关配置字段，保留本地 account/analytics 等用户专属数据
      if (localCfg && configStore) {
        function mergeProfiles(localProfiles = {}, remoteProfiles = {}) {
          const merged = { ...localProfiles };
          for (const [provider, remoteProfile] of Object.entries(remoteProfiles)) {
            const localProfile = merged[provider] || {};
            // 若本地已填写 api_key，则该 provider 完全保留本地，远程不再覆盖
            if (localProfile.api_key) {
              continue;
            }
            merged[provider] = { ...remoteProfile };
          }
          return merged;
        }

        const mergedCfg = {
          ...localCfg,
          text_model_provider: localCfg.text_model_provider || remoteCfg.text_model_provider || '',
          text_model_profiles: mergeProfiles(localCfg.text_model_profiles, remoteCfg.text_model_profiles),
          image_model_profiles: mergeProfiles(localCfg.image_model_profiles, remoteCfg.image_model_profiles),
          image_model: localCfg.image_model || remoteCfg.image_model || '',
        };
        configStore.save(mergedCfg);
        return true;
      }
    } catch (e) {
      console.warn('[sync] 拉取 user_config.json 失败:', e.message);
    }
    return false;
  }

  // 从团队库拉取（★4 增量）：manifest 对比出本机缺失的 docId → ?ids= 只拉增量包；
  // manifest 不可用时回退全量 master.zip。
  async function pullFromTeam() {
    const serverManifest = await fetchServerManifest();

    // ---------- 增量路径 ----------
    if (serverManifest) {
      const serverDocs = serverManifest.documents.filter((d) => !d.is_deleted);
      if (!serverDocs.length) {
        return { ok: true, merged_documents: 0, skipped_documents: 0, mode: 'incremental', note: '团队库暂无内容' };
      }
      const missing = serverDocs.filter(
        (d) => !db.prepare('SELECT 1 FROM knowledge_documents WHERE document_id = ?').get(d.document_id)
      );
      if (!missing.length) {
        return {
          ok: true,
          merged_documents: 0,
          skipped_documents: serverDocs.length,
          mode: 'incremental',
          note: '本机已是最新，无需拉取',
        };
      }

      // 按批下载（防 URL 过长），每批 40 个 id
      let merged = 0;
      let skipped = 0;
      const BATCH = 40;
      try {
        for (let i = 0; i < missing.length; i += BATCH) {
          const batch = missing.slice(i, i + BATCH);
          const ids = batch.map((d) => d.document_id).join(',');
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pull-'));
          try {
            const zipFile = path.join(tmp, 'inc.zip');
            await httpDownloadToFile(
              `${HTTP.baseUrl}${HTTP.downloadPath}?ids=${encodeURIComponent(ids)}`,
              zipFile
            );
            const zip = new AdmZip(zipFile);
            zip.extractAllTo(tmp, true);
            const wanted = new Set(batch.map((d) => d.document_id));
            const r = mergePackageDir(tmp, wanted);
            merged += r.merged;
            skipped += r.skipped;
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        }
        return {
          ok: true,
          merged_documents: merged,
          skipped_documents: skipped + (serverDocs.length - missing.length),
          mode: 'incremental',
        };
      } catch (e) {
        console.warn('[sync] 增量拉取失败，回退全量:', e.message);
        // 落入下方全量路径
      }
    }

    // ---------- 全量回退路径 ----------
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pull-'));
    try {
      const zipFile = path.join(tmp, 'master.zip');
      try {
        await httpDownloadToFile(`${HTTP.baseUrl}${HTTP.downloadPath}`, zipFile);
      } catch (e) {
        return { ok: false, error: `下载团队库失败: ${e.message}` };
      }
      const zip = new AdmZip(zipFile);
      zip.extractAllTo(tmp, true);
      const r = mergePackageDir(tmp, null);
      const configSynced = mergeRemoteConfig(tmp);
      return {
        ok: true,
        merged_documents: r.merged,
        skipped_documents: r.skipped,
        config_synced: configSynced,
        mode: 'full',
      };
    } catch (e) {
      return { ok: false, error: `拉取失败: ${e.message}` };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return { pushToTeam, pullFromTeam };
}

module.exports = { createSyncService };
