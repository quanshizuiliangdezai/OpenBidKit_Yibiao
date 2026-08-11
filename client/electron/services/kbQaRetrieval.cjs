/**
 * 知识库问答 RAG 语义检索服务（纯客户端实现）。
 *
 * 工作原理：
 * 1. 从服务器只读语料接口拉取 团队库/个人库 全部文档正文
 *    （GET /api/kb-qa/corpus、GET /api/personal/kb-qa/corpus）。
 * 2. 文档切块（约 700 字/块，80 字重叠），调用用户配置的 embedding 模型
 *    （OpenAI 兼容 /embeddings，经 aiService.embed）向量化。
 * 3. 向量缓存进本地 better-sqlite3 表 kb_qa_chunk_index（content_hash 增量重建，
 *    换 embedding 模型自动全量重建）。
 * 4. 问题向量化后按余弦相似度召回 topK 块，按文档聚合返回，
 *    返回结构与 /api/kb-qa/team 的 KbQaDocument 兼容（含 content_text）。
 *
 * 未配置 embedding 模型时 retrieveContext 抛错，由调用方（KbQaPage）
 * 回退到原关键词检索，保证问答功能永远可用。
 */

const crypto = require('node:crypto');

const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 80;
const EMBED_BATCH_SIZE = 10;
const MAX_DOC_CHARS = 30000;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf-8').digest('hex');
}

/** 简单滑窗切块：约 CHUNK_SIZE 字一块，相邻块重叠 CHUNK_OVERLAP 字。 */
function chunkText(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= CHUNK_SIZE) return [normalized];
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + CHUNK_SIZE, normalized.length);
    // 尽量在换行/句号处断开，避免把句子切碎。
    if (end < normalized.length) {
      const window = normalized.slice(start, end);
      const lastBreak = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('；'));
      if (lastBreak > CHUNK_SIZE * 0.5) {
        end = start + lastBreak + 1;
      }
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks.filter(Boolean);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function createKbQaRetrievalService({ db, aiService, kbAuthService }) {
  const api = kbAuthService.apiFetch.bind(kbAuthService);

  // ---- 语料拉取 ----

  async function fetchCorpus(source) {
    const path = source === 'team' ? '/api/kb-qa/corpus' : '/api/personal/kb-qa/corpus';
    const { ok, status, data } = await api(path);
    if (!ok) throw new Error(`拉取知识库语料失败（${status}）`);
    const docs = Array.isArray(data?.data) ? data.data : [];
    return docs.map((doc) => {
      const title = doc.title || doc.file_name || '';
      const body = String(doc.content_text || '').trim();
      // 把标题注入正文前，避免用户按文档名提问时语义检索只扫正文而漏召回。
      const contentText = body
        ? `文档标题：${title}\n\n${body}`.slice(0, MAX_DOC_CHARS)
        : `文档标题：${title}`;
      return {
        id: String(doc.id),
        title,
        file_name: doc.file_name || '',
        folder_id: doc.folder_id ?? null,
        created_at: doc.created_at || '',
        content_text: contentText,
      };
    });
  }

  // ---- 索引维护（增量：content_hash + embedding_model 变化才重建）----

  function getEmbeddingModelName() {
    // 语义检索复用文本模型：embedding 模型名可能直接来自文本模型的 model_name
    if (typeof aiService.getEmbeddingModelName === 'function') {
      return aiService.getEmbeddingModelName() || '';
    }
    const config = aiService.getConfig();
    const emb = config?.embedding_model || {};
    return String(emb.model_name || config?.model_name || '').trim();
  }

  async function syncIndexForSource(source, docs) {
    const modelName = getEmbeddingModelName();
    const existingRows = db
      .prepare('SELECT DISTINCT document_id, content_hash, embedding_model FROM kb_qa_chunk_index WHERE source = ?')
      .all(source);
    const existingByDoc = new Map(existingRows.map((row) => [String(row.document_id), row]));
    const aliveDocIds = new Set(docs.map((doc) => doc.id));

    // 1. 清理已删除的文档索引
    const deleteDocStmt = db.prepare('DELETE FROM kb_qa_chunk_index WHERE source = ? AND document_id = ?');
    for (const row of existingRows) {
      if (!aliveDocIds.has(String(row.document_id))) {
        deleteDocStmt.run(source, row.document_id);
      }
    }

    // 2. 找出需要（重新）向量化的文档
    const pendingDocs = [];
    for (const doc of docs) {
      if (!doc.content_text.trim()) continue;
      const hash = sha256(`${modelName}\n${doc.content_text}`);
      const existing = existingByDoc.get(doc.id);
      if (existing && existing.content_hash === hash && existing.embedding_model === modelName) continue;
      pendingDocs.push({ ...doc, hash });
    }
    if (!pendingDocs.length) return { indexed: 0 };

    // 3. 切块 + 分批 embedding + 落库
    const insertStmt = db.prepare(
      'INSERT INTO kb_qa_chunk_index (source, document_id, title, chunk_index, content, content_hash, embedding_json, embedding_model, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    let indexed = 0;
    for (const doc of pendingDocs) {
      const chunks = chunkText(doc.content_text);
      if (!chunks.length) continue;
      const vectors = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const batchVectors = await aiService.embed(batch);
        vectors.push(...batchVectors);
      }
      const now = new Date().toISOString();
      const writeDoc = db.transaction(() => {
        deleteDocStmt.run(source, doc.id);
        chunks.forEach((chunk, index) => {
          insertStmt.run(source, doc.id, doc.title, index, chunk, doc.hash, JSON.stringify(vectors[index]), modelName, now);
        });
      });
      writeDoc();
      indexed += 1;
    }
    return { indexed };
  }

  // ---- 语义召回 ----

  async function retrieveContext(question, options = {}) {
    const query = String(question || '').trim();
    if (!query) return { docs: [] };
    if (!aiService.isEmbeddingAvailable()) {
      throw new Error('未配置知识库语义检索模型');
    }
    const sources = Array.isArray(options.sources) && options.sources.length
      ? options.sources.filter((s) => s === 'team' || s === 'personal')
      : ['team', 'personal'];
    const topK = Number(options.topK) > 0 ? Math.min(Number(options.topK), 20) : 6;
    const maxDocs = Number(options.maxDocs) > 0 ? Math.min(Number(options.maxDocs), 10) : 4;

    // 1. 拉语料并同步索引（单个库失败不阻塞另一个库）
    const corpusErrors = [];
    for (const source of sources) {
      try {
        const docs = await fetchCorpus(source);
        await syncIndexForSource(source, docs);
      } catch (error) {
        corpusErrors.push(`${source === 'team' ? '团队库' : '个人库'}：${error?.message || String(error)}`);
      }
    }

    // 2. 加载候选块
    const placeholders = sources.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT source, document_id, title, chunk_index, content, embedding_json FROM kb_qa_chunk_index WHERE source IN (${placeholders})`)
      .all(...sources);
    if (!rows.length) {
      if (corpusErrors.length === sources.length) {
        throw new Error(`语义检索失败：${corpusErrors.join('；')}`);
      }
      return { docs: [] };
    }

    // 3. 问题向量化 + 余弦相似度排序
    const [queryVector] = await aiService.embed([query]);
    const scored = [];
    for (const row of rows) {
      let vector = null;
      try {
        vector = JSON.parse(row.embedding_json);
      } catch {
        continue;
      }
      if (!Array.isArray(vector) || !vector.length) continue;
      scored.push({ ...row, score: cosineSimilarity(queryVector, vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);

    // 4. 按文档聚合（块按原文顺序拼接），限制文档数
    const byDoc = new Map();
    for (const item of top) {
      const key = `${item.source}:${item.document_id}`;
      if (!byDoc.has(key)) {
        if (byDoc.size >= maxDocs) continue;
        byDoc.set(key, { source: item.source, document_id: item.document_id, title: item.title, score: item.score, chunks: [] });
      }
      byDoc.get(key).chunks.push(item);
    }
    const docs = [...byDoc.values()].map((doc) => {
      doc.chunks.sort((a, b) => a.chunk_index - b.chunk_index);
      return {
        id: doc.document_id,
        title: doc.title || '',
        file_name: doc.title || '',
        content_text: doc.chunks.map((chunk) => chunk.content).join('\n……\n'),
        score: doc.score,
        qa_source: doc.source,
      };
    });
    return { docs, warnings: corpusErrors };
  }

  /** 清空指定来源（或全部）的向量索引缓存。 */
  function clearIndex(source) {
    if (source === 'team' || source === 'personal') {
      db.prepare('DELETE FROM kb_qa_chunk_index WHERE source = ?').run(source);
    } else {
      db.prepare('DELETE FROM kb_qa_chunk_index').run();
    }
    return { success: true };
  }

  return {
    retrieveContext,
    clearIndex,
  };
}

module.exports = { createKbQaRetrievalService };
