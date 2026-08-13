import { useEffect, useMemo, useRef, useState } from 'react';
import InputWithAction from '../../../shared/ui/InputWithAction';
import MarkdownRenderer from '../../../shared/ui/MarkdownRenderer';
import { useConfirmDialog } from '../../../shared/ui';
import {
  QA_WELCOME_TEXT,
  useQaSession,
  type QaSource,
} from '../context/QaSessionProvider';
import type { KbQaMessageSource, KbQaStoredMessage } from '../../../shared/types';

/**
 * 知识库问答页。
 *
 * 这里只负责渲染：会话列表、消息流、输入框。真正的状态（会话、消息、检索与生成）
 * 全部放在挂在 App 顶层的 QaSessionProvider 里 —— 因为路由是 switch-case 直接渲染
 * 页面组件，离开问答页组件就会卸载。放页面里会导致「提问后切去生成标书，回来记录全没了」。
 */

const SOURCE_OPTIONS: Array<{ id: QaSource; label: string }> = [
  { id: 'team', label: '团队库' },
  { id: 'personal', label: '个人库' },
  { id: 'both', label: '全部' },
];

function formatSessionTime(iso?: string) {
  if (!iso) return '';
  // 服务端存的是本地时间字符串（无时区后缀），直接交给 Date 解析即可，不要补 Z
  const d = new Date(iso.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 问答记录滚动保留天数：超过该天数无活动的会话会被服务器定时清理
const QA_RETENTION_DAYS = 7;

// 返回该会话距离被自动清理还剩几天（ceil）；null 表示无法计算
function retentionDaysLeft(updatedAt?: string): number | null {
  if (!updatedAt) return null;
  const d = new Date(updatedAt.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  const elapsedDays = (Date.now() - d.getTime()) / 86_400_000;
  return Math.ceil(QA_RETENTION_DAYS - elapsedDays);
}

function SourceList({ sources }: { sources: KbQaMessageSource[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="kb-qa-sources">
      <strong>参考来源</strong>
      <ul>
        {sources.map((s, i) => (
          <li key={`${s.id ?? 'x'}-${i}`}>
            [{i + 1}] {s.title || '未命名文档'}
            {s.qa_source ? (
              <span className="kb-qa-source-tag">
                {s.qa_source === 'team' ? '团队库' : '个人库'}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function KbQaPage() {
  const {
    sessions,
    activeSessionId,
    messages,
    busy,
    stage,
    loadingSessions,
    loadingMessages,
    offline,
    source,
    setSource,
    ask,
    selectSession,
    newSession,
    renameSession,
    deleteSession,
    setPageVisible,
  } = useQaSession();
  const { confirm, prompt } = useConfirmDialog();

  const [input, setInput] = useState('');
  const messagesRef = useRef<HTMLDivElement | null>(null);

  // 知识图谱状态与构建进度（P3）
  const [graphStat, setGraphStat] = useState<{ entityCount: number; relationCount: number }>({
    entityCount: 0,
    relationCount: 0,
  });
  const [graphBuilding, setGraphBuilding] = useState(false);
  const [graphProgress, setGraphProgress] = useState<{ message: string; done: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.yibiao?.kbQa
      .graphStatus(source)
      .then((r) => {
        if (!cancelled && r?.success) {
          setGraphStat({ entityCount: r.entityCount || 0, relationCount: r.relationCount || 0 });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source]);

  const handleBuildGraph = async () => {
    if (graphBuilding || busy) return;
    setGraphBuilding(true);
    setGraphProgress({ message: '准备中…', done: 0, total: 0 });
    const unsub = window.yibiao?.kbQa.onBuildGraphProgress?.((p) => {
      setGraphProgress({ message: p.message, done: p.done, total: p.total });
    });
    try {
      const targets: Array<'team' | 'personal'> = source === 'both' ? ['team', 'personal'] : [source];
      for (const t of targets) {
        const res = await window.yibiao?.kbQa.buildGraph(t);
        if (!res?.success) {
          setGraphProgress({ message: `构建失败（${t}）：${res?.error || '未知错误'}`, done: 0, total: 0 });
          if (unsub) unsub();
          setGraphBuilding(false);
          return;
        }
      }
      const st = await window.yibiao?.kbQa.graphStatus(source);
      if (st?.success) {
        setGraphStat({ entityCount: st.entityCount || 0, relationCount: st.relationCount || 0 });
        setGraphProgress({
          message: `完成：共 ${st.entityCount || 0} 实体 / ${st.relationCount || 0} 关系`,
          done: 1,
          total: 1,
        });
      }
    } catch (e) {
      setGraphProgress({ message: `构建出错：${e instanceof Error ? e.message : String(e)}`, done: 0, total: 0 });
    } finally {
      if (unsub) unsub();
      setTimeout(() => setGraphBuilding(false), 1200);
    }
  };

  // 告诉 Provider 当前页面是否可见：不可见时后台生成完成会弹 toast 提醒
  useEffect(() => {
    setPageVisible(true);
    return () => setPageVisible(false);
  }, [setPageVisible]);

  // 新消息进来自动滚到底
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, stage]);

  const runningSessionIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of sessions) {
      if (s.last_status === 'pending' || s.status === 'running') ids.add(s.id);
    }
    if (busy && activeSessionId !== null) ids.add(activeSessionId);
    return ids;
  }, [sessions, busy, activeSessionId]);

  const handleAsk = () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput('');
    void ask(question);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !busy) {
      event.preventDefault();
      handleAsk();
    }
  };

  const handleRename = async (sessionId: number, currentTitle: string) => {
    const name = await prompt({
      title: '重命名对话',
      placeholder: '请输入新的对话名称',
      defaultValue: currentTitle,
      confirmText: '保存',
    });
    if (name && name.trim() && name.trim() !== currentTitle) {
      await renameSession(sessionId, name.trim());
    }
  };

  const handleDelete = async (sessionId: number, title: string) => {
    const ok = await confirm({
      title: '删除对话',
      message: `确定要删除「${title}」吗？删除后聊天记录将不再显示。`,
      confirmText: '删除',
      variant: 'danger',
    });
    if (ok) await deleteSession(sessionId);
  };

  const renderMessage = (m: KbQaStoredMessage) => {
    const pending = m.role === 'assistant' && m.status === 'pending';
    // 消息还是 pending 但本地并没有在跑（典型场景：生成途中关掉了应用），
    // 这种记录永远不会自己变成 done，得如实告诉用户，不能一直转圈。
    const interrupted = pending && !busy;
    return (
      <div key={m.id} className={`kb-qa-message ${m.role}`}>
        <div className="kb-qa-message-role">{m.role === 'user' ? '你' : 'AI 助手'}</div>
        <div className="kb-qa-message-body">
          {m.role === 'user' ? (
            <p>{m.content}</p>
          ) : pending ? (
            interrupted ? (
              <span className="kb-qa-thinking">本次回答未完成（应用曾被关闭），请重新提问。</span>
            ) : (
              <span className="kb-qa-thinking">
                {stage === 'generating'
                  ? '已找到参考资料，正在生成回答…'
                  : stage === 'retrieving'
                    ? '正在检索参考资料…'
                    : '正在生成回答，可以先去忙别的，完成后会提醒你…'}
              </span>
            )
          ) : (
            <>
              <MarkdownRenderer>{m.content}</MarkdownRenderer>
              {m.status === 'error' ? <div className="kb-qa-message-error">生成失败</div> : null}
            </>
          )}
        </div>
        {!pending && m.role === 'assistant' ? <SourceList sources={m.sources || []} /> : null}
      </div>
    );
  };

  return (
    <div className="page-stack kb-qa-page">
      <div className="kb-qa-layout">
        {/* ---------- 左侧：会话列表 ---------- */}
        <aside className="kb-qa-sidebar">
          <div className="kb-qa-sidebar-head">
            <span>历史对话</span>
            <button type="button" className="kb-qa-new-btn" onClick={() => void newSession()}>
              + 新建
            </button>
          </div>

          <div className="kb-qa-session-list">
            {loadingSessions && sessions.length === 0 ? (
              <div className="kb-qa-session-empty">加载中…</div>
            ) : sessions.length === 0 ? (
              <div className="kb-qa-session-empty">
                还没有对话记录
                <small>直接在右侧提问即可开始</small>
              </div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={`kb-qa-session-item${s.id === activeSessionId ? ' active' : ''}`}
                  onClick={() => void selectSession(s.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void selectSession(s.id);
                    }
                  }}
                >
                  <div className="kb-qa-session-main">
                    <div className="kb-qa-session-title">
                      {s.title || '新对话'}
                      {runningSessionIds.has(s.id) ? (
                        <span className="kb-qa-session-badge">生成中</span>
                      ) : null}
                      {(() => {
                        const left = retentionDaysLeft(s.updated_at);
                        if (left === null || left > 2) return null;
                        return (
                          <span className="kb-qa-session-expire">
                            {left <= 0 ? '即将删除' : `${left}天后删除`}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="kb-qa-session-meta">
                      <span className="kb-qa-session-preview">
                        {s.preview ||
                          (runningSessionIds.has(s.id) ? '正在生成回答…' : '暂无内容')}
                      </span>
                      <span className="kb-qa-session-time">{formatSessionTime(s.updated_at)}</span>
                    </div>
                  </div>
                  <div className="kb-qa-session-actions">
                    <button
                      type="button"
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRename(s.id, s.title || '新对话');
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      title="删除"
                      className="danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDelete(s.id, s.title || '新对话');
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ---------- 右侧：对话区 ---------- */}
        <section className="panel kb-qa-panel">
          <div className="kb-qa-header">
            <h1>知识库问答</h1>
            <p>基于团队库或个人库内容进行智能问答，聊天记录按账号保存，离开页面也不会中断</p>
          </div>

          {offline ? (
            <div className="kb-qa-offline-tip">
              未连接到服务器，当前对话仅保存在本机，重启后会丢失。
            </div>
          ) : null}

          <div className="kb-qa-retention-notice">
            问答记录仅保留最近 {QA_RETENTION_DAYS} 天，超过 {QA_RETENTION_DAYS} 天无活动的对话将被自动删除，重要内容请及时导出。
          </div>

          <div className="kb-qa-source">
            <span>知识库来源：</span>
            <div className="kb-qa-source-options">
              {SOURCE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={source === opt.id ? 'active' : ''}
                  onClick={() => setSource(opt.id)}
                  disabled={busy}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="kb-qa-graph">
            <span className="kb-qa-graph-stat">
              知识图谱：{graphStat.entityCount} 实体 / {graphStat.relationCount} 关系
            </span>
            <button
              type="button"
              className="kb-qa-graph-build"
              onClick={() => void handleBuildGraph()}
              disabled={graphBuilding || busy}
            >
              {graphBuilding ? '构建中…' : '构建图谱'}
            </button>
            {graphBuilding && graphProgress ? (
              <div className="kb-qa-graph-progress">
                <span>{graphProgress.message}</span>
                {graphProgress.total > 0 ? (
                  <div className="kb-qa-graph-bar">
                    <div
                      className="kb-qa-graph-bar-fill"
                      style={{ width: `${Math.round((graphProgress.done / graphProgress.total) * 100)}%` }}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="kb-qa-messages" ref={messagesRef}>
            {loadingMessages && messages.length === 0 ? (
              <div className="kb-qa-message assistant">
                <div className="kb-qa-message-role">AI 助手</div>
                <div className="kb-qa-message-body">
                  <span className="kb-qa-thinking">正在加载聊天记录…</span>
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div className="kb-qa-message assistant">
                <div className="kb-qa-message-role">AI 助手</div>
                <div className="kb-qa-message-body">
                  <p>{QA_WELCOME_TEXT}</p>
                </div>
              </div>
            ) : (
              messages.map(renderMessage)
            )}
          </div>

          <div className="kb-qa-input">
            <InputWithAction
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="请输入问题，例如：这份方案里对工期有什么要求？"
              actionLabel={busy ? '思考中…' : '提问'}
              onAction={handleAsk}
              actionDisabled={busy || !input.trim()}
              inputClassName="kb-qa-input-field"
            />
          </div>
        </section>
      </div>
    </div>
  );
}

export default KbQaPage;
