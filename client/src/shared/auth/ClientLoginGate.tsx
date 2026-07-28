import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { useToast } from '../ui';

const DEFAULT_SERVER = 'http://59.49.48.147:15004';

export function ClientLoginGate() {
  const auth = useAuth();
  const { showToast } = useToast();
  const sessionExpired = auth.sessionExpired;
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [department, setDepartment] = useState('');
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const usernameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // 退出登录重新弹出门禁时，确保页面与输入框都获得焦点；
    // 某些 Electron 环境下窗口或 webview 焦点会丢失，导致键盘输入无响应。
    window.focus();
    const timer = setTimeout(() => {
      usernameRef.current?.focus();
      usernameRef.current?.select();
    }, 50);
    return () => clearTimeout(timer);
  }, [mode]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrorMsg('');
    try {
      await auth.login(username.trim(), password, serverUrl.trim());
      showToast('登录成功', 'success');
    } catch (error) {
      const msg = (error as Error)?.message || '登录失败';
      setErrorMsg(msg);
      showToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const result = await window.yibiao.kbAuth.register({
        username: username.trim(),
        password,
        display_name: displayName.trim(),
        department: department.trim(),
        serverUrl: serverUrl.trim(),
      });
      if (!result?.success) throw new Error(result?.error || '注册失败');
      showToast('注册申请已提交，请等待管理员审核后再登录', 'success');
      setMode('login');
    } catch (error) {
      const msg = (error as Error)?.message || '注册失败';
      setErrorMsg(msg);
      showToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="client-login-gate">
      <div className="client-login-card">
        <div className="client-login-brand">
          <strong>易标 · 投标工具箱</strong>
          <span>请登录以使用全部功能</span>
        </div>

        {sessionExpired ? (
          <div className="client-login-expired">登录已过期，请重新登录以继续。</div>
        ) : null}

        <div className="client-login-tabs">
          <button
            type="button"
            className={mode === 'login' ? 'is-active' : ''}
            onClick={() => { setMode('login'); setErrorMsg(''); }}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'is-active' : ''}
            onClick={() => { setMode('register'); setErrorMsg(''); }}
          >
            注册
          </button>
        </div>

        {errorMsg ? <div className="client-login-error">{errorMsg}</div> : null}

        {mode === 'login' ? (
          <form className="client-login-form" onSubmit={handleLogin}>
            <label>
              服务器地址
              <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder={DEFAULT_SERVER} />
            </label>
            <label>
              用户名
              <input ref={usernameRef} autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
            </label>
            <label>
              密码
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button type="submit" className="client-login-submit" disabled={busy}>
              {busy ? '登录中…' : '登录'}
            </button>
          </form>
        ) : (
          <form className="client-login-form" onSubmit={handleRegister}>
            <label>
              服务器地址
              <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder={DEFAULT_SERVER} />
            </label>
            <label>
              姓名
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus required />
            </label>
            <label>
              用户名
              <input value={username} onChange={(e) => setUsername(e.target.value)} required />
            </label>
            <label>
              部门（选填）
              <input value={department} onChange={(e) => setDepartment(e.target.value)} />
            </label>
            <label>
              密码（至少 6 位）
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button type="submit" className="client-login-submit" disabled={busy}>
              {busy ? '提交中…' : '提交注册'}
            </button>
            <p className="client-login-hint">注册后需管理员在「账户列表」中审核通过，方可登录。</p>
          </form>
        )}
      </div>
    </div>
  );
}
