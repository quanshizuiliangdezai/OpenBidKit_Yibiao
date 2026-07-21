import type { KbAuthStatus } from '../../../shared/types/ipc';

interface KbUserBarProps {
  status: KbAuthStatus;
  onLogout: () => void;
}

// 方案 D 团队库顶部用户信息条：显示当前登录用户名 + 登出按钮。
function KbUserBar({ status, onLogout }: KbUserBarProps) {
  const employee = status.employee;
  const displayName = employee?.display_name || employee?.username || '未知用户';
  const roleLabel = employee?.role === 'admin' ? '管理员' : '员工';

  return (
    <div className="kb-user-bar">
      <span className="kb-user-bar-name">{displayName}</span>
      <span className="kb-user-bar-role">{roleLabel}</span>
      <button type="button" className="secondary-action kb-user-bar-logout" onClick={onLogout}>
        退出登录
      </button>
    </div>
  );
}

export default KbUserBar;
