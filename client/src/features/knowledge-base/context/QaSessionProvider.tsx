import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/auth/AuthContext';
import { runQaAgent, type QaAgentStep } from '../agent/qaAgent';
import { aiClient } from '../../../shared/ai/aiClient';
import type {
  KbQaMessageSource,
  KbQaSession,
  KbQaStoredMessage,
} from '../../../shared/types';

/**
 * QaSessionProvider —— 知识库问答的全局会话状态。
 *
 * 为什么要放在 App 顶层而不是问答页组件里：
 * 路由是 switch-case 直接渲染页面组件，离开问答页 = 组件卸载 = state 全丢。
 * 用户「问一个问题 → 切去生成标书 → 回来看结果」的诉求，必须让检索与生成
 * 脱离页面组件生命周期。所以这里承载：会话列表、当前会话消息、以及 ask() 的
 * 完整执行链路；页面只负责渲染。
 *
 * 持久化：全部落服务器 kb_qa_sessions / kb_qa_messages（按账号隔离）。
 * 服务器不可达时降级为「本机内存会话」（负数 id），保证功能不中断。
 */

export type QaSource = 'team' | 'personal' | 'both';
export type QaStage = 'thinking' | 'retrieving' | 'generating';

export const QA_WELCOME_TEXT =
  '你好！我可以基于团队知识库或个人知识库的内容帮你解答问题。请在下方输入问题，并选择知识库来源。';

interface QaSessionContextValue {
  sessions: KbQaSession[];
  activeSessionId: number | null;
  messages: KbQaStoredMessage[];
  /** 当前会话是否正在生成（跨页面保持） */
  busy: boolean;
  /** 是否有任意会话正在后台生成 */
  anyBusy: boolean;
  stage: QaStage | null;
  loadingSessions: boolean;
  loadingMessages: boolean;
  /** 服务器不可达，当前为本机临时会话 */
  offline: boolean;
  source: QaSource;
  setSource: (s: QaSource) => void;
  ask: (question: string) => Promise<void>;
  selectSession: (sessionId: number) => Promise<void>;
  newSession: () => Promise<void>;
  renameSession: (sessionId: number, title: string) => Promise<void>;
  deleteSession: (sessionId: number) => Promise<void>;
  refreshSessions: () => Promise<void>;
  /** 问答页挂载/卸载时上报，用于决定后台完成后是否弹提醒 */
  setPageVisible: (visible: boolean) => void;
  /** messageId -> Agent 多步推理轨迹（UI 展示用） */
  qaSteps: Record<number, QaAgentStep[]>;
}

const QaSessionContext = createContext<QaSessionContextValue | null>(null);

export function QaSessionProvider({ children }: { children: ReactNode }) {
  const { loggedIn } = useAuth();
  const { showToast } = useToast();

  const [sessions, setSessions] = useState<KbQaSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<KbQaStoredMessage[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [offline, setOffline] = useState(false);
  const [source, setSource] = useState<QaSource>('both');
  /** sessionId -> 当前阶段。用 Map 是因为理论上可以并行问多个会话 */
  const [runningStages, setRunningStages] = useState<Record<number, QaStage>>({});
  /** messageId -> Agent 多步推理轨迹（仅客户端运行时，便于在 UI 展示「Agent 在一步步查」） */
  const [qaSteps, setQaSteps] = useState<Record<number, QaAgentStep[]>>({});

  const pageVisibleRef = useRef(false);
  const activeSessionIdRef = useRef<number | null>(null);
  const localIdRef = useRef(-1);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const setPageVisible = useCallback((visible: boolean) => {
    pageVisibleRef.current = visible;
  }, []);

  const bridge = () => window.yibiao?.kbQaSession;

  // ---------- 会话列表 ----------

  const refreshSessions = useCallback(async () => {
    const api = bridge();
    if (!api) return;
    setLoadingSessions(true);
    try {
      const res = await api.list(100);
      if (res?.success && Array.isArray(res.data)) {
        setSessions(res.data);
        setOffline(false);
      } else if (res && !res.success) {
        setOffline(true);
      }
    } catch {
      setOffline(true);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  const loadMessages = useCallback(async (sessionId: number) => {
    const api = bridge();
    if (!api || sessionId < 0) return;
    setLoadingMessages(true);
    try {
      const res = await api.listMessages(sessionId, 0);
      if (res?.success && Array.isArray(res.data)) {
        setMessages(res.data);
      }
    } catch {
      /* 读取失败保持现状，不清空已有内容 */
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  // 登录后拉取历史；退出登录时清空，避免串号
  useEffect(() => {
    if (!loggedIn) {
      setSessions([]);
      setMessages([]);
      setActiveSessionId(null);
      setRunningStages({});
      return;
    }
    let cancelled = false;
    (async () => {
      const api = bridge();
      if (!api) return;
      setLoadingSessions(true);
      try {
        const res = await api.list(100);
        if (cancelled) return;
        if (res?.success && Array.isArray(res.data)) {
          setSessions(res.data);
          setOffline(false);
          // 默认落到最近一次对话，用户回来就能看到上次的结果
          if (res.data.length > 0 && activeSessionIdRef.current === null) {
            const latest = res.data[0];
            setActiveSessionId(latest.id);
            await loadMessages(latest.id);
          }
        } else {
          setOffline(true);
        }
      } catch {
        if (!cancelled) setOffline(true);
      } finally {
        if (!cancelled) setLoadingSessions(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loggedIn, loadMessages]);

  // ---------- 会话操作 ----------

  const selectSession = useCallback(
    async (sessionId: number) => {
      if (sessionId === activeSessionIdRef.current) return;
      setActiveSessionId(sessionId);
      setMessages([]);
      await loadMessages(sessionId);
    },
    [loadMessages],
  );

  const newSession = useCallback(async () => {
    const api = bridge();
    if (!api) return;
    try {
      const res = await api.create({ libraryType: source === 'personal' ? 'personal' : 'team' });
      if (res?.success && res.data) {
        setSessions((prev) => [res.data as KbQaSession, ...prev]);
        setActiveSessionId(res.data.id);
        setMessages([]);
        setOffline(false);
        return;
      }
      throw new Error(res?.error || '创建会话失败');
    } catch (error) {
      // 服务器不可达：开一个本机临时会话，功能不中断
      const localId = localIdRef.current;
      localIdRef.current -= 1;
      const now = new Date().toISOString();
      const temp: KbQaSession = {
        id: localId,
        employee_id: 0,
        title: '本机临时对话',
        library_type: 'team',
        status: 'idle',
        created_at: now,
        updated_at: now,
        message_count: 0,
      };
      setSessions((prev) => [temp, ...prev]);
      setActiveSessionId(localId);
      setMessages([]);
      setOffline(true);
      showToast(
        `无法连接服务器保存对话（${error instanceof Error ? error.message : '未知错误'}），本次对话仅保存在本机`,
        'info',
      );
    }
  }, [showToast, source]);

  const renameSession = useCallback(
    async (sessionId: number, title: string) => {
      const name = title.trim();
      if (!name) return;
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title: name } : s)));
      if (sessionId < 0) return;
      const api = bridge();
      if (!api) return;
      const res = await api.rename(sessionId, name);
      if (!res?.success) {
        showToast(res?.error || '重命名失败', 'error');
        await refreshSessions();
      }
    },
    [refreshSessions, showToast],
  );

  const deleteSession = useCallback(
    async (sessionId: number) => {
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      if (activeSessionIdRef.current === sessionId) {
        const next = remaining[0] || null;
        setActiveSessionId(next ? next.id : null);
        setMessages([]);
        if (next) await loadMessages(next.id);
      }
      if (sessionId < 0) return;
      const api = bridge();
      if (!api) return;
      const res = await api.remove(sessionId);
      if (!res?.success) {
        showToast(res?.error || '删除会话失败', 'error');
        await refreshSessions();
      }
    },
    [sessions, loadMessages, refreshSessions, showToast],
  );

  // ---------- 消息落库（带本机降级） ----------

  const appendMessage = useCallback(
    async (
      sessionId: number,
      payload: { role: 'user' | 'assistant'; content?: string; status?: 'pending' | 'done' | 'error'; sources?: KbQaMessageSource[] | null },
    ): Promise<KbQaStoredMessage> => {
      const now = new Date().toISOString();
      const fallback: KbQaStoredMessage = {
        id: localIdRef.current,
        session_id: sessionId,
        role: payload.role,
        content: payload.content || '',
        status: payload.status || 'done',
        sources: payload.sources || [],
        created_at: now,
        updated_at: now,
      };
      const api = bridge();
      if (!api || sessionId < 0) {
        localIdRef.current -= 1;
        setMessages((prev) => [...prev, fallback]);
        return fallback;
      }
      try {
        const res = await api.addMessage(sessionId, payload);
        if (res?.success && res.data) {
          setMessages((prev) => [...prev, res.data as KbQaStoredMessage]);
          return res.data;
        }
        throw new Error(res?.error || '保存消息失败');
      } catch {
        localIdRef.current -= 1;
        setOffline(true);
        setMessages((prev) => [...prev, fallback]);
        return fallback;
      }
    },
    [],
  );

  const patchMessage = useCallback(
    async (
      messageId: number,
      patch: { content?: string; status?: 'pending' | 'done' | 'error'; sources?: KbQaMessageSource[] | null },
    ) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: patch.content !== undefined ? patch.content : m.content,
                status: patch.status || m.status,
                sources: patch.sources !== undefined ? patch.sources || [] : m.sources,
              }
            : m,
        ),
      );
      const api = bridge();
      if (!api || messageId < 0) return;
      try {
        await api.updateMessage(messageId, patch);
      } catch {
        setOffline(true);
      }
    },
    [],
  );

  // ---------- 核心：提问 ----------

  const ask = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (!question) return;

      // 1) 确保有会话（首次提问自动开一个）
      let sid = activeSessionIdRef.current;
      if (sid === null) {
        const api = bridge();
        let created: KbQaSession | null = null;
        if (api) {
          try {
            const res = await api.create({
              libraryType: source === 'personal' ? 'personal' : 'team',
            });
            if (res?.success && res.data) created = res.data;
          } catch {
            /* 落到本机临时会话 */
          }
        }
        if (created) {
          setSessions((prev) => [created as KbQaSession, ...prev]);
          setActiveSessionId(created.id);
          activeSessionIdRef.current = created.id;
          sid = created.id;
          setOffline(false);
        } else {
          const localId = localIdRef.current;
          localIdRef.current -= 1;
          const now = new Date().toISOString();
          const temp: KbQaSession = {
            id: localId,
            employee_id: 0,
            title: '本机临时对话',
            library_type: 'team',
            status: 'idle',
            created_at: now,
            updated_at: now,
            message_count: 0,
          };
          setSessions((prev) => [temp, ...prev]);
          setActiveSessionId(localId);
          activeSessionIdRef.current = localId;
          sid = localId;
          setOffline(true);
        }
      }
      const sessionId = sid as number;

      // 2) 写入用户提问 + 一条 pending 的助手占位
      // 先标记「运行中」再落库：否则中间会有一帧是 pending 但未运行，
      // 页面会误判为「上次未完成的回答」而闪一下提示。
      setRunningStages((prev) => ({ ...prev, [sessionId]: 'retrieving' }));
      await appendMessage(sessionId, { role: 'user', content: question });
      const placeholder = await appendMessage(sessionId, {
        role: 'assistant',
        content: '',
        status: 'pending',
      });
      // 首问自动命名：服务端已做，这里同步一份到本地列表，避免要等下次刷新
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId && (s.title === '新对话' || !s.title)
            ? { ...s, title: question.slice(0, 40) + (question.length > 40 ? '…' : '') }
            : s,
        ),
      );

      const finish = (content: string, status: 'done' | 'error', sources: KbQaMessageSource[]) => {
        void patchMessage(placeholder.id, { content, status, sources });
        setRunningStages((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
        // 用户已经切走了 → 弹一条提醒，告诉他回来能看结果
        if (!pageVisibleRef.current) {
          showToast(
            status === 'done' ? '知识库问答已生成回答，可回到问答页查看' : `知识库问答失败：${content}`,
            status === 'done' ? 'success' : 'error',
          );
        }
      };

      try {
        setRunningStages((prev) => ({ ...prev, [sessionId]: 'thinking' }));

        // 改用 Agentic RAG：多步推理循环（见 agent/qaAgent.ts）
        setQaSteps((prev) => ({ ...prev, [placeholder.id]: [] }));
        const result = await runQaAgent({
          question,
          source,
          onStage: (s) => setRunningStages((prev) => ({ ...prev, [sessionId]: s })),
          onStep: (s) =>
            setQaSteps((prev) => ({
              ...prev,
              [placeholder.id]: [...(prev[placeholder.id] || []), s],
            })),
        });

        // 完全无文档命中 → 回退通用聊天（保留原行为）
        if (result.empty) {
          const sourceLabel =
            source === 'team' ? '团队库' : source === 'personal' ? '个人库' : '团队库和个人库';
          const emptyHint = `未在${sourceLabel}中检索到与「${question}」相关的内容。

可能原因：
1. 知识库中暂无匹配文档；
2. 文档尚未分析完成；
3. 关键词与文档标题/正文差异较大。

你可以尝试更换关键词、切换到「全部」来源，或直接提问，我会基于通用知识作答。`;
          setRunningStages((prev) => ({ ...prev, [sessionId]: 'generating' }));
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
          finish(
            `${emptyHint}\n\n---\n\n${answer || '模型未返回内容'}\n\n> 注：以上回答未引用知识库，为通用回答。`,
            'done',
            [],
          );
          return;
        }

        // 需要向用户追问澄清
        if (result.needClarify) {
          finish(
            `需要你补充信息：\n\n${result.needClarify}\n\n（补充后我会继续为你检索并回答）`,
            'done',
            [],
          );
          return;
        }

        // 正常综合回答
        finish(result.answer || '模型未返回内容', 'done', result.sources);
      } catch (error) {
        const msg = error instanceof Error ? error.message : '问答失败';
        if (pageVisibleRef.current) showToast(msg, 'error');
        finish(`出错了：${msg}`, 'error', []);
      }
    },
    [appendMessage, patchMessage, showToast, source],
  );

  const busy = activeSessionId !== null && Boolean(runningStages[activeSessionId]);
  const stage = activeSessionId !== null ? runningStages[activeSessionId] || null : null;
  const anyBusy = Object.keys(runningStages).length > 0;

  const value = useMemo<QaSessionContextValue>(
    () => ({
      sessions,
      activeSessionId,
      messages,
      busy,
      anyBusy,
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
      refreshSessions,
      setPageVisible,
      qaSteps,
    }),
    [
      sessions,
      activeSessionId,
      messages,
      busy,
      anyBusy,
      stage,
      loadingSessions,
      loadingMessages,
      offline,
      source,
      ask,
      selectSession,
      newSession,
      renameSession,
      deleteSession,
      refreshSessions,
      setPageVisible,
    ],
  );

  return <QaSessionContext.Provider value={value}>{children}</QaSessionContext.Provider>;
}

export function useQaSession(): QaSessionContextValue {
  const ctx = useContext(QaSessionContext);
  if (!ctx) {
    throw new Error('useQaSession 必须在 QaSessionProvider 内使用');
  }
  return ctx;
}
