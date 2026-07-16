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
            resolve({ ok: true, pushed_documents: docs.length, file: zipName, serverResponse: data });
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

  // 从团队库拉取：HTTP GET 下载 master.zip → 合并本机没有的 success 文档（只 INSERT 新 docId）
  // 同时拉取 user_config.json（管理员配置的 AI API Key 等全局设置）
  async function pullFromTeam() {
    const downloadUrl = `${HTTP.baseUrl}${HTTP.downloadPath}`;
    
    let response;
    try {
      response = await httpGet(downloadUrl);
    } catch (err) {
      return { ok: false, error: `HTTP 下载失败: ${err.message}` };
    }

    if (response.status !== 200) {
      return { ok: false, error: `服务器返回错误: ${response.status}` };
    }

    if (!response.data || response.data.length === 0) {
      return { ok: false, error: '服务器返回空数据，可能尚无任何人上传' };
    }

    const kbDst = paths.getKnowledgeBaseDir(app);
    const configPath = getConfigFilePath(app);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pull-'));
    try {
      // 保存下载的 zip 文件
      const zipPath = path.join(tmp, 'master.zip');
      fs.writeFileSync(zipPath, response.data);

      const zip = new AdmZip(zipPath);
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

        // 拉取 user_config.json（AI API Key 等全局配置）
        let configSynced = false;
        const remoteConfigPath = path.join(tmp, 'user_config.json');
        if (configPath && fs.existsSync(remoteConfigPath)) {
          try {
            // 远程配置存在，复制到本地
            const remoteCfg = JSON.parse(fs.readFileSync(remoteConfigPath, 'utf8'));
            const localCfg = configStore ? configStore.load() : null;
            // 只同步 AI 相关配置字段（text_model_profiles, image_model_profiles），保留本地 account/analytics 等用户专属数据
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
            // 配置拉取失败不影响文档同步结果
          }
        }

        return {
          ok: true,
          merged_documents: merged,
          skipped_documents: skipped,
          config_synced: configSynced,
        };
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
