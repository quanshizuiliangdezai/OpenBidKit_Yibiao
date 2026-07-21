import { useEffect, useState } from 'react';
import type { KbAuthStatus } from '../../../shared/types/ipc';

interface KbLoginPanelProps {
  onLoggedIn: (status: KbAuthStatus) => void;
}

// 方案 D 团队库登录面板：未登录时在知识库页中央显示，引导用户登录中央服务器。
function KbLoginPanel({ onLoggedIn }: KbLoginPanelProps) {
  const [serverUrl, setServerUrl] = useState('http://59.49.48.147:15004');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void window.yibiao?.kbAuth.getStatus().then((status) => {
      if (status?.serverUrl) setServerUrl(status.serverUrl);
    }).catch(() => {});
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await window.yibiao?.kbAuth.login({ username: username.trim(), password, serverUrl });
      if (!result?.success) {
        setError(result?.error || '登录失败');
        return;
      }
      const status = await window.yibiao?.kbAuth.getStatus();
      if (status) onLoggedIn(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="kb-login-panel">
      <div className="kb-login-card">
        <div className="kb-login-head">
          <h2>团队知识库</h2>
          <p>登录后可查看和管理团队共享知识库</p>
        </div>
        <form className="kb-login-form" onSubmit={handleSubmit}>
          <label className="kb-login-field">
            <span>服务器地址</span>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://59.49.48.147:15004"
              disabled={submitting}
            />
          </label>
          <label className="kb-login-field">
            <span>用户名</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              disabled={submitting}
              autoFocus
            />
          </label>
          <label className="kb-login-field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              disabled={submitting}
            />
          </label>
          {error && <div className="kb-login-error">{error}</div>}
          <div className="kb-login-actions">
            <button type="submit" className="primary-action" disabled={submitting}>
              {submitting ? '登录中...' : '登录'}
            </button>
          </div>
        </form>
        <div className="kb-login-hint">
          <p>还没有账号？请联系管理员注册并审核通过后登录。</p>
        </div>
      </div>
    </div>
  );
}

export default KbLoginPanel;
