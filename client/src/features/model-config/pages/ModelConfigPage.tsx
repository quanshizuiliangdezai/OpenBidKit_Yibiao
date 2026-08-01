import { useEffect, useState } from 'react';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/auth/AuthContext';

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
  const [serverConfig, setServerConfig] = useState<{
    base_url?: string;
    analysis_model?: string;
    embedding_model?: string;
  } | null>(null);

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
        });
        setGlobalEmbedding(res.data.embedding_model || '');
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
    if (!baseUrl.trim()) { showToast('请先填写 API Base URL', 'info'); return; }
    if (!apiKey.trim()) { showToast('请先填写 API Key', 'info'); return; }
    setLoadingModels(true);
    try {
      // 用完整的本地配置对象作为基底，再覆盖当前表单值，保证与设置页调用口径完全一致。
      const cfg = (await window.yibiao?.config.load()) as unknown as Record<string, unknown> | undefined;
      const probe = {
        ...(cfg || {}),
        base_url: baseUrl.trim(),
        api_key: apiKey.trim(),
        model_name: model.trim(),
      };
      const result = await window.yibiao?.config.listModels(probe as never);
      const list = result?.models || [];
      setModels(list);
      if (result?.success && list.length) {
        showToast(`获取到 ${list.length} 个模型`, 'success');
        if (!list.includes(model)) setModel(list[0]);
      } else {
        showToast(result?.message || '未获取到模型列表', 'info');
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
                      <input
                        list="model-config-list"
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                        placeholder="agens2.5"
                      />
                      <datalist id="model-config-list">
                        {models.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
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
              </div>
            </section>

            {serverConfig && (serverConfig.base_url || serverConfig.analysis_model || serverConfig.embedding_model) && (
              <section className="model-config-card model-config-server-card">
                <div className="model-config-section-title">
                  服务器当前已部署配置
                  <span className="model-config-readonly-badge">只读</span>
                </div>
                <div className="model-config-server-grid">
                  <div className="model-config-server-item">
                    <span className="model-config-server-label">API Base URL</span>
                    <span className="model-config-server-value">{serverConfig.base_url || '（未配置）'}</span>
                  </div>
                  <div className="model-config-server-item">
                    <span className="model-config-server-label">分析 / 问答模型</span>
                    <span className="model-config-server-value">{serverConfig.analysis_model || '（未配置）'}</span>
                  </div>
                  <div className="model-config-server-item">
                    <span className="model-config-server-label">语义检索模型</span>
                    <span className="model-config-server-value">{serverConfig.embedding_model || '（未配置）'}</span>
                  </div>
                </div>
                <span className="model-config-field-hint">
                  上方「接入信息」用于修改并「应用到服务器」；此处为服务器当前生效值（密钥不回传，故不显示）。
                </span>
              </section>
            )}

            <div className="model-config-hint-card">
              <InfoIcon />
              <span>
                「获取模型」按上方 Base URL + Key 拉取可用模型；「测试连接」验证可达性与鉴权；
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
