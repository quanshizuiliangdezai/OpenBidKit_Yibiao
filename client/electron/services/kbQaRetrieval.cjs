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

  // ---- P2 轻量关联检索：文件夹同级 + bigram 共现扩展 ----
  function bigrams(text) {
    const t = String(text || '').replace(/\s+/g, '');
    const set = new Set();
    for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
    return set;
  }

  async function expandRelated(seedDocs, source, limit = 8) {
    if (!Array.isArray(seedDocs) || !seedDocs.length) return { docs: [] };
    const src = source === 'personal' ? 'personal' : 'team';
    let corpus;
    try {
      corpus = await fetchCorpus(src);
    } catch {
      return { docs: [] };
    }
    const seedIds = new Set(seedDocs.map((d) => String(d.id)));
    const seedFolders = new Set(
      seedDocs.map((d) => d.folder_id).filter((f) => f !== null && f !== undefined).map(String),
    );
    const seedBigrams = new Set();
    for (const d of seedDocs) {
      for (const g of bigrams(`${d.title} ${(d.content_text || '').slice(0, 2000)}`)) {
        seedBigrams.add(g);
      }
    }
    const scored = [];
    for (const doc of corpus) {
      if (seedIds.has(String(doc.id))) continue;
      let score = 0;
      if (doc.folder_id && seedFolders.has(String(doc.folder_id))) score += 3;
      const docBigrams = bigrams(`${doc.title} ${(doc.content_text || '').slice(0, 2000)}`);
      let overlap = 0;
      for (const g of docBigrams) if (seedBigrams.has(g)) overlap += 1;
      if (docBigrams.size) score += overlap / docBigrams.size;
      if (score > 0) scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const docs = scored.slice(0, limit).map(({ doc }) => ({
      id: doc.id,
      title: doc.title,
      file_name: doc.file_name || doc.title,
      content_text: doc.content_text,
      qa_source: src,
    }));
    return { docs };
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

  // ---- P3 知识图谱：实体/关系抽取 + 子图遍历检索 ----

  // 语料片段缓存（构建图谱时建立，graphFind 复用，避免每次检索都重新拉取服务器语料）
  const corpusSnippetCache = new Map(); // source -> Map(docId -> {title, snippet})

  function cacheCorpus(source, docs) {
    const map = new Map();
    for (const d of docs) {
      map.set(String(d.id), {
        title: d.title,
        snippet: String(d.content_text || '').slice(0, 2000),
      });
    }
    corpusSnippetCache.set(source, map);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /** 从问题中抽取关键实体（用于图谱检索的入口匹配）。失败时回退简单分词。 */
  async function extractQueryEntities(question) {
    const q = String(question || '').trim();
    if (!q) return [];
    try {
      const res = await aiService.requestJson({
        messages: [
          {
            role: 'system',
            content:
              '你负责从用户问题中抽取关键实体（人物、组织、产品、术语、概念、地点、事件、日期、金额、条款等）。'
              + '只输出 JSON：{"entities":["实体1","实体2",...]}，最多 8 个，保留原文关键名词，去掉停用词和疑问词。不要输出其它内容。',
          },
          { role: 'user', content: `问题：${q}` },
        ],
        response_format: { type: 'json_object' },
        timeout_ms: 60000,
        logTitle: '知识图谱(查询实体抽取)',
      });
      const arr = res && Array.isArray(res.entities) ? res.entities : [];
      return arr
        .map((e) => String(e).trim())
        .filter(Boolean)
        .slice(0, 8);
    } catch {
      const parts = q.split(/[\s，。、；：？！,.;:?!]+/).map((s) => s.trim()).filter(Boolean);
      return parts.length ? parts.slice(0, 8) : [q];
    }
  }

  /** 从单篇文档抽取三元组（subject-predicate-object）。失败返回空数组。 */
  async function extractTriples(text, title) {
    const t = String(text || '').slice(0, 5000);
    if (!t.trim()) return [];
    try {
      const res = await aiService.requestJson({
        messages: [
          {
            role: 'system',
            content:
              '你负责从文档中抽取知识三元组（实体-关系-实体），用于构建知识图谱。'
              + '聚焦投标/招标/标书领域。关系用简短中文动词短语（如：属于、要求、提供、负责、位于、依据、包含、关联）。'
              + '只输出 JSON：{"triples":[{"subject":"实体","predicate":"关系","object":"实体","evidence":"原文中支持该关系的简短原句（≤40字）"}]}，'
              + '最多 12 条，实体名简洁（≤20字），不要抽取无关内容。不要输出其它内容。',
          },
          { role: 'user', content: `文档标题：${title || ''}\n\n文档内容：\n${t}` },
        ],
        response_format: { type: 'json_object' },
        timeout_ms: 120000,
        logTitle: '知识图谱(三元组抽取)',
      });
      const arr = res && Array.isArray(res.triples) ? res.triples : [];
      return arr
        .map((tr) => ({
          subject: String(tr?.subject || '').trim(),
          predicate: String(tr?.predicate || '').trim(),
          object: String(tr?.object || '').trim(),
          evidence: String(tr?.evidence || '').trim(),
        }))
        .filter((tr) => tr.subject && tr.predicate && tr.object)
        .slice(0, 12);
    } catch {
      return [];
    }
  }

  /** 构建（重建）指定来源的知识图谱：拉语料 → 逐篇抽三元组 → 落库。支持进度回调。 */
  async function buildGraph(source, options = {}) {
    const src = source === 'personal' ? 'personal' : 'team';
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    onProgress({ phase: 'fetch', message: '正在拉取知识库语料…', done: 0, total: 0 });
    const docs = await fetchCorpus(src);
    const validDocs = docs.filter((d) => String(d.content_text || '').trim());
    cacheCorpus(src, docs);

    const entities = new Map(); // key=`${src}::${nameLower}` -> {name, type, aliases:Set, docIds:Set}
    const relations = new Map(); // key=`${src}::${s}::${p}::${o}` -> {subject,predicate,object,evidence,docIds:Set}
    const total = validDocs.length;
    let done = 0;

    for (const doc of validDocs) {
      const triples = await extractTriples(doc.content_text, doc.title);
      const docId = String(doc.id);
      for (const tr of triples) {
        for (const name of [tr.subject, tr.object]) {
          const key = `${src}::${name.toLowerCase()}`;
          if (!entities.has(key)) {
            entities.set(key, { name, type: 'CONCEPT', aliases: new Set(), docIds: new Set() });
          }
          entities.get(key).docIds.add(docId);
        }
        const rkey = `${src}::${tr.subject.toLowerCase()}::${tr.predicate}::${tr.object.toLowerCase()}`;
        if (!relations.has(rkey)) {
          relations.set(rkey, {
            subject: tr.subject,
            predicate: tr.predicate,
            object: tr.object,
            evidence: tr.evidence,
            docIds: new Set(),
          });
        }
        relations.get(rkey).docIds.add(docId);
      }
      done += 1;
      onProgress({
        phase: 'extract',
        message: `已分析 ${done}/${total} 篇文档，抽取 ${entities.size} 个实体 / ${relations.size} 条关系`,
        done,
        total,
      });
    }

    const now = nowIso();
    const writeTx = db.transaction(() => {
      db.prepare('DELETE FROM kb_graph_entity WHERE source = ?').run(src);
      db.prepare('DELETE FROM kb_graph_relation WHERE source = ?').run(src);
      const insE = db.prepare(
        'INSERT INTO kb_graph_entity (source, name, type, aliases_json, doc_count, mention_count, doc_ids_json, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const insR = db.prepare(
        'INSERT INTO kb_graph_relation (source, subject, predicate, object, evidence, doc_ids_json, doc_count, weight, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const e of entities.values()) {
        const docIds = [...e.docIds];
        insE.run(src, e.name, e.type, JSON.stringify([...e.aliases]), docIds.length, docIds.length, JSON.stringify(docIds), now, now);
      }
      for (const r of relations.values()) {
        const docIds = [...r.docIds];
        insR.run(src, r.subject, r.predicate, r.object, r.evidence, JSON.stringify(docIds), docIds.length, 1.0, now, now);
      }
    });
    writeTx();

    onProgress({
      phase: 'done',
      message: `图谱构建完成：${entities.size} 个实体 / ${relations.size} 条关系`,
      done: total,
      total,
    });
    return { entityCount: entities.size, relationCount: relations.size };
  }

  /** 单来源子图检索：抽取查询实体 → 匹配节点 → BFS 深度2 遍历 → 收集文档与关系路径。 */
  async function graphFindForSource(question, src, limit = 8) {
    const q = String(question || '').trim();
    if (!q) return { docs: [], graph: { entities: [], relations: [] }, empty: true };

    const entityRows = db
      .prepare('SELECT name, type, doc_ids_json FROM kb_graph_entity WHERE source = ?')
      .all(src);
    const relationRows = db
      .prepare('SELECT subject, predicate, object, evidence, doc_ids_json FROM kb_graph_relation WHERE source = ?')
      .all(src);
    if (!entityRows.length && !relationRows.length) {
      return { docs: [], graph: { entities: [], relations: [] }, empty: true };
    }

    const queryEntities = await extractQueryEntities(q);
    const lowerEntities = entityRows.map((e) => ({ ...e, lower: e.name.toLowerCase() }));

    // 匹配种子实体（精确 / 包含）
    const matchedSeeds = new Set();
    for (const qe of queryEntities) {
      const ql = qe.toLowerCase();
      for (const e of lowerEntities) {
        if (e.lower === ql || e.lower.includes(ql) || ql.includes(e.lower)) {
          matchedSeeds.add(e.name);
        }
      }
    }
    if (matchedSeeds.size === 0) {
      const ql = q.toLowerCase();
      for (const e of lowerEntities) {
        if (e.lower.includes(ql) || ql.includes(e.lower)) matchedSeeds.add(e.name);
      }
    }

    // BFS 子图遍历（深度 2）
    const visitedEntities = new Set(matchedSeeds);
    const visitedRelations = [];
    const queue = [...matchedSeeds];
    const depthOf = new Map([...matchedSeeds].map((n) => [n, 0]));
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head];
      head += 1;
      const curDepth = depthOf.get(cur) ?? 0;
      if (curDepth >= 2) continue;
      for (const r of relationRows) {
        if (r.subject === cur || r.object === cur) {
          visitedRelations.push(r);
          const next = r.subject === cur ? r.object : r.subject;
          if (!visitedEntities.has(next)) {
            visitedEntities.add(next);
            depthOf.set(next, curDepth + 1);
            queue.push(next);
          }
        }
      }
    }

    // 收集命中文档 id
    const docIds = new Set();
    const collectDocIds = (json) => {
      try {
        for (const id of JSON.parse(json || '[]')) docIds.add(String(id));
      } catch { /* ignore */ }
    };
    for (const r of visitedRelations) collectDocIds(r.doc_ids_json);
    for (const e of entityRows) {
      if (visitedEntities.has(e.name)) collectDocIds(e.doc_ids_json);
    }

    // 取文档片段（优先缓存）
    let snippetMap = corpusSnippetCache.get(src);
    if (!snippetMap) {
      const allDocs = await fetchCorpus(src);
      cacheCorpus(src, allDocs);
      snippetMap = corpusSnippetCache.get(src);
    }
    const docs = [];
    for (const id of docIds) {
      const meta = snippetMap?.get(id);
      if (meta) docs.push({ id, title: meta.title, file_name: meta.title, content_text: meta.snippet, qa_source: src });
    }
    docs.sort((a, b) => b.content_text.length - a.content_text.length);
    const limitedDocs = docs.slice(0, limit);

    const graphEntities = [...visitedEntities].map((name) => {
      const e = lowerEntities.find((x) => x.name === name);
      return { name, type: e?.type || 'CONCEPT' };
    });
    const graphRelations = visitedRelations.map((r) => ({
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      evidence: r.evidence,
    }));

    return {
      docs: limitedDocs,
      graph: { entities: graphEntities, relations: graphRelations },
      empty: limitedDocs.length === 0 && graphRelations.length === 0,
    };
  }

  /** 子图检索入口：支持 team/personal/both（both 时合并两个库的图谱结果）。 */
  async function graphFind(question, source, limit = 8) {
    const srcs = source === 'both' ? ['team', 'personal'] : [source === 'personal' ? 'personal' : 'team'];
    const allDocs = [];
    const allEntities = new Map();
    const allRelations = [];
    for (const src of srcs) {
      const r = await graphFindForSource(question, src, limit);
      for (const d of r.docs) {
        if (!allDocs.some((x) => x.id === d.id)) allDocs.push(d);
      }
      for (const e of r.graph.entities) {
        if (!allEntities.has(e.name)) allEntities.set(e.name, e);
      }
      allRelations.push(...r.graph.relations);
    }
    const seenR = new Set();
    const dedupRelations = [];
    for (const rel of allRelations) {
      const key = `${rel.subject}|${rel.predicate}|${rel.object}`;
      if (!seenR.has(key)) {
        seenR.add(key);
        dedupRelations.push(rel);
      }
    }
    return {
      docs: allDocs.slice(0, limit),
      graph: { entities: [...allEntities.values()], relations: dedupRelations },
      empty: allDocs.length === 0 && dedupRelations.length === 0,
    };
  }

  function graphStatus(source) {
    const srcs = source === 'both' ? ['team', 'personal'] : [source === 'personal' ? 'personal' : 'team'];
    let entityCount = 0;
    let relationCount = 0;
    for (const src of srcs) {
      const e = db.prepare('SELECT COUNT(*) AS c FROM kb_graph_entity WHERE source = ?').get(src);
      const r = db.prepare('SELECT COUNT(*) AS c FROM kb_graph_relation WHERE source = ?').get(src);
      entityCount += e?.c || 0;
      relationCount += r?.c || 0;
    }
    return { entityCount, relationCount };
  }

  function clearGraph(source) {
    const src = source === 'personal' ? 'personal' : 'team';
    db.prepare('DELETE FROM kb_graph_entity WHERE source = ?').run(src);
    db.prepare('DELETE FROM kb_graph_relation WHERE source = ?').run(src);
    corpusSnippetCache.delete(src);
    return { success: true };
  }

  return {
    retrieveContext,
    clearIndex,
    expandRelated,
    buildGraph,
    graphFind,
    graphStatus,
    clearGraph,
  };
}

module.exports = { createKbQaRetrievalService };
