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
    row = db.prepare('SELECT base_url, api_key, analysis_model, qa_model, embedding_model FROM model_config WHERE id=1').get();
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
const taskStates = new Map(); // documentId -> { status, progress, message, updatedAt }
function makeFakeWebContents(documentId) {
  return {
    isDestroyed: () => false,
    send: (channel, payload) => {
      if (channel === 'knowledge-base:event' && payload && payload.document) {
        const d = payload.document;
        taskStates.set(String(documentId), {
          status: d.status || 'pending',
          progress: d.progress || 0,
          message: d.message || '',
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
  const fakeWc = makeFakeWebContents(documentId);
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
    if (finalStatus === 'success') {
      taskStates.set(String(documentId), { status: 'success', progress: 100, message: '分析完成，已同步服务器', updatedAt: new Date().toISOString() });
    } else {
      // 管线内部失败（如筛选后无正文），透传真实错误状态与消息。
      taskStates.set(String(documentId), {
        status: finalStatus === 'error' ? 'error' : (finalStatus || 'error'),
        progress: finalDoc && finalDoc.progress || 0,
        message: (finalDoc && (finalDoc.message || finalDoc.error)) || '分析未成功完成',
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
      const st = taskStates.get(id) || { status: 'unknown', progress: 0, message: '无任务记录' };
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
  console.log(`[worker] 模型配置 base_url=${readModelConfig().base_url} model=${readModelConfig().model_name}`);
});
