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
 * 4. push：本机 status='success' 的文档 → 打包为 knowledge.sqlite + kb/ + manifest.json → HTTP POST 上传。
 *    pull：HTTP GET 下载 master.zip → 把本机没有的 success 文档合并进本机（只 INSERT 新 docId）。
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

// HTTP 同步配置（硬编码默认值，环境变量可覆盖）：
// 优先级 env > 默认值
const DEFAULT_HTTP_CONFIG = {
  baseUrl: 'http://59.49.48.147:15002',
  uploadPath: '/yibiao/upload',
  downloadPath: '/yibiao/download',
  authToken: 'yibiao-sync-2026',
};

function loadHttpConfig() {
  return {
    baseUrl: process.env.YIBIAO_SYNC_BASE_URL || DEFAULT_HTTP_CONFIG.baseUrl,
    uploadPath: process.env.YIBIAO_SYNC_UPLOAD_PATH || DEFAULT_HTTP_CONFIG.uploadPath,
    downloadPath: process.env.YIBIAO_SYNC_DOWNLOAD_PATH || DEFAULT_HTTP_CONFIG.downloadPath,
    authToken: process.env.YIBIAO_SYNC_AUTH_TOKEN || DEFAULT_HTTP_CONFIG.authToken,
  };
}
const HTTP = loadHttpConfig();

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
// 关键：只插入【目标表真实存在】的列——避免服务端主库多出的列（如 uploaded_by）
//       在写回本地库时因列不存在而报错（SqliteError: no column named ...）。
function copyRowsByDoc(srcDb, targetDb, table, documentId) {
  const rows = srcDb.prepare(`SELECT * FROM ${table} WHERE document_id = ?`).all(documentId);
  if (!rows.length) return;
  const targetCols = new Set(
    targetDb.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  );
  const cols = Object.keys(rows[0]).filter((c) => c !== 'id' && targetCols.has(c));
  if (!cols.length) return;
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
  const targetCols = new Set(
    targetDb.prepare(`PRAGMA table_info(knowledge_folders)`).all().map((c) => c.name)
  );
  const cols = Object.keys(rows[0]).filter((c) => c !== 'id' && targetCols.has(c));
  if (!cols.length) return;
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

// 判断某表是否存在某列（用于兼容旧主库/旧客户端）
function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

// 增量同步位点：记录上次成功 push/pull 的时间（knowledge_sync_meta 表）
function getSyncMeta(db, key) {
  const row = db.prepare('SELECT value FROM knowledge_sync_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSyncMeta(db, key, value) {
  db.prepare(
    'INSERT INTO knowledge_sync_meta(key, value) VALUES(?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}



// 获取配置文件路径（用于同步到团队库）
function getConfigFilePath(app) {
  const paths = require('../utils/paths.cjs');
  return paths.getConfigFilePath(app);
}

// HTTP 上传函数
function httpPost(url, formData, headers = {}) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const http = require('node:http');
    const urlObj = new URL(url);
    const transport = urlObj.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { ...headers },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);
    formData.pipe(req);
  });
}

// HTTP 下载函数
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const http = require('node:http');
    const urlObj = new URL(url);
    const transport = urlObj.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${HTTP.authToken}`,
      },
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        resolve({ status: res.statusCode, data: Buffer.concat(chunks) });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function createSyncService({ app, db, configStore }) {
  if (!db) {
    throw new Error('syncService 需要已打开的 workspace 数据库实例');
  }

  // 上传到团队库：导出本机 success 文档 → HTTP POST 上传
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

    // 增量推送：只传「上次成功 push 之后有变化」的文档 + 软删文档，避免每次都把全库重新上传一遍。
    const lastPushAt = getSyncMeta(db, 'last_push_at') || '0';
    const successDocs = db
      .prepare("SELECT document_id, folder_id FROM knowledge_documents WHERE status = 'success' AND is_deleted = 0 AND updated_at > ?")
      .all(lastPushAt);
    const deletedDocs = db
      .prepare("SELECT document_id, folder_id FROM knowledge_documents WHERE is_deleted = 1 AND updated_at > ?")
      .all(lastPushAt);
    const syncableDocs = [...successDocs, ...deletedDocs];
    if (!syncableDocs.length) {
      return { ok: false, error: '没有可同步的文档' };
    }

    const folderIds = new Set(syncableDocs.map((d) => d.folder_id));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-sync-'));
    // 确保 kb 目录始终存在：只推送删除指令时 successDocs 为空，copyDocumentFiles 不会创建该目录，
    // 但 zip.addLocalFolder 要求目录必须存在，否则报 ADM-ZIP: File not found。
    fs.mkdirSync(path.join(tmp, 'kb'), { recursive: true });
    try {
      const pkgPath = path.join(tmp, 'knowledge.sqlite');
      const pkgDb = new Database(pkgPath);
      try {
        copyKnowledgeSchema(pkgDb, db);
        copyFolders(db, pkgDb, folderIds);
        for (const d of successDocs) {
          copyDocument(db, pkgDb, d.document_id);
          copyDocumentFiles(kbRoot, path.join(tmp, 'kb'), d.folder_id, d.document_id);
        }
        // 已软删除的文档只复制 knowledge_documents 行（作为删除指令），不复制子表/文件
        for (const d of deletedDocs) {
          copyRowsByDoc(db, pkgDb, 'knowledge_documents', d.document_id);
        }
      } finally {
        pkgDb.close();
      }

      const manifest = {
        username,
        exported_at: new Date().toISOString(),
        app: 'yibiao',
        schema: 'knowledge-sync-v1',
        document_count: successDocs.length,
        deleted_document_count: deletedDocs.length,
        documents: successDocs.map((d) => d.document_id),
        deleted_documents: deletedDocs.map((d) => d.document_id),
      };
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const zip = new AdmZip();
      zip.addLocalFile(pkgPath);
      const kbTmp = path.join(tmp, 'kb');
      if (fs.existsSync(kbTmp)) {
        zip.addLocalFolder(kbTmp, 'kb');
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

      // 读取 zip 文件并上传
      const zipBuffer = fs.readFileSync(outZip);
      
      // 使用 FormData 上传
      const boundary = '----YibiaoSyncBoundary' + Date.now();
      const bodyParts = [];
      
      // 添加 zip 文件
      bodyParts.push(
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="${zipName}"\r\n`,
        `Content-Type: application/zip\r\n\r\n`,
        zipBuffer,
        `\r\n`
      );
      
      // 添加 manifest
      const manifestBuffer = fs.readFileSync(path.join(tmp, 'manifest.json'));
      bodyParts.push(
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="manifest"; filename="manifest.json"\r\n`,
        `Content-Type: application/json\r\n\r\n`,
        manifestBuffer,
        `\r\n`
      );
      
      bodyParts.push(`--${boundary}--\r\n`);
      
      const requestBody = Buffer.concat(
        bodyParts.map(p => typeof p === 'string' ? Buffer.from(p) : p)
      );

      const uploadUrl = `${HTTP.baseUrl}${HTTP.uploadPath}`;
      
      // 发送请求
      const https = require('node:https');
      const http = require('node:http');
      const urlObj = new URL(uploadUrl);
      const transport = urlObj.protocol === 'https:' ? https : http;
      
      const postOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Authorization': `Bearer ${HTTP.authToken}`,
        },
      };

      return new Promise((resolve) => {
        const postReq = transport.request(postOptions, (postRes) => {
          let data = '';
          postRes.on('data', (chunk) => { data += chunk; });
          postRes.on('end', () => {
            const ok = postRes.statusCode >= 200 && postRes.statusCode < 300;
            // 仅当服务器确认收到（2xx）才推进同步位点，避免失败时误判为已同步
            if (ok) setSyncMeta(db, 'last_push_at', new Date().toISOString());
            resolve({
              ok,
              pushed_documents: ok ? successDocs.length : 0,
              deleted_documents: ok ? deletedDocs.length : 0,
              file: zipName,
              serverResponse: data,
              status: postRes.statusCode,
            });
          });
        });
        postReq.on('error', (err) => {
          resolve({ ok: false, error: `HTTP 上传失败: ${err.message}` });
        });
        postReq.write(requestBody);
        postReq.end();
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 把下载到的 zip 缓冲（Buffer）解压并合并进本机库，返回统计结果（只 INSERT 本地没有的文档）。
  async function mergeZipBuffer(data) {
    const kbDst = paths.getKnowledgeBaseDir(app);
    const configPath = getConfigFilePath(app);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pull-'));
    try {
      const zipPath = path.join(tmp, 'master.zip');
      fs.writeFileSync(zipPath, data);

      const zip = new AdmZip(zipPath);
      zip.extractAllTo(tmp, true);

      const masterDbPath = path.join(tmp, 'knowledge.sqlite');
      if (!fs.existsSync(masterDbPath)) {
        return { ok: false, error: 'master.zip 结构异常：缺少 knowledge.sqlite' };
      }

      const mDb = new Database(masterDbPath, { readonly: true, fileMustExist: true });
      try {
        const masterHasDeleted = hasColumn(mDb, 'knowledge_documents', 'is_deleted');
        const masterDocs = masterHasDeleted
          ? mDb
            .prepare("SELECT document_id, folder_id, is_deleted FROM knowledge_documents WHERE status = 'success' OR is_deleted = 1")
            .all()
          : mDb
            .prepare("SELECT document_id, folder_id, 0 AS is_deleted FROM knowledge_documents WHERE status = 'success'")
            .all();
        if (!masterDocs.length) {
          return { ok: true, merged_documents: 0, skipped_documents: 0, deleted_documents: 0, note: '团队库暂无内容' };
        }

        copyFolders(mDb, db, new Set(masterDocs.map((d) => d.folder_id)));

        let merged = 0;
        let skipped = 0;
        let deleted = 0;
        const now = new Date().toISOString();
        const localExistsStmt = db.prepare('SELECT 1 FROM knowledge_documents WHERE document_id = ?');
        const localSoftDeleteStmt = db.prepare('UPDATE knowledge_documents SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE document_id = ?');
        for (const d of masterDocs) {
          const exists = localExistsStmt.get(d.document_id);
          if (d.is_deleted) {
            if (exists) {
              localSoftDeleteStmt.run(now, now, d.document_id);
              deleted++;
            }
            continue;
          }
          if (exists) {
            skipped++;
            continue;
          }
          copyDocument(mDb, db, d.document_id);
          copyDocumentFiles(path.join(tmp, 'kb'), kbDst, d.folder_id, d.document_id);
          merged++;
        }

        // 拉取 user_config.json（AI API Key 等全局配置）
        let configSynced = false;
        const remoteConfigPath = path.join(tmp, 'user_config.json');
        if (configPath && fs.existsSync(remoteConfigPath)) {
          try {
            const remoteCfg = JSON.parse(fs.readFileSync(remoteConfigPath, 'utf8'));
            const localCfg = configStore ? configStore.load() : null;
            if (localCfg && configStore) {
              const mergedCfg = {
                ...localCfg,
                text_model_provider: remoteCfg.text_model_provider || localCfg.text_model_provider,
                text_model_profiles: {
                  ...localCfg.text_model_profiles,
                  ...remoteCfg.text_model_profiles,
                },
                image_model_profiles: {
                  ...localCfg.image_model_profiles,
                  ...remoteCfg.image_model_profiles,
                },
                image_model: remoteCfg.image_model || localCfg.image_model,
              };
              configStore.save(mergedCfg);
              configSynced = true;
            }
          } catch (e) {
            console.warn('[sync] 拉取 user_config.json 失败:', e.message);
          }
        }

        return {
          ok: true,
          merged_documents: merged,
          skipped_documents: skipped,
          deleted_documents: deleted,
          config_synced: configSynced,
        };
      } finally {
        mDb.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 仅把主库已软删、但本地尚未软删的文档在本地标记删除（无需下载文件）
  function applySoftDeletes(manifest, localMap) {
    const now = new Date().toISOString();
    const stmt = db.prepare('UPDATE knowledge_documents SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE document_id = ?');
    const tx = db.transaction(() => {
      for (const d of manifest.documents) {
        if (d.is_deleted && localMap.get(d.document_id) === false) {
          stmt.run(now, now, d.document_id);
        }
      }
    });
    tx();
  }

  async function downloadAndMerge(url) {
    let response;
    try {
      response = await httpGet(url);
    } catch (err) {
      return { ok: false, error: `HTTP 下载失败: ${err.message}` };
    }
    if (response.status !== 200) {
      return { ok: false, error: `服务器返回错误: ${response.status}` };
    }
    if (!response.data || response.data.length === 0) {
      return { ok: false, error: '服务器返回空数据，可能尚无任何人上传' };
    }
    return await mergeZipBuffer(response.data);
  }

  // 增量拉取：先向服务器要一份轻量清单（/yibiao/manifest），与本地比对后——
  //   · 本地已是最新 → 直接返回，不下载任何东西；
  //   · 有缺失文档 → 只请求这些文档的增量包（?ids=），避免每次都下整个库；
  //   · 旧服务器无 manifest 接口 → 自动降级为全量下载。
  async function pullFromTeam() {
    let manifest = null;
    try {
      const mRes = await httpGet(`${HTTP.baseUrl}/yibiao/manifest`);
      if (mRes.status === 200 && mRes.data && mRes.data.length) {
        manifest = JSON.parse(mRes.data.toString('utf-8'));
      }
    } catch (e) {
      manifest = null; // 旧服务器无此接口，走全量降级
    }

    if (manifest && Array.isArray(manifest.documents)) {
      if (manifest.documents.length === 0) {
        return { ok: true, merged_documents: 0, skipped_documents: 0, deleted_documents: 0, note: '团队库为空，无需拉取' };
      }
      const localRows = db.prepare('SELECT document_id, is_deleted FROM knowledge_documents').all();
      const localMap = new Map(localRows.map((r) => [r.document_id, !!r.is_deleted]));
      const needIds = [];
      let needDelete = 0;
      for (const d of manifest.documents) {
        const localDeleted = localMap.get(d.document_id);
        if (d.is_deleted) {
          if (localDeleted === false) needDelete++;
        } else if (localDeleted === undefined) {
          needIds.push(d.document_id);
        }
      }

      if (needIds.length === 0 && needDelete === 0) {
        return { ok: true, merged_documents: 0, skipped_documents: 0, deleted_documents: 0, note: '本地已是最新，跳过下载' };
      }

      if (needIds.length > 0) {
        try {
          const res = await httpGet(`${HTTP.baseUrl}${HTTP.downloadPath}?ids=${encodeURIComponent(needIds.join(','))}`);
          if (res.status === 200 && res.data && res.data.length) {
            const mergeResult = await mergeZipBuffer(res.data);
            if (needDelete > 0) applySoftDeletes(manifest, localMap);
            return mergeResult;
          }
        } catch (e) {
          // 落到全量降级
        }
        return await downloadAndMerge(`${HTTP.baseUrl}${HTTP.downloadPath}`);
      }

      // 只需软删、无需下载文件
      applySoftDeletes(manifest, localMap);
      return { ok: true, merged_documents: 0, skipped_documents: 0, deleted_documents: needDelete, note: '已同步删除' };
    }

    // 降级：全量下载（兼容旧服务器 / manifest 不可用）
    return await downloadAndMerge(`${HTTP.baseUrl}${HTTP.downloadPath}`);
  }

  // ===== 后台自动同步守护 =====
  // 定时器每 intervalMs 跑一次 tick：先 pull 远程更新，再 push 本地改动。
  // 复用现有增量 push/pull，因此对网络/磁盘压力极小（无变化直接跳过）。
  const autoState = {
    enabled: true,                 // 默认开启，实现“实时数据库文件夹”体验
    running: false,
    status: 'idle',                // 'idle' | 'syncing' | 'error'
    lastError: null,
    lastSuccessAt: null,
    lastPullAt: null,
    lastPullChanges: 0,            // 上次 pull 合并/删除的文档数（前端据此判断是否需要刷新列表）
    message: '',
  };
  let autoTimer = null;
  let autoOnStatus = null;

  function emitAutoStatus() {
    if (autoOnStatus) {
      try { autoOnStatus(getAutoStatus()); } catch { /* 渲染进程可能已销毁 */ }
    }
  }

  function getAutoStatus() {
    return {
      enabled: autoState.enabled,
      running: autoState.running,
      status: autoState.status,
      lastError: autoState.lastError,
      lastSuccessAt: autoState.lastSuccessAt,
      lastPullAt: autoState.lastPullAt,
      lastPullChanges: autoState.lastPullChanges,
      message: autoState.message,
    };
  }

  function setAutoEnabled(enabled) {
    autoState.enabled = !!enabled;
    if (autoState.enabled && !autoTimer) {
      void runAutoSyncNow();
    }
    emitAutoStatus();
    return getAutoStatus();
  }

  // 把 push/pull 的返回值归一：ok:false 里分「良性无操作」与「真正错误」。
  async function safePush() {
    try {
      const r = await pushToTeam();
      if (r && r.ok) {
        return { ok: true, benign: false, result: r };
      }
      // 良性：增量位点已最新，没有可推的文档
      if (r && r.error === '没有可同步的文档') {
        return { ok: true, benign: true, result: r };
      }
      return { ok: false, benign: false, result: r };
    } catch (e) {
      return { ok: false, benign: false, error: e.message };
    }
  }

  async function safePull() {
    try {
      const r = await pullFromTeam();
      if (r && r.ok) {
        const changes = (r.merged_documents || 0) + (r.deleted_documents || 0);
        autoState.lastPullAt = new Date().toISOString();
        autoState.lastPullChanges = changes;
        return { ok: true, benign: changes === 0, result: r, changes };
      }
      // 良性：服务器暂无内容 / 还没人上传 / manifest 接口暂不可用（降级中）
      if (r && (r.error || '').includes('master.zip')) return { ok: true, benign: true, result: r };
      if (r && (r.error || '').includes('尚无任何人上传')) return { ok: true, benign: true, result: r };
      return { ok: false, benign: false, result: r };
    } catch (e) {
      return { ok: false, benign: false, error: e.message };
    }
  }

  async function runAutoSyncNow() {
    if (autoState.running) return getAutoStatus();
    autoState.running = true;
    autoState.status = 'syncing';
    emitAutoStatus();
    try {
      // 先拉后推：先拿到别人的更新，再把自己新的推上去
      const pull = await safePull();
      const push = await safePush();

      // 真错误（非良性无操作）必须如实上报，绝不能当作成功 —— 否则失败会被绿勾掩盖。
      const pullErr = !pull.ok ? (pull.error || (pull.result && pull.result.error)) : null;
      const pushErr = !push.ok ? (push.error || (push.result && push.result.error)) : null;
      if (pullErr || pushErr) {
        autoState.status = 'error';
        autoState.lastError = pullErr || pushErr;
        return getAutoStatus();
      }

      autoState.lastSuccessAt = new Date().toISOString();
      autoState.lastError = null;
      autoState.status = 'idle';

      const parts = [];
      if (pull.ok && pull.result && pull.result.ok) {
        if (pull.result.note) parts.push(pull.result.note);
        else parts.push(`拉取 ${pull.result.merged_documents ?? 0} 篇/删 ${pull.result.deleted_documents ?? 0} 篇`);
      }
      if (push.ok && push.result && push.result.ok) {
        parts.push(`推送 ${push.result.pushed_documents ?? 0} 篇/删 ${push.result.deleted_documents ?? 0} 篇`);
      }
      autoState.message = parts.join('；') || '已是最新';
    } catch (e) {
      autoState.status = 'error';
      autoState.lastError = e.message;
    } finally {
      autoState.running = false;
      emitAutoStatus();
    }
    return getAutoStatus();
  }

  function startAutoSync({ intervalMs = 30000, onStatus } = {}) {
    autoOnStatus = onStatus || null;
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = setInterval(() => {
      if (!autoState.enabled) return;
      void runAutoSyncNow();
    }, intervalMs);
    void runAutoSyncNow(); // 启动后立即跑一次
    emitAutoStatus();
  }

  function stopAutoSync() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    emitAutoStatus();
  }

  return { pushToTeam, pullFromTeam, getAutoStatus, setAutoEnabled, startAutoSync, stopAutoSync, runAutoSyncNow };
}

module.exports = { createSyncService };
