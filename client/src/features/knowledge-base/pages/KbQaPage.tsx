import { useState } from 'react';
import InputWithAction from '../../../shared/ui/InputWithAction';
import MarkdownRenderer from '../../../shared/ui/MarkdownRenderer';
import { useToast } from '../../../shared/ui';
import { aiClient } from '../../../shared/ai/aiClient';
import type { KbQaDocument } from '../../../shared/types';

type QaSource = 'team' | 'personal' | 'both';

interface QaMessage {
  role: 'user' | 'assistant';
  content: string;
}

const QA_SYSTEM_PROMPT = `你是标讯知识库问答助手。请严格根据下方提供的参考资料回答问题。
如果资料中没有相关信息，请明确说明“根据现有资料无法回答”。
回答要求：
1. 条理清晰，优先使用要点列表；
2. 对关键数据、条款、要求要准确引用；
3. 如果资料有冲突，请指出并给出判断依据；
4. 不要编造参考资料中不存在的内容。`;

/** 每篇参考资料最多保留多少字符；总长度也有上限，避免把海量无关正文塞进 LLM 导致响应极慢。 */
const MAX_CHARS_PER_DOC = 2500;
const MAX_TOTAL_PROMPT_CHARS = 8000;

function buildPrompt(question: string, docs: KbQaDocument[]) {
  let totalChars = 0;
  const refs: string[] = [];
  for (let i = 0; i < docs.length; i += 1) {
    const d = docs[i];
    const text = (d.content_text || '').slice(0, MAX_CHARS_PER_DOC);
    totalChars += text.length + d.title.length + 20;
    if (totalChars > MAX_TOTAL_PROMPT_CHARS) {
      break;
    }
    refs.push(`[${i + 1}] ${d.title}\n${text || '(无正文)'}`);
  }
  return `${QA_SYSTEM_PROMPT}\n\n参考资料：\n\n${refs.join('\n\n---\n\n')}\n\n用户问题：${question}`;
}

function KbQaPage() {
  const [source, setSource] = useState<QaSource>('both');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<QaMessage[]>([
    {
      role: 'assistant',
      content: '你好！我可以基于团队知识库或个人知识库的内容帮你解答问题。请在下方输入问题，并选择知识库来源。',
    },
  ]);
  const [lastSources, setLastSources] = useState<KbQaDocument[]>([]);
  const [qaStage, setQaStage] = useState<'retrieving' | 'generating' | null>(null);
  const { showToast } = useToast();

  const handleAsk = async () => {
    const question = input.trim();
    if (!question) return;

    setLoading(true);
    setQaStage('retrieving');
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setInput('');

    try {
      // 1) RAG 语义检索优先：向量召回相关资料
      const sources: Array<'team' | 'personal'> =
        source === 'both' ? ['team', 'personal'] : [source];
      let docs: KbQaDocument[] = [];
      let ragWarning: string | undefined;

      try {
        const ragRes = await window.yibiao?.kbQa.retrieveContext(question, {
          sources,
          topK: 6,
          maxDocs: 4,
        });
        if (ragRes && ragRes.success && Array.isArray(ragRes.data) && ragRes.data.length > 0) {
          docs = ragRes.data;
          ragWarning =
            Array.isArray(ragRes.warnings) && ragRes.warnings.length ? ragRes.warnings[0] : undefined;
        }
      } catch {
        // 语义检索失败（如未配置 embedding 模型），下方回退关键词检索
      }

      // 2) 回退：语义检索无结果或不可用时，使用关键词检索
      if (docs.length === 0) {
        const limit = 3;
        const [teamRes, personalRes] = await Promise.all([
          source === 'team' || source === 'both'
            ? window.yibiao?.kbTeam.qaRetrieve(question, limit)
            : Promise.resolve({ success: true, data: [] }),
          source === 'personal' || source === 'both'
            ? window.yibiao?.kbPersonal.qaRetrieve(question, limit)
            : Promise.resolve({ success: true, data: [] }),
        ]);

        const teamDocs: KbQaDocument[] = Array.isArray(teamRes?.data) ? teamRes.data : [];
        const personalDocs: KbQaDocument[] = Array.isArray(personalRes?.data) ? personalRes.data : [];

        // 去重：相同 file_name 且 content_text 前 200 字符相同视为同一文档
        const seen = new Set<string>();
        for (const d of [...teamDocs, ...personalDocs]) {
          const key = `${d.file_name || d.title}|${(d.content_text || '').slice(0, 200)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          docs.push(d);
        }
      }

      if (docs.length === 0) {
        setQaStage(null);
        // 知识库无相关内容：回退到通用聊天（非知识库内容），让问答可用于闲聊
        const answer = await aiClient.chat({
          messages: [
            {
              role: 'system',
              content:
                '你是易标投标工具箱的智能助手，可以正常和用户聊天，也可以回答各类问题。' +
                '当用户的问题与知识库无关时，凭你的常识作答即可；涉及投标、标书等专业问题时给出有帮助的建议。',
            },
            { role: 'user', content: question },
          ],
          timeout_ms: 120000,
          timeout_message: '生成回答超时，请稍后重试',
          logTitle: '知识库问答(闲聊回退)',
        });
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `${answer || '模型未返回内容'}\n\n> 注：以上内容未引用知识库，为通用回答。`,
          },
        ]);
        setLastSources([]);
        return;
      }

      // 检索完成，先展示参考来源，再调用 LLM 生成答案，避免用户长时间看不到任何进展。
      setLastSources(docs);
      if (ragWarning) {
        showToast(ragWarning, 'info');
      }
      setQaStage('generating');

      const prompt = buildPrompt(question, docs);
      const answer = await aiClient.chat({
        messages: [{ role: 'user', content: prompt }],
        timeout_ms: 120000,
        timeout_message: '生成回答超时，请稍后重试',
        logTitle: '知识库问答',
      });

      setMessages((prev) => [...prev, { role: 'assistant', content: answer || '模型未返回内容' }]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '问答失败';
      showToast(msg, 'error');
      setMessages((prev) => [...prev, { role: 'assistant', content: `出错了：${msg}` }]);
    } finally {
      setLoading(false);
      setQaStage(null);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !loading) {
      event.preventDefault();
      handleAsk();
    }
  };

  return (
    <div className="page-stack kb-qa-page">
      <section className="panel kb-qa-panel">
        <div className="kb-qa-header">
          <h1>知识库问答</h1>
          <p>基于团队库或个人库内容进行智能问答</p>
        </div>

        <div className="kb-qa-source">
          <span>知识库来源：</span>
          <div className="kb-qa-source-options">
            {([
              { id: 'team', label: '团队库' },
              { id: 'personal', label: '个人库' },
              { id: 'both', label: '全部' },
            ] as Array<{ id: QaSource; label: string }>).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={source === opt.id ? 'active' : ''}
                onClick={() => setSource(opt.id)}
                disabled={loading}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="kb-qa-messages">
          {messages.map((m, idx) => (
            <div key={idx} className={`kb-qa-message ${m.role}`}>
              <div className="kb-qa-message-role">{m.role === 'user' ? '你' : 'AI 助手'}</div>
              <div className="kb-qa-message-body">
                {m.role === 'assistant' ? (
                  <MarkdownRenderer>{m.content}</MarkdownRenderer>
                ) : (
                  <p>{m.content}</p>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="kb-qa-message assistant">
              <div className="kb-qa-message-role">AI 助手</div>
              <div className="kb-qa-message-body">
                {qaStage === 'retrieving' && (
                  <span className="kb-qa-thinking">正在检索参考资料…</span>
                )}
                {qaStage === 'generating' && (
                  <span className="kb-qa-thinking">
                    已找到 {lastSources.length} 篇参考资料，正在生成回答…
                  </span>
                )}
                {!qaStage && <span className="kb-qa-thinking">正在处理…</span>}
              </div>
            </div>
          )}
        </div>

        {lastSources.length > 0 && (
          <div className="kb-qa-sources">
            <strong>参考来源</strong>
            <ul>
              {lastSources.map((d, i) => (
                <li key={`${d.id}-${i}`}>
                  [{i + 1}] {d.title}
                  {d.qa_source ? (
                    <span className="kb-qa-source-tag">
                      {d.qa_source === 'team' ? '团队库' : '个人库'}
                    </span>
                  ) : null}
                  {typeof d.score === 'number' ? (
                    <span className="kb-qa-score-tag">相关度 {Math.round(d.score * 100)}%</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="kb-qa-input">
          <InputWithAction
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="请输入问题，例如：这份方案里对工期有什么要求？"
            actionLabel={loading ? '思考中…' : '提问'}
            onAction={handleAsk}
            actionDisabled={loading || !input.trim()}
            inputClassName="kb-qa-input-field"
          />
        </div>
      </section>
    </div>
  );
}

export default KbQaPage;
