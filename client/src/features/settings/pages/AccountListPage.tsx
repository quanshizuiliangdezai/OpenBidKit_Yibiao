import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/auth/AuthContext';

interface EmployeeRow {
  id: string | number;
  username: string;
  display_name: string;
  department?: string | null;
  role: 'admin' | 'employee';
  status: string;
  created_at?: string;
  groups?: Array<{ id: string | number; name: string }>;
}

type StatusFilter = 'all' | 'pending' | 'approved' | 'disabled' | 'rejected';

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

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已通过' },
  { key: 'disabled', label: '已禁用' },
  { key: 'rejected', label: '已拒绝' },
];

export default function AccountListPage() {
  const auth = useAuth();
  const { showToast } = useToast();
  const myId = auth.employee?.id;

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ username: '', display_name: '', department: '', password: '', role: 'employee', status: 'approved' });
  const [addError, setAddError] = useState('');
  const [adding, setAdding] = useState(false);

  const [resetTarget, setResetTarget] = useState<EmployeeRow | null>(null);
  const [resetPwd, setResetPwd] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetting, setResetting] = useState(false);

  const [editTarget, setEditTarget] = useState<EmployeeRow | null>(null);
  const [editForm, setEditForm] = useState<{
    display_name: string;
    department: string;
    role: string;
    status: string;
    group_ids: Array<string | number>;
  }>({ display_name: '', department: '', role: 'employee', status: 'approved', group_ids: [] });
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);
  const [groupOptions, setGroupOptions] = useState<Array<{ id: string | number; name: string }>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.yibiao.kbAuth.listEmployees();
      if (!res?.success) throw new Error(res?.error || '获取员工列表失败');
      setEmployees((res.data || []) as EmployeeRow[]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取员工列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: employees.length, pending: 0, approved: 0, disabled: 0, rejected: 0 };
    employees.forEach((e) => {
      const key = (e.status || 'pending') as StatusFilter;
      if (key in c) c[key] += 1;
    });
    return c;
  }, [employees]);

  const visible = useMemo(
    () => (filter === 'all' ? employees : employees.filter((e) => (e.status || 'pending') === filter)),
    [employees, filter],
  );

  const flash = (msg: string, isError = false) => {
    setNotice(msg);
    if (isError) showToast(msg, 'error');
    else showToast(msg, 'success');
  };

  const approve = async (e: EmployeeRow) => {
    try {
      const res = await window.yibiao.kbAuth.review({ user_id: e.id, action: 'approve' });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已通过 ${e.display_name || e.username} 的注册`);
      await load();
    } catch (error) {
      flash(error instanceof Error ? error.message : '操作失败', true);
    }
  };

  const reject = async (e: EmployeeRow) => {
    const reason = window.prompt(`拒绝 ${e.display_name || e.username} 的理由（选填）`);
    if (reason === null) return;
    try {
      const res = await window.yibiao.kbAuth.review({ user_id: e.id, action: 'reject', reject_reason: reason || undefined });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已拒绝 ${e.display_name || e.username}`);
      await load();
    } catch (error) {
      flash(error instanceof Error ? error.message : '操作失败', true);
    }
  };

  const toggleStatus = async (e: EmployeeRow) => {
    const next = e.status === 'disabled' ? 'approved' : 'disabled';
    const label = next === 'disabled' ? '禁用' : '启用';
    try {
      const res = await window.yibiao.kbAuth.setStatus({ user_id: e.id, status: next });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已${label} ${e.display_name || e.username}`);
      await load();
    } catch (error) {
      flash(error instanceof Error ? error.message : '操作失败', true);
    }
  };

  const resetPassword = async (e: EmployeeRow) => {
    setResetTarget(e);
    setResetPwd('');
    setResetError('');
  };

  const confirmReset = async () => {
    if (!resetTarget) return;
    if (resetPwd.length < 6) {
      setResetError('密码至少 6 位');
      return;
    }
    setResetting(true);
    try {
      const res = await window.yibiao.kbAuth.resetPassword({ user_id: resetTarget.id, new_password: resetPwd });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已重置 ${resetTarget.display_name || resetTarget.username} 的密码`);
      setResetTarget(null);
    } catch (error) {
      setResetError(error instanceof Error ? error.message : '操作失败');
    } finally {
      setResetting(false);
    }
  };

  const openEdit = async (e: EmployeeRow) => {
    setEditTarget(e);
    setEditForm({
      display_name: e.display_name || '',
      department: e.department || '',
      role: e.role,
      status: e.status || 'approved',
      group_ids: (e.groups || []).map((g) => g.id),
    });
    setEditError('');
    try {
      const res = await window.yibiao.kbAuth.listGroups();
      if (res?.success) setGroupOptions(res.data || []);
    } catch {
      // 分组列表获取失败不阻断编辑
    }
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    if (!editForm.display_name.trim()) {
      setEditError('姓名不能为空');
      return;
    }
    setSaving(true);
    try {
      const res = await window.yibiao.kbAuth.updateEmployee({
        user_id: editTarget.id,
        fields: {
          display_name: editForm.display_name.trim(),
          department: editForm.department.trim() || null,
          role: editForm.role,
          status: editForm.status,
          group_ids: editForm.group_ids,
        },
      });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已更新 ${editForm.display_name}`);
      setEditTarget(null);
      await load();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : '操作失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (e: EmployeeRow) => {
    if (String(e.id) === String(myId)) {
      flash('不能删除当前登录账号', true);
      return;
    }
    if (!window.confirm(`确定删除 ${e.display_name || e.username}？其名下知识库文档与文件夹将保留并解绑，仅删除账号本身。`)) return;
    try {
      const res = await window.yibiao.kbAuth.deleteEmployee({ user_id: e.id });
      if (!res?.success) throw new Error(res?.error || '操作失败');
      flash(`已删除 ${e.display_name || e.username}`);
      await load();
    } catch (error) {
      flash(error instanceof Error ? error.message : '操作失败', true);
    }
  };

  const submitAdd = async (event: FormEvent) => {
    event.preventDefault();
    setAddError('');
    const username = addForm.username.trim();
    const displayName = addForm.display_name.trim();
    if (!username || !displayName) {
      setAddError('用户名和姓名均必填');
      return;
    }
    if (addForm.password.length < 6) {
      setAddError('密码至少 6 位');
      return;
    }
    setAdding(true);
    try {
      const res = await window.yibiao.kbAuth.adminCreateEmployee({
        username,
        password: addForm.password,
        display_name: displayName,
        department: addForm.department.trim() || undefined,
        role: addForm.role,
        status: addForm.status,
      });
      if (!res?.success) throw new Error(res?.error || '创建失败');
      flash(`已创建账号 ${displayName}`);
      setShowAdd(false);
      setAddForm({ username: '', display_name: '', department: '', password: '', role: 'employee', status: 'approved' });
      await load();
    } catch (error) {
      setAddError(error instanceof Error ? error.message : '创建失败');
    } finally {
      setAdding(false);
    }
  };

  const renderActions = (e: EmployeeRow) => {
    const isSelf = String(e.id) === String(myId);
    const st = e.status || 'pending';
    const buttons: Array<{ key: string; label: string; className: string; onClick: () => void }> = [];
    if (st === 'pending' || st === 'rejected') {
      buttons.push({ key: 'approve', label: '通过', className: 'kb-admin-approve', onClick: () => void approve(e) });
    }
    if (st === 'pending') {
      buttons.push({ key: 'reject', label: '拒绝', className: 'kb-admin-reject', onClick: () => void reject(e) });
    }
    if (st === 'approved' || st === 'disabled') {
      buttons.push({ key: 'reset', label: '重置密码', className: 'kb-admin-reset', onClick: () => void resetPassword(e) });
      buttons.push({
        key: 'toggle',
        label: st === 'disabled' ? '启用' : '禁用',
        className: 'kb-admin-toggle',
        onClick: () => void toggleStatus(e),
      });
    }
    buttons.push({ key: 'edit', label: '编辑', className: 'kb-admin-edit', onClick: () => void openEdit(e) });
    if (!isSelf && e.role !== 'admin') {
      buttons.push({ key: 'delete', label: '删除', className: 'kb-admin-delete', onClick: () => void remove(e) });
    }
    return buttons;
  };

  return (
    <div className="settings-page">
      <div className="settings-page-scroll">
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>账户列表</strong>
          </div>

          <div className="account-list-toolbar">
            <p className="account-list-desc">
              管理团队成员账号：添加成员、审核注册申请、重置密码、启用 / 禁用以及删除账号。账号状态与权限分组联动。
            </p>
            <button type="button" className="inline-action account-add-button" onClick={() => setShowAdd(true)}>
              + 添加成员
            </button>
          </div>

          <div className="account-filter-tabs">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`account-filter-tab ${filter === f.key ? 'is-active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <em>{counts[f.key]}</em>
              </button>
            ))}
          </div>

          <div className="account-table-wrap">
            {loading ? (
              <div className="kb-admin-empty">加载中…</div>
            ) : visible.length === 0 ? (
              <div className="kb-admin-empty">该分类下暂无账号</div>
            ) : (
              <table className="kb-admin-table account-table">
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>用户名</th>
                    <th>部门</th>
                    <th>角色</th>
                    <th>分组</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((e) => (
                    <tr key={e.id}>
                      <td>{e.display_name || '-'}</td>
                      <td>{e.username}</td>
                      <td>{typeof e.department === 'string' && e.department ? e.department : '-'}</td>
                      <td>{e.role === 'admin' ? '管理员' : '员工'}</td>
                      <td>
                        {e.groups && e.groups.length ? (
                          <span className="account-group-tags">
                            {e.groups.map((g) => (
                              <span key={g.id} className="account-group-tag">{g.name}</span>
                            ))}
                          </span>
                        ) : (
                          <span className="account-group-none">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`kb-admin-tag ${STATUS_CLASS[e.status || 'pending'] || 'pending'}`}>
                          {STATUS_LABEL[e.status || 'pending'] || e.status}
                        </span>
                      </td>
                      <td className="kb-admin-ops">
                        {renderActions(e).map((b) => (
                          <button key={b.key} type="button" className={b.className} onClick={b.onClick}>
                            {b.label}
                          </button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {notice ? <div className="kb-admin-notice">{notice}</div> : null}
        </section>
      </div>

      <Dialog.Root open={showAdd} onOpenChange={(open) => !open && setShowAdd(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <div className="content-regenerate-card-head">
              <Dialog.Title>添加成员</Dialog.Title>
              <Dialog.Description>由管理员直接创建账号，创建后该成员立即可用（状态默认「已通过」）。</Dialog.Description>
            </div>
            <form className="account-form" onSubmit={submitAdd}>
              <label>
                用户名（登录账号）
                <input value={addForm.username} onChange={(ev) => setAddForm({ ...addForm, username: ev.target.value })} placeholder="例如 zhangsan" required />
              </label>
              <label>
                姓名 / 显示名
                <input value={addForm.display_name} onChange={(ev) => setAddForm({ ...addForm, display_name: ev.target.value })} placeholder="例如 张三" required />
              </label>
              <label>
                部门（选填）
                <input value={addForm.department} onChange={(ev) => setAddForm({ ...addForm, department: ev.target.value })} placeholder="例如 商务部" />
              </label>
              <label>
                初始密码（至少 6 位）
                <input type="password" value={addForm.password} onChange={(ev) => setAddForm({ ...addForm, password: ev.target.value })} required />
              </label>
              <div className="account-form-row">
                <label>
                  角色
                  <select value={addForm.role} onChange={(ev) => setAddForm({ ...addForm, role: ev.target.value })}>
                    <option value="employee">员工</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                <label>
                  状态
                  <select value={addForm.status} onChange={(ev) => setAddForm({ ...addForm, status: ev.target.value })}>
                    <option value="approved">已通过</option>
                    <option value="pending">待审核</option>
                    <option value="disabled">已禁用</option>
                  </select>
                </label>
              </div>
              {addError ? <p className="account-form-error">{addError}</p> : null}
              <div className="content-regenerate-actions">
                <button type="button" className="secondary-action" onClick={() => setShowAdd(false)}>取消</button>
                <button type="submit" className="primary-action" disabled={adding}>{adding ? '创建中…' : '创建账号'}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(resetTarget)} onOpenChange={(open) => !open && setResetTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <div className="content-regenerate-card-head">
              <Dialog.Title>重置密码</Dialog.Title>
              <Dialog.Description>
                为 {resetTarget ? (resetTarget.display_name || resetTarget.username) : ''} 设置新密码，重置后该成员需使用新密码重新登录。
              </Dialog.Description>
            </div>
            <form className="account-form" onSubmit={(ev) => { ev.preventDefault(); void confirmReset(); }}>
              <label>
                新密码（至少 6 位）
                <input type="password" value={resetPwd} onChange={(ev) => setResetPwd(ev.target.value)} autoFocus required />
              </label>
              {resetError ? <p className="account-form-error">{resetError}</p> : null}
              <div className="content-regenerate-actions">
                <button type="button" className="secondary-action" onClick={() => setResetTarget(null)}>取消</button>
                <button type="submit" className="primary-action" disabled={resetting}>{resetting ? '保存中…' : '保存新密码'}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(editTarget)} onOpenChange={(open) => !open && setEditTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <div className="content-regenerate-card-head">
              <Dialog.Title>编辑成员</Dialog.Title>
              <Dialog.Description>
                修改 {editTarget ? (editTarget.display_name || editTarget.username) : ''} 的资料、角色、状态与所属分组。
              </Dialog.Description>
            </div>
            <form className="account-form" onSubmit={(ev) => { ev.preventDefault(); void saveEdit(); }}>
              <label>
                姓名 / 显示名
                <input value={editForm.display_name} onChange={(ev) => setEditForm({ ...editForm, display_name: ev.target.value })} placeholder="例如 张三" required />
              </label>
              <label>
                部门（选填）
                <input value={editForm.department} onChange={(ev) => setEditForm({ ...editForm, department: ev.target.value })} placeholder="例如 商务部" />
              </label>
              <div className="account-form-row">
                <label>
                  角色（权限）
                  <select value={editForm.role} onChange={(ev) => setEditForm({ ...editForm, role: ev.target.value })}>
                    <option value="employee">员工</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                <label>
                  状态
                  <select value={editForm.status} onChange={(ev) => setEditForm({ ...editForm, status: ev.target.value })}>
                    <option value="approved">已通过</option>
                    <option value="pending">待审核</option>
                    <option value="disabled">已禁用</option>
                    <option value="rejected">已拒绝</option>
                  </select>
                </label>
              </div>
              <div className="account-form-groups">
                <span className="account-form-label">权限分组</span>
                {groupOptions.length === 0 ? (
                  <p className="account-form-hint">暂无分组，请先在「权限管理」页面创建分组。</p>
                ) : (
                  <div className="account-group-checks">
                    {groupOptions.map((g) => (
                      <label key={g.id} className="account-group-check">
                        <input
                          type="checkbox"
                          checked={editForm.group_ids.includes(g.id)}
                          onChange={(ev) => {
                            const id = g.id;
                            setEditForm((prev) => ({
                              ...prev,
                              group_ids: ev.target.checked
                                ? [...prev.group_ids, id]
                                : prev.group_ids.filter((x) => x !== id),
                            }));
                          }}
                        />
                        {g.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              {editError ? <p className="account-form-error">{editError}</p> : null}
              <div className="content-regenerate-actions">
                <button type="button" className="secondary-action" onClick={() => setEditTarget(null)}>取消</button>
                <button type="submit" className="primary-action" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
