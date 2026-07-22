import { useEffect, useState, type ReactNode } from 'react';
import type { KbAuthEmployee, KbAuthStatus } from '../../../shared/types/ipc';

interface KbAdminPanelProps {
  status: KbAuthStatus | null;
  onClose: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
  disabled: '已禁用',
};

const STATUS_CLASS: Record<string, string> = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  disabled: 'disabled',
};

function KbAdminPanel({ status, onClose }: KbAdminPanelProps) {
  const myId = status?.employee?.id;
  const [employees, setEmployees] = useState<KbAuthEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await window.yibiao?.kbAuth.listEmployees();
      if (!res?.success) {
        throw new Error(res?.error || '获取员工列表失败');
      }
      setEmployees(res.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取员工列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const flash = (msg: string, isError = false) => {
    setNotice(msg);
    if (isError) setError(msg);
  };

  const approve = async (e: KbAuthEmployee) => {
    try {
      const res = await window.yibiao?.kbAuth.review({ user_id: e.id, action: 'approve' });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已通过 ${e.display_name || e.username} 的注册`);
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : '操作失败', true);
    }
  };

  const reject = async (e: KbAuthEmployee) => {
    const reason = window.prompt(`拒绝 ${e.display_name || e.username} 的理由（选填）`);
    if (reason === null) return;
    try {
      const res = await window.yibiao?.kbAuth.review({ user_id: e.id, action: 'reject', reject_reason: reason || undefined });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已拒绝 ${e.display_name || e.username}`);
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : '操作失败', true);
    }
  };

  const toggleStatus = async (e: KbAuthEmployee) => {
    const next = e.status === 'disabled' ? 'approved' : 'disabled';
    const label = next === 'disabled' ? '禁用' : '启用';
    try {
      const res = await window.yibiao?.kbAuth.setStatus({ user_id: e.id, status: next });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已${label} ${e.display_name || e.username}`);
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : '操作失败', true);
    }
  };

  const resetPwd = async (e: KbAuthEmployee) => {
    const pwd = window.prompt(`为 ${e.display_name || e.username} 设置新密码（至少 6 位）`);
    if (!pwd) return;
    if (pwd.length < 6) {
      flash('密码长度至少 6 位', true);
      return;
    }
    try {
      const res = await window.yibiao?.kbAuth.resetPassword({ user_id: e.id, new_password: pwd });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已重置 ${e.display_name || e.username} 的密码`);
    } catch (err) {
      flash(err instanceof Error ? err.message : '操作失败', true);
    }
  };

  const remove = async (e: KbAuthEmployee) => {
    if (!window.confirm(`确定删除 ${e.display_name || e.username}？其名下文件夹与文档将一并删除。`)) return;
    try {
      const res = await window.yibiao?.kbAuth.deleteEmployee({ user_id: e.id });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已删除 ${e.display_name || e.username}`);
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : '操作失败', true);
    }
  };

  const renderActions = (e: KbAuthEmployee) => {
    const isSelf = String(e.id) === String(myId);
    const st = e.status || 'pending';
    const buttons: ReactNode[] = [];
    if (st === 'pending' || st === 'rejected') {
      buttons.push(<button key="approve" className="kb-admin-approve" onClick={() => approve(e)}>通过</button>);
    }
    if (st === 'pending') {
      buttons.push(<button key="reject" className="kb-admin-reject" onClick={() => reject(e)}>拒绝</button>);
    }
    if (st === 'approved' || st === 'disabled') {
      buttons.push(<button key="reset" className="kb-admin-reset" onClick={() => resetPwd(e)}>重置密码</button>);
      buttons.push(
        <button key="toggle" className="kb-admin-toggle" onClick={() => toggleStatus(e)}>
          {st === 'disabled' ? '启用' : '禁用'}
        </button>,
      );
    }
    if (!isSelf) {
      buttons.push(<button key="delete" className="kb-admin-delete" onClick={() => remove(e)}>删除</button>);
    }
    return buttons;
  };

  return (
    <div className="kb-admin-panel">
      <div className="kb-admin-head">
        <h3>用户管理</h3>
        <div className="kb-admin-head-actions">
          <button type="button" className="kb-admin-refresh" onClick={() => void load()}>刷新</button>
          <button type="button" className="kb-admin-close" onClick={onClose}>关闭</button>
        </div>
      </div>
      {notice && <div className="kb-admin-notice">{notice}</div>}
      {error && <div className="kb-admin-error">{error}</div>}
      <div className="kb-admin-table-wrap">
        {loading ? (
          <div className="kb-admin-empty">加载中...</div>
        ) : employees.length === 0 ? (
          <div className="kb-admin-empty">暂无员工</div>
        ) : (
          <table className="kb-admin-table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>姓名</th>
                <th>部门</th>
                <th>角色</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id}>
                  <td>{e.username}</td>
                  <td>{e.display_name || '-'}</td>
                  <td>{typeof e.department === 'string' ? e.department : '-'}</td>
                  <td>{e.role === 'admin' ? '管理员' : '员工'}</td>
                  <td>
                    <span className={`kb-admin-tag ${STATUS_CLASS[e.status || 'pending'] || 'pending'}`}>
                      {STATUS_LABEL[e.status || 'pending'] || e.status}
                    </span>
                  </td>
                  <td className="kb-admin-ops">{renderActions(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default KbAdminPanel;
