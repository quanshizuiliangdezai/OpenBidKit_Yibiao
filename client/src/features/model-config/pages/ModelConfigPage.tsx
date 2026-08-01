import { useEffect, useState } from 'react';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/auth/AuthContext';

export default function ModelConfigPage() {
  const { showToast } = useToast();
  const { isAdmin } = useAuth();

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savingLocal, setSavingLocal] = useState(false);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [globalEmbedding, setGlobalEmbedding] = useState('');
  const [fullConfig, setFullConfig] = useState<Record<string, unknown> | null>(null);

  const loadConfig = async () => {
    setModels([]);
    try {
      const cfg = (await window.yibiao?.config.load()) as unknown as Record<string, unknown> | undefined;
      setFullConfig(cfg || null);
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
    if (isAdmin) {
      try {
        const res = await window.yibiao?.config.loadGlobal();
        if (res?.success && res.data) {
          setGlobalEmbedding(res.data.embedding_model || '');
          if (res.data.base_url) setBaseUrl(res.data.base_url);
          if (res.data.analysis_model) setModel(res.data.analysis_model);
        }
      } catch {
        /* 忽略读取失败 */
      }
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
      const probe = { ...(fullConfig || {}), base_url: baseUrl.trim(), api_key: apiKey.trim(), model_name: model.trim() };
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
    setTesting(true);
    try {
      const probe = { ...(fullConfig || {}), base_url: baseUrl.trim(), api_key: apiKey.trim(), model_name: model.trim() };
      const result = await window.yibiao?.config.listModels(probe as never);
      if (result?.success) showToast('连接成功（模型列表可获取）', 'success');
      else showToast(result?.message || '连接失败', 'error');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '连接测试失败', 'error');
    } finally {
      setTesting(false);
    }
  };

  const saveLocal = async () => {
    if (!baseUrl.trim() || !apiKey.trim() || !model.trim()) {
      showToast('Base URL、API Key、模型名称均不能为空', 'error');
      return;
    }
    if (!fullConfig) {
      showToast('无法读取本机配置，请重试', 'error');
      return;
    }
    setSavingLocal(true);
    try {
      const provider = 'custom';
      const profiles = (fullConfig.text_model_profiles as Record<string, Record<string, unknown>>) || {};
      const prev = profiles[provider] || {};
      const newProfile = {
        ...(fullConfig.text_model_provider === provider ? prev : {}),
        api_key: apiKey.trim(),
        base_url: baseUrl.trim(),
        model_name: model.trim(),
        reasoning_effort: prev.reasoning_effort || '',
        context_length_limit: prev.context_length_limit || 0,
        concurrency_limit: prev.concurrency_limit || 2,
        temperature_enabled: prev.temperature_enabled ?? false,
        temperature: prev.temperature ?? 0.7,
        request_mode: prev.request_mode || 'normal',
      };
      const updated = {
        ...fullConfig,
        text_model_provider: provider,
        text_model_profiles: { ...profiles, [provider]: newProfile },
      };
      const res = await window.yibiao?.config.save(updated as never);
      if (res?.success) {
        setFullConfig(updated);
        showToast('已保存到本机（个人库本地分析生效）', 'success');
      } else {
        showToast(res?.message || '保存失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      setSavingLocal(false);
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
      if (res?.success) showToast('已应用到服务器（团队库分析 + 问答生效）', 'success');
      else showToast(res?.error || '应用失败', 'error');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '应用失败', 'error');
    } finally {
      setSavingGlobal(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-page-scroll">
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>模型配置</strong>
          </div>

          <div className="settings-row">
            <div className="settings-row-copy">
              <strong>AI 模型接入</strong>
              <span>
                配置后个人库本地分析、团队库服务器分析、问答将使用该模型。
                {isAdmin
                  ? ' 管理员可把配置应用到服务器，对全体成员生效。'
                  : ' 服务器配置仅管理员可修改，你当前只能保存到本机。'}
              </span>
            </div>
          </div>

          <div className="knowledge-sync-form" style={{ marginTop: 8 }}>
            <label className="knowledge-sync-field">
              <span>API Base URL</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://apihub.agnes-ai.cn/v1"
              />
            </label>
            <label className="knowledge-sync-field">
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={isAdmin ? '留空 = 应用到服务器时沿用现有密钥' : '请输入 API Key'}
              />
            </label>
            <label className="knowledge-sync-field">
              <span>模型名称</span>
              <div className="knowledge-sync-model-row">
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
                <button type="button" className="secondary-action" onClick={() => void fetchModels()} disabled={loadingModels}>
                  {loadingModels ? '获取中…' : '获取模型'}
                </button>
              </div>
            </label>
            {isAdmin && (
              <label className="knowledge-sync-field">
                <span>语义检索模型名（可选）</span>
                <input
                  value={globalEmbedding}
                  onChange={(event) => setGlobalEmbedding(event.target.value)}
                  placeholder="留空则服务器不启用独立 embedding 模型"
                />
              </label>
            )}
          </div>

          <p className="knowledge-sync-hint">
            「获取模型」按上方 Base URL + Key 拉取可用模型；「测试连接」验证可达性与鉴权；
            「保存到本机」用于个人库本地分析，「应用到服务器」用于团队库分析与问答（需管理员）。
          </p>

          <div className="knowledge-sync-actions">
            <button type="button" className="secondary-action" onClick={() => void testConnection()} disabled={testing}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button type="button" className="primary-action" onClick={() => void saveLocal()} disabled={savingLocal}>
              {savingLocal ? '保存中…' : '保存到本机'}
            </button>
            {isAdmin && (
              <button type="button" className="sync-action" onClick={() => void applyGlobal()} disabled={savingGlobal}>
                {savingGlobal ? '应用中…' : '应用到服务器'}
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
