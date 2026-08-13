/**
 * qaAgent —— 知识库问答的 Agentic RAG 引擎（P1 改造核心）。
 *
 * 设计要点：
 * - 不用 OpenAI 原生 function-calling（aiClient.chat 只返回字符串、底层不支持 tools）。
 * - 改用 aiClient.requestJson（response_format=json_object）+ 强 prompt 约束，让模型每轮输出
 *   「思考 + 动作」JSON；前端解析后执行对应工具（检索/澄清/作答），再把结果回灌下一轮。
 * - 所有检索工具复用现有 IPC：kbQa.retrieveContext（语义）/ kbTeam.qaRetrieve / kbPersonal.qaRetrieve（关键词）。
 * - 多步过程对上层可见（onStep / onStage），避免「卡死」错觉。
 *
 * 后续 P2（关联扩展）/ P3（图谱 graph_lookup）会在 searchTool 内增强，无需改此处循环骨架。
 */

import { aiClient } from '../../../shared/ai/aiClient';
import type { ChatMessage, KbQaDocument, KbQaMessageSource } from '../../../shared/types';

export type QaAgentAction =
  | 'search_team'
  | 'search_personal'
  | 'search_both'
  | 'graph_lookup'
  | 'clarify'
  | 'answer';

export interface QaAgentDecision {
  thought: string;
  action: QaAgentAction;
  query?: string;
  scope?: 'team' | 'personal' | 'both';
  question?: string;
  answer?: string;
  citations?: number[];
}

export type QaAgentSource = 'team' | 'personal' | 'both';

export type QaAgentStage = 'thinking' | 'retrieving' | 'generating';

export interface QaAgentStep {
  step: number;
  thought: string;
  action: QaAgentAction;
  query?: string;
  retrieved?: number;
}

export interface QaAgentResult {
  /** 最终综合回答（action=answer 时） */
  answer: string;
  /** 引用的知识库来源 */
  sources: KbQaMessageSource[];
  /** 多步推理轨迹（用于 UI 展示） */
  steps: QaAgentStep[];
  /** 需要向用户追问（action=clarify 时） */
  needClarify?: string;
  /** 完全未检索到任何文档 → 上层应回退通用聊天 */
  empty?: boolean;
}

const MAX_STEPS = 6;
const MAX_CHARS_PER_DOC = 2500;

const SYSTEM_PROMPT = `你是易标投标工具箱的「知识库问答 Agent」。任务：基于团队/个人知识库内容，通过多步推理回答用户问题。

你可以循环执行以下动作，直到能完整回答：
- search_team：在团队知识库检索相关文档（必须给 query）
- search_personal：在个人知识库检索（必须给 query）
- search_both：同时在两个库检索（必须给 query）
- graph_lookup：在知识图谱中检索与问题相关的实体及其关系网络，返回关联文档与关系路径（必须给 query）。适合跨文档关联、实体关系类问题（如「A 和 B 是什么关系」「哪些文档提到了 X」）。若图谱为空则返回空，可回退 search_*。
- clarify：当用户问题含糊、缺少关键信息时，向用户提一个澄清问题（必须给 question）
- answer：已掌握足够信息，输出最终综合回答（必须给 answer，条理清晰，用 [n] 标注引用的文档序号）

每轮你**必须只输出一个 JSON 对象**，字段如下（action 不同时填对应必填项）：
{
  "thought": "这一步的推理（简短）",
  "action": "search_team|search_personal|search_both|graph_lookup|clarify|answer",
  "query": "检索关键词（search_* / graph_lookup 时必填）",
  "scope": "team|personal|both（可选，缺省按当前范围）",
  "question": "澄清问题（clarify 时必填）",
  "answer": "最终回答（answer 时必填）",
  "citations": [1, 2]（answer 时引用哪些文档序号）
}
不要输出 JSON 以外的任何文字。`;

const VALID_ACTIONS: QaAgentAction[] = [
  'search_team',
  'search_personal',
  'search_both',
  'graph_lookup',
  'clarify',
  'answer',
];

/** 把模型返回的（可能不规范的）JSON 归一化，避免单点字段缺失导致崩溃 */
function normalizeDecision(raw: unknown): QaAgentDecision {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const actionRaw = typeof obj.action === 'string' ? obj.action : 'answer';
  const action: QaAgentAction = VALID_ACTIONS.includes(actionRaw as QaAgentAction)
    ? (actionRaw as QaAgentAction)
    : 'answer';
  const scopeRaw = obj.scope;
  const scope: 'team' | 'personal' | 'both' | undefined =
    scopeRaw === 'team' || scopeRaw === 'personal' || scopeRaw === 'both'
      ? scopeRaw
      : undefined;
  const citations = Array.isArray(obj.citations)
    ? (obj.citations as unknown[])
        .map((n) => Number(n))
        .filter((n) => !Number.isNaN(n))
    : undefined;
  return {
    thought: typeof obj.thought === 'string' ? obj.thought : '',
    action,
    query: typeof obj.query === 'string' ? obj.query : undefined,
    scope,
    question: typeof obj.question === 'string' ? obj.question : undefined,
    answer: typeof obj.answer === 'string' ? obj.answer : undefined,
    citations,
  };
}

/**
 * 检索工具：语义检索优先，失败回退关键词检索。
 * P2 关联扩展、P3 graph_lookup 后续在此增强。
 */
async function searchTool(
  query: string,
  scope: 'team' | 'personal' | 'both',
): Promise<KbQaDocument[]> {
  const src: Array<'team' | 'personal'> =
    scope === 'both' ? ['team', 'personal'] : [scope];
  let docs: KbQaDocument[] = [];

  // 1) 语义检索优先
  try {
    const rag = await window.yibiao?.kbQa.retrieveContext(query, {
      sources: src,
      topK: 6,
      maxDocs: 4,
    });
    if (rag && rag.success && Array.isArray(rag.data) && rag.data.length > 0) {
      docs = rag.data;
    }
  } catch {
    /* 语义检索失败（如未配置 embedding），下方回退关键词检索 */
  }

  // 2) 回退：关键词检索
  if (docs.length === 0) {
    const [teamRes, personalRes] = await Promise.all([
      scope === 'team' || scope === 'both'
        ? window.yibiao?.kbTeam.qaRetrieve(query, 10)
        : Promise.resolve({ success: true, data: [] as KbQaDocument[] }),
      scope === 'personal' || scope === 'both'
        ? window.yibiao?.kbPersonal.qaRetrieve(query, 10)
        : Promise.resolve({ success: true, data: [] as KbQaDocument[] }),
    ]);
    const teamDocs: KbQaDocument[] = Array.isArray(teamRes?.data) ? teamRes.data : [];
    const personalDocs: KbQaDocument[] = Array.isArray(personalRes?.data)
      ? personalRes.data
      : [];
    const seen = new Set<string>();
    for (const d of [...teamDocs, ...personalDocs]) {
      const key = `${d.file_name || d.title}|${(d.content_text || '').slice(0, 200)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push(d);
    }
  }

  // 3) P2 关联扩展：文件夹同级 + bigram 共现（增强召回）
  if (docs.length > 0) {
    const scopes: Array<'team' | 'personal'> =
      scope === 'both' ? ['team', 'personal'] : [scope];
    const seen2 = new Set(docs.map((d) => String(d.id)));
    for (const sc of scopes) {
      try {
        const extra = await window.yibiao?.kbQa.expandRelated(docs, sc, 6);
        if (extra && extra.success && Array.isArray(extra.data)) {
          for (const d of extra.data) {
            if (!seen2.has(String(d.id))) {
              docs.push(d);
              seen2.add(String(d.id));
            }
          }
        }
      } catch {
        /* 关联扩展失败不影响主检索结果 */
      }
    }
  }

  return docs;
}

/**
 * P3 知识图谱检索工具：调用主进程 kbQa.graphFind 做子图遍历。
 * 返回关联文档（含片段）与关系路径；图谱为空或失败均返回空，由上层回退 search_*。
 */
async function graphLookupTool(
  query: string,
  source: 'team' | 'personal' | 'both',
): Promise<{
  docs: KbQaDocument[];
  graph: { entities: Array<{ name: string; type?: string }>; relations: Array<{ subject: string; predicate: string; object: string; evidence?: string }> };
}> {
  try {
    const res = await window.yibiao?.kbQa.graphFind(query, source, 8);
    if (res && res.success) {
      return {
        docs: Array.isArray(res.docs) ? res.docs : [],
        graph: res.graph || { entities: [], relations: [] },
      };
    }
  } catch {
    /* 图谱检索失败不影响其它检索工具 */
  }
  return { docs: [], graph: { entities: [], relations: [] } };
}

function formatGraph(graph: {
  entities: Array<{ name: string; type?: string }>;
  relations: Array<{ subject: string; predicate: string; object: string; evidence?: string }>;
}): string {
  if (!graph.relations.length) {
    return graph.entities.length ? `命中实体：${graph.entities.map((e) => e.name).join('、')}` : '（无）';
  }
  return graph.relations
    .map(
      (r) =>
        `- ${r.subject} ——${r.predicate}——> ${r.object}${r.evidence ? `（${r.evidence}）` : ''}`,
    )
    .join('\n');
}

function formatDocs(docs: KbQaDocument[], offset: number): string {
  return docs
    .map(
      (d, i) =>
        `[${offset + i + 1}] ${d.title}\n${(d.content_text || '').slice(0, MAX_CHARS_PER_DOC) || '(无正文)'}`,
    )
    .join('\n\n---\n\n');
}

function toSources(docs: KbQaDocument[]): KbQaMessageSource[] {
  return docs.map((d) => ({
    id: d.id,
    title: d.title,
    qa_source: d.qa_source,
  }));
}

/** 兜底：用已收集文档让模型做最后一次综合作答（走 chat，复用 RAG 式 prompt） */
async function synthesizeAnswer(docs: KbQaDocument[], question: string): Promise<string> {
  const refs = docs
    .map(
      (d, i) =>
        `[${i + 1}] ${d.title}\n${(d.content_text || '').slice(0, MAX_CHARS_PER_DOC) || '(无正文)'}`,
    )
    .join('\n\n---\n\n');
  const prompt = `你是标讯知识库问答助手。请严格根据下方参考资料回答问题。
如果资料中没有相关信息，请说明「根据现有资料无法回答」。回答要求：条理清晰、优先要点列表、准确引用关键数据/条款、不编造。

参考资料：
${refs}

用户问题：${question}`;
  try {
    const answer = await aiClient.chat({
      messages: [{ role: 'user', content: prompt }],
      timeout_ms: 120000,
      timeout_message: '生成回答超时，请稍后重试',
      logTitle: '知识库问答(Agent综合)',
    });
    return answer || '模型未返回内容';
  } catch {
    return '已检索到相关资料，但生成回答时模型服务异常，请稍后重试。';
  }
}

export interface RunQaAgentOptions {
  question: string;
  source: QaAgentSource;
  onStep?: (step: QaAgentStep) => void;
  onStage?: (stage: QaAgentStage) => void;
}

/**
 * 运行知识库问答 Agent：多步推理循环。
 * 返回最终结果（含多步轨迹、引用来源、是否需要追问、是否完全无文档）。
 */
export async function runQaAgent(opts: RunQaAgentOptions): Promise<QaAgentResult> {
  const { question, source, onStep, onStage } = opts;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `用户问题：${question}\n（当前知识库来源范围：${source}）`,
    },
  ];

  const collected = new Map<string, KbQaDocument>();
  const steps: QaAgentStep[] = [];

  for (let step = 0; step < MAX_STEPS; step += 1) {
    onStage?.('thinking');

    let decision: QaAgentDecision;
    try {
      const raw = await aiClient.requestJson({
        messages,
        response_format: { type: 'json_object' },
        logTitle: '知识库问答(Agent决策)',
      });
      decision = normalizeDecision(raw);
    } catch (err) {
      // 模型调用失败：已有文档则尽力综合，否则抛出由上层处理
      if (collected.size > 0) {
        onStage?.('generating');
        const answer = await synthesizeAnswer([...collected.values()], question);
        return { answer, sources: toSources([...collected.values()]), steps };
      }
      throw err;
    }

    const current: QaAgentStep = {
      step,
      thought: decision.thought,
      action: decision.action,
      query: decision.query,
    };
    steps.push(current);
    onStep?.(current);

    // clarify：向用户追问
    if (decision.action === 'clarify') {
      if (decision.question) {
        return { answer: '', sources: [], steps, needClarify: decision.question };
      }
      // 没给 question 却 clarify → 当作 answer 兜底
      decision.action = 'answer';
    }

    // answer：综合作答
    if (decision.action === 'answer') {
      onStage?.('generating');
      const docs = [...collected.values()];
      if (docs.length === 0) {
        // 没检索到任何文档却直接 answer → 标记 empty 由上层回退通用聊天
        return { answer: decision.answer || '', sources: [], steps, empty: true };
      }
      const answer = decision.answer || (await synthesizeAnswer(docs, question));
      const sources = docs.map((d) => ({ id: d.id, title: d.title, qa_source: d.qa_source }));
      return { answer, sources, steps };
    }

    // graph_lookup：知识图谱子图检索
    if (decision.action === 'graph_lookup') {
      const gq = decision.query || question;
      onStage?.('retrieving');
      const { docs: gDocs, graph } = await graphLookupTool(gq, source);
      const offset = collected.size;
      gDocs.forEach((d) => {
        const k = `${d.id}`;
        if (!collected.has(k)) collected.set(k, d);
      });
      current.retrieved = gDocs.length;
      const graphSummary = formatGraph(graph);
      messages.push({ role: 'assistant', content: JSON.stringify(decision) });
      messages.push({
        role: 'user',
        content:
          `知识图谱检索到 ${gDocs.length} 篇关联文档、${graph.entities.length} 个实体、${graph.relations.length} 条关系：\n`
          + `${graphSummary}\n`
          + (gDocs.length ? `关联文档：\n${formatDocs(gDocs, offset)}\n` : '（未命中具体文档）\n')
          + `\n请基于以上资料继续决策：可换关键词再检索、补充检索，或已足够则输出 answer。若资料仍不足，可 clarify 向用户追问。`,
      });
      continue;
    }

    // search_*：执行检索并回灌
    const query = decision.query || question;
    const scope: 'team' | 'personal' | 'both' =
      decision.scope ||
      (decision.action === 'search_team'
        ? 'team'
        : decision.action === 'search_personal'
          ? 'personal'
          : source);

    onStage?.('retrieving');
    const docs = await searchTool(query, scope);
    const offset = collected.size;
    docs.forEach((d) => {
      const k = `${d.id}`;
      if (!collected.has(k)) collected.set(k, d);
    });
    current.retrieved = docs.length;

    messages.push({ role: 'assistant', content: JSON.stringify(decision) });
    messages.push({
      role: 'user',
      content: `检索到 ${docs.length} 篇文档：\n${formatDocs(docs, offset)}\n\n请基于以上资料继续决策：可换关键词再检索、补充检索，或已足够则输出 answer。若资料仍不足，可 clarify 向用户追问。`,
    });
  }

  // 超出 MAX_STEPS：强制用已收集文档综合作答
  onStage?.('generating');
  const docs = [...collected.values()];
  if (docs.length === 0) {
    return { answer: '', sources: [], steps, empty: true };
  }
  const answer = await synthesizeAnswer(docs, question);
  return { answer, sources: toSources(docs), steps };
}
