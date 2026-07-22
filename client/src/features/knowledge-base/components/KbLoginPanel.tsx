import { useEffect, useState } from 'react';
import type { KbAuthStatus } from '../../../shared/types/ipc';

interface KbLoginPanelProps {
  onLoggedIn: (status: KbAuthStatus) => void;
}

// 方案 D 团队库登录/注册面板：未登录时在知识库页中央显示。登录走 IPC；注册提交到服务器创建 pending 账号。
function KbLoginPanel({ onLoggedIn }: KbLoginPanelProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [serverUrl, setServerUrl] = useState('http://59.49.48.147:15004');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [department, setDepartment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    void window.yibiao?.kbAuth.getStatus().then((status) => {
      if (status?.serverUrl) setServerUrl(status.serverUrl);
    }).catch(() => {});
  }, []);

  const handleLogin = async (event: React.FormEvent) => {
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

  const handleRegister = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await window.yibiao?.kbAuth.register({
        username: username.trim(),
        password,
        display_name: displayName.trim(),
        department: department.trim(),
        serverUrl,
      });
      if (!result?.success) {
        setError(result?.error || '注册失败');
        return;
      }
      setRegistered(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败');
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setError('');
    setRegistered(false);
  };

  if (registered) {
    return (
      <div className="kb-login-panel">
        <div className="kb-login-card">
          <div className="kb-login-head">
            <h2>注册申请已提交</h2>
            <p>账号已创建，等待管理员审核通过后即可登录。</p>
          </div>
          <div className="kb-login-actions">
            <button type="button" className="primary-action" onClick={() => switchMode('login')}>
              返回登录
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="kb-login-panel">
      <div className="kb-login-card">
        <div className="kb-login-head">
          <h2>{mode === 'login' ? '团队知识库' : '注册团队账号'}</h2>
          <p>{mode === 'login' ? '登录后可查看和管理团队共享知识库' : '填写信息提交注册，审核通过后即可使用'}</p>
        </div>
        <form className="kb-login-form" onSubmit={mode === 'login' ? handleLogin : handleRegister}>
          {mode === 'register' && (
            <>
              <label className="kb-login-field">
                <span>姓名</span>
                <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="请输入姓名" disabled={submitting} />
              </label>
              <label className="kb-login-field">
                <span>部门</span>
                <input type="text" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="请输入部门（选填）" disabled={submitting} />
              </label>
            </>
          )}
          <label className="kb-login-field">
            <span>服务器地址</span>
            <input type="text" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://59.49.48.147:15004" disabled={submitting} />
          </label>
          <label className="kb-login-field">
            <span>用户名</span>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="请输入用户名" disabled={submitting} autoFocus />
          </label>
          <label className="kb-login-field">
            <span>密码</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入密码" disabled={submitting} />
          </label>
          {error && <div className="kb-login-error">{error}</div>}
          <div className="kb-login-actions">
            <button type="submit" className="primary-action" disabled={submitting}>
              {submitting ? '处理中...' : (mode === 'login' ? '登录' : '提交注册')}
            </button>
          </div>
        </form>
        <div className="kb-login-hint">
          {mode === 'login' ? (
            <p>还没有账号？<a href="#" onClick={(e) => { e.preventDefault(); switchMode('register'); }}>立即注册</a></p>
          ) : (
            <p>已有账号？<a href="#" onClick={(e) => { e.preventDefault(); switchMode('login'); }}>去登录</a></p>
          )}
        </div>
      </div>
    </div>
  );
}

export default KbLoginPanel;
