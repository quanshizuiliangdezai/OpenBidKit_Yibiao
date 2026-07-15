import { useEffect, useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { AccountInfo } from '../../../shared/types/config';

// 用户名：2-32 位，仅限中文、字母、数字、下划线或连字符。
const USERNAME_PATTERN = /^[一-龥A-Za-z0-9_-]{2,32}$/;

function formatToday(): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export default function AccountPage() {
  const { showToast } = useToast();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.yibiao.config.load()
      .then((config) => {
        const acc = config?.account ?? null;
        setAccount(acc);
        if (acc) {
          setUsername(acc.username);
          setDisplayName(acc.display_name || '');
        }
      })
      .catch((loadError) => {
        console.warn('读取账户失败', loadError);
        showToast('读取账户信息失败', 'error');
      })
      .finally(() => setLoading(false));
  }, [showToast]);

  async function handleRegister() {
    setError('');
    const trimmed = username.trim();
    if (!USERNAME_PATTERN.test(trimmed)) {
      setError('用户名需为 2-32 位，仅限中文、字母、数字、下划线或连字符');
      return;
    }

    setSaving(true);
    try {
      const fullConfig = await window.yibiao.config.load();
      const next: AccountInfo = {
        username: trimmed,
        display_name: displayName.trim(),
        registered_at: formatToday(),
      };
      await window.yibiao.config.save({ ...fullConfig, account: next });
      setAccount(next);
      showToast('注册成功，已保存你的上传身份', 'success');
    } catch (saveError) {
      console.warn('保存账户失败', saveError);
      showToast('保存失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    try {
      const fullConfig = await window.yibiao.config.load();
      await window.yibiao.config.save({ ...fullConfig, account: null });
      setAccount(null);
      setUsername('');
      setDisplayName('');
      showToast('已退出，可重新注册', 'success');
    } catch (saveError) {
      console.warn('重置账户失败', saveError);
      showToast('操作失败，请重试', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="settings-page">
        <div className="settings-page-scroll">
          <section className="settings-page-section">
            <div className="settings-section-title"><span /><strong>账户</strong></div>
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-row-copy"><span>正在读取账户信息…</span></div>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <div className="settings-page-scroll">
        <section className="settings-page-section">
          <div className="settings-section-title"><span /><strong>账户 / 注册</strong></div>

          {account ? (
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-row-copy">
                  <strong>当前身份</strong>
                  <span>你在共享知识库中的上传身份，所有上传的文档都会标记为该账号。</span>
                </div>
                <div className="settings-row-copy">
                  <strong>{account.display_name || account.username}</strong>
                  <span>账号：{account.username}　注册于：{account.registered_at || '—'}</span>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <strong>用途说明</strong>
                  <span>上传文档到共享知识库时，系统会以此账号作为来源标记（上传人 / 上传时间），便于团队追溯与区分同名文件。</span>
                </div>
                <div className="settings-action-cell">
                  <button type="button" className="inline-action" onClick={handleReset} disabled={saving}>
                    退出并重新注册
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-row-copy">
                  <strong>用户名 / 账号</strong>
                  <span>必填，2-32 位，仅限中文、字母、数字、下划线或连字符。这将作为你在共享知识库中的上传身份（上传人）。</span>
                </div>
                <input
                  type="text"
                  value={username}
                  placeholder="例如：zhangsan 或 张三"
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <strong>姓名 / 显示名</strong>
                  <span>选填，用于在知识库中展示更友好的来源名称。</span>
                </div>
                <input
                  type="text"
                  value={displayName}
                  placeholder="例如：张三"
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </div>
              {error ? (
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <span style={{ color: '#c83220' }}>{error}</span>
                  </div>
                </div>
              ) : null}
              <div className="settings-row">
                <div className="settings-row-copy">
                  <strong>注册</strong>
                  <span>注册后，你的上传身份会保存在本机配置中，用于共享知识库的上传标记。</span>
                </div>
                <div className="settings-action-cell">
                  <button type="button" className="inline-action" onClick={handleRegister} disabled={saving}>
                    注册并保存
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
