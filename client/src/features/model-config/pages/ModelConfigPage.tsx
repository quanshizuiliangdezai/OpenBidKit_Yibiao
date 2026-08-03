import { useEffect, useState } from 'react';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/auth/AuthContext';

// 解析方式原始值 → 中文标签（服务器只读区展示用，避免直接显示 local / mineru-*）
const PARSER_LABELS: Record<string, string> = {
  local: '本地解析',
  'mineru-agent-api': 'MinerU-Agent（免 Token）',
  'mineru-accurate-api': 'MinerU 精准解析（需 Token）',
};
const parserLabel = (v?: string): string => PARSER_LABELS[v || 'local'] || '本地解析';

const CpuIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v3" />
    <path d="M15 1v3" />
    <path d="M9 20v3" />
    <path d="M15 20v3" />
    <path d="M20 9h3" />
    <path d="M20 14h3" />
    <path d="M1 9h3" />
    <path d="M1 14h3" />
  </svg>
);

const GlobeIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const KeyIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7.5" cy="15.5" r="5.5" />
    <path d="m21 2-9.6 9.6" />
    <path d="m15.5 7.5 3 3L22 7l-3-3-3.5 3.5z" />
  </svg>
);

const SparklesIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    <path d="M5 3v4" />
    <path d="M19 17v4" />
    <path d="M3 5h4" />
    <path d="M17 19h4" />
  </svg>
);

const SearchIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

const ServerIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <path d="M6 6h.01" />
    <path d="M6 18h.01" />
  </svg>
);

const LinkIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

const BrainIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
  </svg>
);

const InfoIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>
);

const LockIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

export default function ModelConfigPage() {
  const { showToast } = useToast();
  const { isAdmin } = useAuth();

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [globalEmbedding, setGlobalEmbedding] = useState('');
  const [fileParserProvider, setFileParserProvider] = useState<'local' | 'mineru-accurate-api' | 'mineru-agent-api'>('local');
  const [pdfImageParserProvider, setPdfImageParserProvider] = useState<'local' | 'mineru-accurate-api' | 'mineru-agent-api'>('local');
  const [mineruToken, setMineruToken] = useState('');
  const [showMineruToken, setShowMineruToken] = useState(false);
  const [testingMineruToken, setTestingMineruToken] = useState(false);
  const [serverConfig, setServerConfig] = useState<{
    base_url?: string;
    analysis_model?: string;
    embedding_model?: string;
    file_parser_provider?: string;
    pdf_image_parser_provider?: string;
    has_mineru_token?: boolean;
  }>({});

  const loadConfig = async () => {
    setModels([]);
    if (!isAdmin) return;
    // 可编辑表单始终以「本地文本模型配置」为基准，保证与「设置」页口径一致，
    // 避免服务器 global 配置与本地 api_key 错配导致「获取模型」结果不一致。
    try {
      const cfg = (await window.yibiao?.config.load()) as unknown as Record<string, unknown> | undefined;
      if (cfg) {
        const provider = (cfg.text_model_provider as string) || 'custom';
        const profiles = (cfg.text_model_profiles as Record<string, Record<string, unknown>>) || {};
        const profile = profiles[provider] || {};
        setBaseUrl((profile.base_url as string) || '');
        setApiKey((profile.api_key as string) || '');
        setModel((profile.model_name as string) || '');
      }
    } catch {
      /* 忽略读取失败 */
    }
    // 服务器当前已部署的配置仅作只读展示，不覆盖可编辑字段。
    try {
      const res = await window.yibiao?.config.loadGlobal();
      if (res?.success && res.data) {
        setServerConfig({
          base_url: res.data.base_url || '',
          analysis_model: res.data.analysis_model || '',
          embedding_model: res.data.embedding_model || '',
          file_parser_provider: res.data.file_parser_provider || 'local',
          pdf_image_parser_provider: res.data.pdf_image_parser_provider || 'local',
          has_mineru_token: Boolean(res.data.has_mineru_token),
        });
        setGlobalEmbedding(res.data.embedding_model || '');
        setFileParserProvider((res.data.file_parser_provider as 'local' | 'mineru-accurate-api' | 'mineru-agent-api') || 'local');
        setPdfImageParserProvider((res.data.pdf_image_parser_provider as 'local' | 'mineru-accurate-api' | 'mineru-agent-api') || 'local');
      }
    } catch {
      /* 忽略读取失败 */
    }
  };

  useEffect(() => {
    void loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      // 以「设置」页同源的当前生效文本模型配置为基底，再优先用表单值覆盖。
      // 表单为空时回退到活动 profile（与设置页完全一致），避免两页获取口径不一致。
      const cfg = (await window.yibiao?.config.load()) as unknown as Record<string, unknown> | undefined;
      const provider = (cfg?.text_model_provider as string) || 'custom';
      const profiles = (cfg?.text_model_profiles as Record<string, Record<string, unknown>>) || {};
      const active = profiles[provider] || {};
      const base_url = (baseUrl.trim() || (active.base_url as string) || '').trim();
      const api_key = (apiKey.trim() || (active.api_key as string) || '').trim();
      const model_name = (model.trim() || (active.model_name as string) || '').trim();
      if (!base_url) { showToast('请先填写 API Base URL（或在设置页配置文本模型）', 'info'); return; }
      if (!api_key) { showToast('请先填写 API Key（或在设置页配置文本模型）', 'info'); return; }
      const probe = { ...(cfg || {}), base_url, api_key, model_name };
      const result = await window.yibiao?.config.listModels(probe as never);
      const list = result?.models || [];
      setModels(list);
      const masked = api_key.length > 8 ? `${api_key.slice(0, 4)}…${api_key.slice(-4)}` : api_key;
      if (result?.success && list.length) {
        showToast(`获取到 ${list.length} 个模型（key ${masked}）`, 'success');
        if (!list.includes(model)) setModel(list[0]);
      } else {
        showToast(`${result?.message || '未获取到模型列表'}（key ${masked}）`, 'info');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取模型失败', 'error');
    } finally {
      setLoadingModels(false);
    }
  };

  const testConnection = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) { showToast('请先填写 API Base URL 与 API Key', 'info'); return; }
    if (!model.trim()) { showToast('请先填写模型名称', 'info'); return; }
    setTesting(true);
    try {
      const probe = { base_url: baseUrl.trim(), api_key: apiKey.trim(), model_name: model.trim() };
      const result = await window.yibiao?.ai.testTextModel(probe as never);
      if (result?.success) showToast(result.message || '连接成功', 'success');
      else showToast(result?.message || '连接失败', 'error');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '连接测试失败', 'error');
    } finally {
      setTesting(false);
    }
  };

  const testMineruParseConnection = async () => {
    // 优先用精准解析（accurate-api）做测试：只要任一解析方式选了精准解析，
    // Token 字段就会出现，此时应用户填入的 Token 验证精准解析链路。
    const provider = pdfImageParserProvider === 'mineru-accurate-api' ? 'mineru-accurate-api'
      : fileParserProvider === 'mineru-accurate-api' ? 'mineru-accurate-api'
      : pdfImageParserProvider;
    if (provider === 'local') {
      showToast('当前未启用 MinerU（解析方式均为本地解析），无需此测试', 'info');
      return;
    }
    const token = mineruToken.trim();
    if (provider === 'mineru-accurate-api' && !token) {
      showToast('请先填写 MinerU Token（精准解析需要）', 'info');
      return;
    }
    setTestingMineruToken(true);
    try {
      const result = await window.yibiao?.config.testMineruParse({ provider, mineru_token: token });
      if (!result) { showToast('解析测试无返回', 'error'); return; }
      if (result.canceled) return; // 用户取消选择文件
      if (result.success) {
        const preview = (result.markdown || '').replace(/\s+/g, ' ').slice(0, 120);
        showToast(`解析成功（${result.char_count || 0} 字）${preview ? '：' + preview + '…' : ''}`, 'success');
      } else {
        showToast(result.message || result.error || '解析失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '解析测试失败', 'error');
    } finally {
      setTestingMineruToken(false);
    }
  };

  const applyGlobal = async () => {
    if (!baseUrl.trim() || !model.trim()) {
      showToast('Base URL 与模型名称不能为空', 'error');
      return;
    }
    setSavingGlobal(true);
    try {
      const res = await window.yibiao?.config.saveGlobal({
        base_url: baseUrl.trim(),
        api_key: apiKey.trim() ? apiKey.trim() : '__UNCHANGED__',
        analysis_model: model.trim(),
        qa_model: model.trim(),
        embedding_model: globalEmbedding || null,
        file_parser_provider: fileParserProvider,
        pdf_image_parser_provider: pdfImageParserProvider,
        mineru_token: mineruToken.trim() ? mineruToken.trim() : '__UNCHANGED__',
      });
      if (res?.success) showToast('已应用到服务器（个人库 + 团队库分析 + 问答生效）', 'success');
      else showToast(res?.error || '应用失败', 'error');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '应用失败', 'error');
    } finally {
      setSavingGlobal(false);
    }
  };

  return (
    <div className="settings-page model-config-page">
      <div className="settings-page-scroll">
        <div className="model-config-header">
          <div className="model-config-header-icon">
            <CpuIcon />
          </div>
          <div className="model-config-header-copy">
            <div className="model-config-title-row">
              <h1>模型配置</h1>
              <span className="model-config-badge">服务器全局</span>
            </div>
            <p>配置团队库分析、问答与语义检索使用的模型，保存后对全体成员立即生效。</p>
          </div>
        </div>

        {isAdmin ? (
          <>
            <section className="model-config-card">
              <div className="model-config-section-title">接入信息</div>
              <div className="model-config-form">
                <label className="model-config-field">
                  <div className="model-config-field-head">
                    <span className="model-config-field-label">API Base URL</span>
                  </div>
                  <div className="model-config-input-wrap">
                    <span className="input-icon"><GlobeIcon /></span>
                    <input
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder="https://apihub.agnes-ai.cn/v1"
                    />
                  </div>
                </label>

                <label className="model-config-field">
                  <div className="model-config-field-head">
                    <span className="model-config-field-label">API Key</span>
                    <span className="model-config-field-hint">留空 = 应用到服务器时沿用现有密钥</span>
                  </div>
                  <div className="model-config-input-wrap model-config-key-wrap">
                    <span className="input-icon"><KeyIcon /></span>
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder="sk-..."
                    />
                    <button
                      type="button"
                      className="model-config-key-toggle"
                      onClick={() => setShowKey((prev) => !prev)}
                      tabIndex={-1}
                    >
                      {showKey ? '隐藏' : '显示'}
                    </button>
                  </div>
                </label>

                <label className="model-config-field">
                  <div className="model-config-field-head">
                    <span className="model-config-field-label">模型名称</span>
                  </div>
                  <div className="model-config-input-row">
                    <div className="model-config-input-wrap">
                      <span className="input-icon"><SparklesIcon /></span>
                      {models.length > 0 ? (
                        <select
                          value={model}
                          onChange={(event) => setModel(event.target.value)}
                        >
                          {models.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={model}
                          onChange={(event) => setModel(event.target.value)}
                          placeholder="agens2.5"
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      className="model-config-input-action"
                      onClick={() => void fetchModels()}
                      disabled={loadingModels}
                    >
                      {loadingModels ? '获取中…' : '获取模型'}
                    </button>
                  </div>
                  {models.length > 0 && (
                    <span className="model-config-field-hint">
                      当前 API Key 返回了 {models.length} 个模型
                      {models.length <= 2 && '，如列表不全可直接手动输入模型名'}
                    </span>
                  )}
                </label>

                <label className="model-config-field">
                  <div className="model-config-field-head">
                    <span className="model-config-field-label">语义检索模型名（可选）</span>
                    <span className="model-config-field-hint">留空则服务器不启用独立 embedding 模型</span>
                  </div>
                  <div className="model-config-input-wrap">
                    <span className="input-icon"><SearchIcon /></span>
                    <input
                      value={globalEmbedding}
                      onChange={(event) => setGlobalEmbedding(event.target.value)}
                      placeholder="例如 text-embedding-3-small"
                    />
                  </div>
                </label>

                <label className="model-config-field">
                  <div className="model-config-field-head">
                    <span className="model-config-field-label">本地可解析格式 · 解析方式</span>
                    <span className="model-config-field-hint">Word / Excel / TXT / MD 等本地可解析（默认本地，无 OCR）</span>
                  </div>
                  <div className="model-config-input-wrap">
                    <span className="input-icon"><ServerIcon /></span>
                    <select
                      value={fileParserProvider}
                      onChange={(event) => setFileParserProvider(event.target.value as 'local' | 'mineru-accurate-api' | 'mineru-agent-api')}
                    >
                      <option value="local">本地解析（默认，纯本地、无 OCR）</option>
                      <option value="mineru-agent-api">MinerU-Agent（免 Token，云端 OCR）</option>
                      <option value="mineru-accurate-api">MinerU 精准解析（需 Token，质量更高）</option>
                    </select>
                  </div>
                </label>

                <label className="model-config-field">
                  <div className="model-config-field-head">
                    <span className="model-config-field-label">PDF / PPT / 图片 / HTML · 解析方式</span>
                    <span className="model-config-field-hint">无文字层 PDF、扫描件、图片、PPT、HTML 走云端 OCR（默认 MinerU-Agent 免 Token）</span>
                  </div>
                  <div className="model-config-input-wrap">
                    <span className="input-icon"><ServerIcon /></span>
                    <select
                      value={pdfImageParserProvider}
                      onChange={(event) => setPdfImageParserProvider(event.target.value as 'local' | 'mineru-accurate-api' | 'mineru-agent-api')}
                    >
                      <option value="local">本地解析（仅含文字层时可用）</option>
                      <option value="mineru-agent-api">MinerU-Agent（免 Token，云端 OCR）</option>
                      <option value="mineru-accurate-api">MinerU 精准解析（需 Token，质量更高）</option>
                    </select>
                  </div>
                </label>

                {(fileParserProvider === 'mineru-accurate-api' || pdfImageParserProvider === 'mineru-accurate-api') && (
                  <label className="model-config-field">
                    <div className="model-config-field-head">
                      <div>
                        <span className="model-config-field-label">MinerU Token</span>
                        <span className="model-config-field-hint">精准解析需要；留空 = 沿用现有 Token</span>
                      </div>
                      <button
                        type="button"
                        className="model-config-mineru-test-btn"
                        onClick={() => void testMineruParseConnection()}
                        disabled={testingMineruToken}
                        tabIndex={-1}
                      >
                        {testingMineruToken ? '解析中…' : '测试解析（上传 PDF）'}
                      </button>
                    </div>
                    <div className="model-config-input-wrap model-config-key-wrap">
                      <span className="input-icon"><KeyIcon /></span>
                      <input
                        type={showMineruToken ? 'text' : 'password'}
                        value={mineruToken}
                        onChange={(event) => setMineruToken(event.target.value)}
                        placeholder="mineru-..."
                      />
                      <button
                        type="button"
                        className="model-config-key-toggle"
                        onClick={() => setShowMineruToken((prev) => !prev)}
                        tabIndex={-1}
                      >
                        {showMineruToken ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </label>
                )}
              </div>
            </section>

            {serverConfig && (
              <section className="model-config-card model-config-server-card">
                <div className="model-config-server-header">
                  <div className="model-config-server-title-wrap">
                    <span className="model-config-server-icon">
                      <ServerIcon />
                    </span>
                    <div>
                      <div className="model-config-section-title">服务器当前已部署配置</div>
                      <div className="model-config-server-subtitle">仅管理员可见 · 密钥不回传</div>
                    </div>
                  </div>
                  <span className="model-config-readonly-badge">只读</span>
                </div>

                <div className="model-config-server-grid">
                  <div className="model-config-server-item">
                    <div className="model-config-server-item-head">
                      <span className="model-config-server-item-icon url"><LinkIcon /></span>
                      <span className="model-config-server-label">API Base URL</span>
                    </div>
                    <span className={serverConfig.base_url ? 'model-config-server-value' : 'model-config-server-value empty'}>
                      {serverConfig.base_url || '（未配置）'}
                    </span>
                  </div>

                  <div className="model-config-server-item">
                    <div className="model-config-server-item-head">
                      <span className="model-config-server-item-icon model"><BrainIcon /></span>
                      <span className="model-config-server-label">分析 / 问答模型</span>
                    </div>
                    <span className={serverConfig.analysis_model ? 'model-config-server-value' : 'model-config-server-value empty'}>
                      {serverConfig.analysis_model || '（未配置）'}
                    </span>
                  </div>

                  <div className="model-config-server-item">
                    <div className="model-config-server-item-head">
                      <span className="model-config-server-item-icon embedding"><SearchIcon /></span>
                      <span className="model-config-server-label">语义检索模型</span>
                    </div>
                    <span className={serverConfig.embedding_model ? 'model-config-server-value' : 'model-config-server-value empty'}>
                      {serverConfig.embedding_model || '（未配置）'}
                    </span>
                  </div>

                  <div className="model-config-server-item">
                    <div className="model-config-server-item-head">
                      <span className="model-config-server-item-icon url"><LinkIcon /></span>
                      <span className="model-config-server-label">本地可解析格式 · 解析方式</span>
                    </div>
                    <span className="model-config-server-value">
                      {parserLabel(serverConfig.file_parser_provider)}
                    </span>
                  </div>

                  <div className="model-config-server-item">
                    <div className="model-config-server-item-head">
                      <span className="model-config-server-item-icon url"><LinkIcon /></span>
                      <span className="model-config-server-label">PDF/PPT/图片/HTML · 解析方式</span>
                    </div>
                    <span className="model-config-server-value">
                      {parserLabel(serverConfig.pdf_image_parser_provider)}
                    </span>
                  </div>

                  {(serverConfig.file_parser_provider === 'mineru-accurate-api' || serverConfig.pdf_image_parser_provider === 'mineru-accurate-api') && (
                    <div className="model-config-server-item">
                      <div className="model-config-server-item-head">
                        <span className="model-config-server-item-icon model"><BrainIcon /></span>
                        <span className="model-config-server-label">MinerU Token</span>
                      </div>
                      <span className={serverConfig.has_mineru_token ? 'model-config-server-value' : 'model-config-server-value empty'}>
                        {serverConfig.has_mineru_token ? '已配置' : '（未配置）'}
                      </span>
                    </div>
                  )}
                </div>

                <div className="model-config-server-footer">
                  <InfoIcon />
                  <span>上方「接入信息」用于修改并「应用到服务器」；此处为服务器当前生效值。</span>
                </div>
              </section>
            )}

            <div className="model-config-hint-card">
              <InfoIcon />
              <span>
                「获取模型」按上方 Base URL + Key 拉取可用模型；「测试连接」验证可达性与鉴权；
                「测试解析（上传 PDF）」会弹出文件选择框，用你选中的真实 PDF 走一遍 MinerU 云端解析，验证 Token 与解析链路可用；
                「应用到服务器」将分析 / 问答 / 语义检索模型下发到服务器，对成员个人库与团队库的文档分析立即生效。
              </span>
            </div>

            <div className="model-config-actions">
              <button type="button" className="secondary-action" onClick={() => void testConnection()} disabled={testing}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              <button type="button" className="primary-action" onClick={() => void applyGlobal()} disabled={savingGlobal}>
                {savingGlobal ? '应用中…' : '应用到服务器'}
              </button>
            </div>
          </>
        ) : (
          <div className="model-config-empty-state">
            <LockIcon />
            <span>该配置仅管理员可查看与修改，如需变更请联系管理员</span>
          </div>
        )}
      </div>
    </div>
  );
}
