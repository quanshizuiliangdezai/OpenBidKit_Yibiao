#!/usr/bin/env node
// ============================================================
// 知识库分析 Worker（服务器侧独立 Node 进程）
// 直接复用客户端原分析逻辑（knowledgeBaseService / aiService / fileService 等），
// 不重写算法，仅通过 app-stub 与 config 适配器解耦 Electron。
// 职责：收到「分析某文档」任务后在服务器跑原生分析管线，结果回写服务器 kb_analysis。
// ============================================================
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const { createAppStub } = require('./app-stub.cjs');

// ---------------- 配置 ----------------
const DATA_DIR = process.env.KB_WORKER_DATA || '/toubiao/yibiao-kb-worker/data';
const KB_DB = process.env.KB_DB || '/toubiao/yibiao-kb-server/kb.sqlite';
const KB_DATA_DIR = process.env.KB_DATA_DIR || '/toubiao/yibiao-kb-server/knowledge-base';
// 个人库（master.sqlite）：文档按 folders/<fid>/documents/<did>/<filename> 存储，主键 TEXT document_id
const MASTER_DB = process.env.YIBIAO_MASTER_DB || '/toubiao/yibiao-master/master.sqlite';
const MASTER_KB = process.env.YIBIAO_MASTER_KB || '/toubiao/yibiao-master/knowledge-base';
const SERVER_URL = process.env.KB_SERVER_URL || 'http://127.0.0.1:15004';
const KB_USER = process.env.KB_USER || 'admin';
const KB_PASS = process.env.KB_PASS || '';
const WORKER_PORT = parseInt(process.env.KB_WORKER_PORT || '15006', 10);

fs.mkdirSync(DATA_DIR, { recursive: true });
const app = createAppStub(DATA_DIR);

// ---------------- 模型配置适配器（替代原 configStore，零改 aiService）----------------
// 直接读服务器 kb.sqlite 的 model_config 表（与 server.py 共用同一份配置）。
let _modelCache = null;
let _modelCacheAt = 0;
function readModelConfig() {
  const now = Date.now();
  if (_modelCache && now - _modelCacheAt < 30000) return _modelCache; // 30s 缓存
  let row = null;
  try {
    const db = new Database(KB_DB, { readonly: true, fileMustExist: true });
    row = db.prepare('SELECT base_url, api_key, analysis_model, qa_model, embedding_model, '
                     + 'file_parser_provider, pdf_image_parser_provider, mineru_token FROM model_config WHERE id=1').get();
    db.close();
  } catch (e) {
    console.warn('[worker] 读取 model_config 失败，使用默认值:', e.message);
  }
  const cfg = {
    base_url: (row && row.base_url) || 'http://127.0.0.1:15005/v1',
    api_key: (row && row.api_key) || '',
    model_name: (row && row.analysis_model) || 'sensenova-6.7-flash-lite',
    // aiService 可能读取的其它字段，给安全默认值
    image_model: { provider: 'custom', model_name: '', base_url: '', api_key: '' },
    embedding_model: row && row.embedding_model ? { model_name: row.embedding_model } : null,
    text_model_provider: 'custom',
    temperature_enabled: false,
    temperature: 0,
    reasoning_effort: null,
    context_length_limit: 400000,
    developer_mode: false,
    analytics_client_id: 'worker',
    analytics_created_at: new Date().toISOString(),
    // 文件解析方式：优先读环境变量（便于不改库快速切换），其次读 model_config 表
    // （与客户端「模型配置」侧边栏「应用到服务器」共用），默认 local。
    // mineru-accurate-api / mineru-agent-api 走 MinerU 云端 OCR，可解析扫描件/图片/Office 等本地解析不支持的文档。
    components: (() => {
      const envProvider = (process.env.KB_FILE_PARSER_PROVIDER || '').trim();
      const envToken = (process.env.KB_MINERU_TOKEN || '').trim();
      const dbProvider = (row && row.file_parser_provider) || 'local';
      const dbPdfImageProvider = (row && row.pdf_image_parser_provider) || dbProvider || 'local';
      const dbToken = (row && row.mineru_token) || '';
      const fileParserProvider = envProvider || dbProvider || 'local';
      // 环境变量优先整体覆盖（保留旧行为：KB_FILE_PARSER_PROVIDER 一键切换全局）；
      // 未设环境变量时，office 端用 file_parser_provider，pdf/图片端用独立的 pdf_image_parser_provider。
      const fileParserPdfImageProvider = envProvider || dbPdfImageProvider || 'local';
      const fileParserToken = envToken || dbToken || '';
      const validProviders = ['local', 'mineru-accurate-api', 'mineru-agent-api'];
      return {
        file_parser: {
          provider: validProviders.includes(fileParserProvider) ? fileParserProvider : 'local',
          office_provider: validProviders.includes(fileParserProvider) ? fileParserProvider : 'local',
          pdf_image_provider: validProviders.includes(fileParserPdfImageProvider) ? fileParserPdfImageProvider : 'local',
          mineru_token: fileParserToken,
        },
      };
    })(),
  };
  _modelCache = cfg;
  _modelCacheAt = now;
  return cfg;
}
const configStore = {
  load: () => readModelConfig(),
  save: () => { throw new Error('worker 只读模型配置'); },
  getConfigFilePath: () => path.join(DATA_DIR, 'model-config.json'),
};

// ---------------- 组装原分析服务（逻辑零改）----------------
const { createAiService } = require('./services/aiService.cjs');
const { createSqliteDatabase } = require('./services/sqliteDatabase.cjs');
const { createKnowledgeBaseStore } = require('./services/knowledgeBaseStore.cjs');
const { createKbAuthService } = require('./services/kbAuthService.cjs');
const { createKbTeamService } = require('./services/kbTeamService.cjs');
const { createKnowledgeBaseService } = require('./services/knowledgeBaseService.cjs');

const aiService = createAiService({ app, configStore });
const dbHandle = createSqliteDatabase(app, { databasePath: path.join(DATA_DIR, 'workspace', 'yibiao.sqlite') });
const knowledgeBaseStore = createKnowledgeBaseStore({ app, db: dbHandle.db });
const kbAuthService = createKbAuthService({ app });
const kbTeamService = createKbTeamService({ kbAuthService, app });

const kbService = createKnowledgeBaseService({
  app,
  aiService,
  configStore,
  knowledgeBaseStore,
  kbTeamService,
});

// ---------------- 登录服务器（saveAnalysis 需要 Bearer 令牌）----------------
async function ensureLogin() {
  try {
    // 注册重登凭据：Worker 长驻、单次分析可能跑数分钟，启动时 token 会过期。
    // apiFetch 遇 401 时凭此自动重登重试，保证长跑后回写 kb_analysis 仍成功。
    if (kbAuthService.setReloginCredentials) {
      kbAuthService.setReloginCredentials({ username: KB_USER, password: KB_PASS, serverUrl: SERVER_URL });
    }
    // login 成功返回 { success: true, employee }，token 写入 kbAuthService 内部 state（apiFetch 自动携带）。
    // 不能靠 res.token 判断（该字段不存在），用 success + isLoggedIn() 双重确认。
    const res = await kbAuthService.login({ username: KB_USER, password: KB_PASS, serverUrl: SERVER_URL });
    if (res && res.success && kbAuthService.isLoggedIn()) {
      console.log('[worker] 已登录服务器', SERVER_URL, '用户', KB_USER, 'token=', String(kbAuthService.getToken() || '').slice(0, 8) + '…');
      return true;
    }
    console.error('[worker] 登录失败：', res);
  } catch (e) {
    console.error('[worker] 登录异常：', e.message);
  }
  return false;
}

// ---------------- 进度收集（替代 webContents.send）----------------
// 用一个伪 webContents 对象捕获进度事件，写入内存状态表，供 /status 轮询。
const taskStates = new Map(); // documentId -> { status, progress, message, item_count, ... , updatedAt }

// 从分析进度事件/终态结果里提取统计字段（原始分析逻辑会随事件携带这些数字）
function pickStats(doc) {
  if (!doc) {
    return { item_count: 0, candidate_item_count: 0, block_count: 0, filtered_block_count: 0 };
  }
  return {
    item_count: doc.item_count || doc.final_item_count || 0,
    candidate_item_count: doc.candidate_item_count || 0,
    block_count: doc.block_count || 0,
    filtered_block_count: doc.filtered_block_count || 0,
  };
}

// 实时从 Worker 自己的 SQLite（yibiao.sqlite）读真实条目/块统计。
// 原因：kb_service 在「切块/提取/匹配」阶段的多次 updateDocument 不带 item_count/candidate_item_count/block_count，
// 且 saveCandidateItems 内部 updateDocument 又不传 webContents，导致 taskStates 长期为 0。
// 注意：这些表在 Worker 进程的 SQLite（yibiao.sqlite）里，不在 kb.sqlite 里。
function readRealStats(documentId, libraryType) {
  try {
    // knowledgeBaseStore 是用 Worker 自己的 SQLite（yibiao.sqlite）初始化的
    const items = knowledgeBaseStore.readItems(documentId);
    const candidateItems = knowledgeBaseStore.readCandidateItems(documentId);
    const blocks = knowledgeBaseStore.readBlocks(documentId);
    const filteredBlocks = knowledgeBaseStore.readFilteredBlocks(documentId);
    return {
      item_count: Array.isArray(items) ? items.length : 0,
      candidate_item_count: Array.isArray(candidateItems) ? candidateItems.length : 0,
      block_count: Array.isArray(blocks) ? blocks.length : 0,
      filtered_block_count: Array.isArray(filteredBlocks) ? filteredBlocks.length : 0,
    };
  } catch {
    return null;
  }
}

function makeFakeWebContents(documentId, libraryType) {
  return {
    isDestroyed: () => false,
    send: (channel, payload) => {
      if (channel === 'knowledge-base:event' && payload && payload.document) {
        const d = payload.document;
        const s = pickStats(d);
        // 提取/匹配阶段实时回查 Worker SQLite 真实条目/块数
        if (d.status === 'extracting' || d.status === 'analyzing' || d.status === 'matching' || d.status === 'recovering' || d.status === 'ready_for_matching') {
          const real = readRealStats(documentId, libraryType);
          if (real) {
            if (real.item_count > s.item_count) s.item_count = real.item_count;
            if (real.candidate_item_count > s.candidate_item_count) s.candidate_item_count = real.candidate_item_count;
            if (real.block_count > s.block_count) s.block_count = real.block_count;
            if (real.filtered_block_count > s.filtered_block_count) s.filtered_block_count = real.filtered_block_count;
          }
        }
        taskStates.set(String(documentId), {
          status: d.status || 'pending',
          progress: d.progress || 0,
          message: d.message || '',
          item_count: s.item_count,
          candidate_item_count: s.candidate_item_count,
          block_count: s.block_count,
          filtered_block_count: s.filtered_block_count,
          updatedAt: new Date().toISOString(),
        });
      }
    },
  };
}

// ---------------- 任务队列 ----------------
const queue = [];
let running = 0;
const MAX_CONCURRENCY = parseInt(process.env.KB_WORKER_CONCURRENCY || '3', 10);

async function resolveDocumentMeta(documentId, libraryType) {
  if (libraryType === 'personal') {
    // 个人库：master.sqlite，主键 TEXT document_id；列名与团队库不同
    const db = new Database(MASTER_DB, { readonly: true, fileMustExist: true });
    const row = db.prepare(
      'SELECT document_id AS id, folder_id, file_name, file_name AS title FROM knowledge_documents WHERE document_id=?'
    ).get(String(documentId));
    db.close();
    return row;
  }
  const db = new Database(KB_DB, { readonly: true, fileMustExist: true });
  const row = db.prepare('SELECT id, folder_id, file_name, title FROM knowledge_documents WHERE id=?').get(documentId);
  db.close();
  return row;
}

function resolveDocumentFile(documentId, libraryType, meta) {
  if (libraryType === 'personal') {
    // 个人库文件路径：MASTER_KB/folders/<fid>/documents/<did>/<filename>
    if (!meta || meta.folder_id == null) return null;
    const fname = meta.file_name || meta.title;
    if (!fname) return null;
    const p = path.join(MASTER_KB, 'folders', String(meta.folder_id), 'documents', String(documentId), fname);
    return fs.existsSync(p) ? p : null;
  }
  // 团队库：文件以 doc_id 命名扁平存于 KB_DATA_DIR 下
  const p = path.join(KB_DATA_DIR, String(documentId));
  return fs.existsSync(p) ? p : null;
}

async function runTask(task) {
  const { documentId, libraryType } = task;
  const fakeWc = makeFakeWebContents(documentId, libraryType || 'team');
  taskStates.set(String(documentId), { status: 'pending', progress: 0, message: '排队中', updatedAt: new Date().toISOString() });
  try {
    // 先取元数据：个人库文件定位依赖 folder_id + file_name，必须先查 meta。
    const meta = await resolveDocumentMeta(documentId, libraryType);
    const filePath = resolveDocumentFile(documentId, libraryType, meta);
    if (!filePath) {
      taskStates.set(String(documentId), { status: 'error', progress: 0, message: '服务器未找到文档文件', updatedAt: new Date().toISOString() });
      return;
    }
    const folderId = meta ? meta.folder_id : 0;
    const fileName = meta ? (meta.file_name || meta.title || String(documentId)) : String(documentId);
    taskStates.set(String(documentId), { status: 'pending', progress: 0, message: '开始分析', updatedAt: new Date().toISOString() });
    // 服务器文件以 doc_id 命名、无扩展名；分析管线按扩展名选解析器，这里临时复制一份带正确扩展名。
    const ext = path.extname(fileName) || '';
    const stagedPath = ext ? path.join(DATA_DIR, 'stage', `${documentId}${ext}`) : filePath;
    if (ext) {
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      fs.copyFileSync(filePath, stagedPath);
    }
    // 用 await 版：等整条分析管线（转 MD→切块→抽取→saveAnalysis 回写服务器）真正跑完再返回。
    const finalDoc = await kbService.analyzeExternalFileAwait(documentId, stagedPath, fileName, folderId, fakeWc, libraryType || 'team');
    const finalStatus = finalDoc && finalDoc.status;
    const s = pickStats(finalDoc);
    if (finalStatus === 'success') {
      taskStates.set(String(documentId), {
        status: 'success', progress: 100, message: '分析完成，已同步服务器',
        item_count: s.item_count, candidate_item_count: s.candidate_item_count,
        block_count: s.block_count, filtered_block_count: s.filtered_block_count,
        updatedAt: new Date().toISOString(),
      });
    } else {
      // 管线内部失败（如筛选后无正文），透传真实错误状态与消息。
      taskStates.set(String(documentId), {
        status: finalStatus === 'error' ? 'error' : (finalStatus || 'error'),
        progress: finalDoc && finalDoc.progress || 0,
        message: (finalDoc && (finalDoc.message || finalDoc.error)) || '分析未成功完成',
        item_count: s.item_count, candidate_item_count: s.candidate_item_count,
        block_count: s.block_count, filtered_block_count: s.filtered_block_count,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[worker] 分析失败 doc', documentId, err);
    taskStates.set(String(documentId), { status: 'error', progress: 0, message: err?.message || String(err), updatedAt: new Date().toISOString() });
  }
}

function pump() {
  while (running < MAX_CONCURRENCY && queue.length > 0) {
    const task = queue.shift();
    running += 1;
    runTask(task).finally(() => { running -= 1; pump(); });
  }
}

function enqueue(documentId, libraryType) {
  const key = String(documentId);
  const existing = taskStates.get(key);
  if (existing && (existing.status === 'pending' || existing.status === 'analyzing')) {
    return { accepted: false, reason: '已在分析中' };
  }
  queue.push({ documentId: key, libraryType });
  pump();
  return { accepted: true };
}

// ---------------- HTTP 接口 ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${WORKER_PORT}`);
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };
  try {
    if (req.method === 'POST' && url.pathname === '/analyze') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { documentId, libraryType } = JSON.parse(body || '{}');
      if (!documentId) return send(400, { error: '缺少 documentId' });
      const r = enqueue(documentId, libraryType);
      return send(r.accepted ? 200 : 409, r);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/status/')) {
      const id = url.pathname.split('/status/')[1];
      // 1. 优先读 Worker 本地 SQLite 的真实文档状态（比内存 taskStates 更准，
      //    因为分析管线内的 updateDocument 不一定每次都会触发 webContents 事件）。
      let st = null;
      try {
        const localDoc = knowledgeBaseStore.getDocument(id);
        if (localDoc) {
          const real = readRealStats(id, 'team') || {};
          st = {
            status: localDoc.status || 'pending',
            progress: typeof localDoc.progress === 'number' ? localDoc.progress : 0,
            message: localDoc.message || '',
            item_count: localDoc.item_count || real.item_count || 0,
            candidate_item_count: localDoc.candidate_item_count || real.candidate_item_count || 0,
            block_count: localDoc.block_count || real.block_count || 0,
            filtered_block_count: localDoc.filtered_block_count || real.filtered_block_count || 0,
            updatedAt: localDoc.updated_at || new Date().toISOString(),
          };
        }
      } catch (e) { /* 无本地记录时忽略 */ }
      // 2. Worker 本地没有 / 非 success → 查 kb.sqlite 看是否已完成
      if (!st || st.status !== 'success') {
        try {
          const db = new Database(KB_DB, { readonly: true, fileMustExist: false });
          const row = db.prepare(
            'SELECT status, item_count, block_count, updated_at '
            + 'FROM kb_analysis WHERE document_id=?'
          ).get(parseInt(id, 10));
          db.close();
          if (row && row.status === 'success') {
            st = {
              status: 'success',
              progress: 100,
              message: '分析完成，已同步服务器',
              item_count: row.item_count || 0,
              candidate_item_count: 0,
              block_count: row.block_count || 0,
              filtered_block_count: 0,
              updatedAt: row.updated_at || new Date().toISOString(),
            };
          }
        } catch (e) { /* kb.sqlite 不可读时忽略 */ }
      }
      // 3. 都没有
      if (!st) st = taskStates.get(id) || { status: 'pending', progress: 0, message: '尚未分析' };
      return send(200, { documentId: id, ...st });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, { ok: true, queue: queue.length, running });
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    return send(500, { error: e.message });
  }
});

server.listen(WORKER_PORT, async () => {
  console.log(`[worker] 分析 Worker 已启动：端口 ${WORKER_PORT}，数据目录 ${DATA_DIR}`);
  await ensureLogin();
  const cfg = readModelConfig();
  console.log(`[worker] 模型配置 base_url=${cfg.base_url} model=${cfg.model_name}`);
  console.log(`[worker] 文件解析方式：${cfg.components?.file_parser?.provider || 'local'}（复用客户端本地解析逻辑）`);
});
