import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/auth/AuthContext';
import type { KbPermissionDef, KbPermissionGroup } from '../../../shared/types/ipc';

interface EmployeeRow {
  id: string | number;
  username: string;
  display_name: string;
  department?: string | null;
  role: 'admin' | 'employee';
  status: string;
  groups?: Array<{ id: string | number; name: string }>;
}

export default function PermissionListPage() {
  const auth = useAuth();
  const { showToast } = useToast();
  const isAdmin = auth.isAdmin;

  const [catalog, setCatalog] = useState<KbPermissionDef[]>([]);
  const [groups, setGroups] = useState<KbPermissionGroup[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '' });
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

  const [editing, setEditing] = useState<KbPermissionGroup | null>(null);
  const [editPerms, setEditPerms] = useState<Set<string>>(new Set());
  const [editMembers, setEditMembers] = useState<Set<string>>(new Set());
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [catRes, grpRes, empRes] = await Promise.all([
        window.yibiao.kbAuth.listPermissions(),
        window.yibiao.kbAuth.listGroups(),
        window.yibiao.kbAuth.listEmployees(),
      ]);
      if (!catRes?.success) throw new Error(catRes?.error || '获取权限目录失败');
      if (!grpRes?.success) throw new Error(grpRes?.error || '获取权限分组失败');
      if (!empRes?.success) throw new Error(empRes?.error || '获取成员列表失败');
      setCatalog(catRes.data || []);
      setGroups(grpRes.data || []);
      setEmployees((empRes.data || []) as EmployeeRow[]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const flash = (msg: string, isError = false) => {
    setNotice(msg);
    if (isError) showToast(msg, 'error');
    else showToast(msg, 'success');
  };

  const openCreate = () => {
    setCreateForm({ name: '', description: '' });
    setCreateError('');
    setShowCreate(true);
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    setCreateError('');
    const name = createForm.name.trim();
    if (!name) {
      setCreateError('分组名称必填');
      return;
    }
    setCreating(true);
    try {
      const res = await window.yibiao.kbAuth.createGroup({ name, description: createForm.description.trim() || undefined });
      if (!res?.success) throw new Error(res?.error || '创建失败');
      flash(`已创建分组「${name}」`);
      setShowCreate(false);
      await loadAll();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (group: KbPermissionGroup) => {
    setEditing(group);
    setEditPerms(new Set(group.permissions || []));
    setEditMembers(new Set((group.members || []).map((m) => String(m.id))));
    setEditError('');
    setMemberQuery('');
  };

  const togglePerm = (key: string) => {
    setEditPerms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleMember = (id: string | number) => {
    const sid = String(id);
    setEditMembers((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    setEditError('');
    try {
      const permRes = await window.yibiao.kbAuth.setGroupPermissions({
        group_id: editing.id,
        permissions: Array.from(editPerms),
      });
      if (!permRes?.success) throw new Error(permRes?.error || '保存权限失败');

      const currentMembers = new Set((editing.members || []).map((m) => String(m.id)));
      const desired = editMembers;
      const toAdd = Array.from(desired).filter((id) => !currentMembers.has(id));
      const toRemove = Array.from(currentMembers).filter((id) => !desired.has(id));

      for (const id of toAdd) {
        const r = await window.yibiao.kbAuth.addGroupMember({ group_id: editing.id, employee_id: id });
        if (!r?.success) throw new Error(r?.error || '添加成员失败');
      }
      for (const id of toRemove) {
        const r = await window.yibiao.kbAuth.removeGroupMember({ group_id: editing.id, employee_id: id });
        if (!r?.success) throw new Error(r?.error || '移除成员失败');
      }

      flash(`已保存分组「${editing.name}」`);
      setEditing(null);
      await loadAll();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const removeGroup = async (group: KbPermissionGroup) => {
    if (!window.confirm(`确定删除分组「${group.name}」？该分组下的权限分配与成员关系将一并清除。`)) return;
    try {
      const res = await window.yibiao.kbAuth.deleteGroup({ group_id: group.id });
      if (!res?.success) throw new Error(res?.error || '删除失败');
      flash(`已删除分组「${group.name}」`);
      await loadAll();
    } catch (error) {
      flash(error instanceof Error ? error.message : '删除失败', true);
    }
  };

  const permissionLabel = (key: string) => catalog.find((c) => c.key === key)?.label || key;

  const filteredEmployees = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(
      (e) => e.username.toLowerCase().includes(q) || (e.display_name || '').toLowerCase().includes(q),
    );
  }, [employees, memberQuery]);

  return (
    <div className="settings-page">
      <div className="settings-page-scroll">
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>权限列表</strong>
          </div>

          <div className="account-list-toolbar">
            <p className="account-list-desc">
              创建权限分组，勾选分组拥有的功能权限（如标书生成、知识库等），再把账号加入对应分组。账号的最终权限 = 其所加入全部分组的权限并集；管理员始终拥有全部权限。
            </p>
            <button type="button" className="inline-action account-add-button" onClick={openCreate}>
              + 新建分组
            </button>
          </div>

          <div className="permission-group-list">
            {loading ? (
              <div className="kb-admin-empty">加载中…</div>
            ) : groups.length === 0 ? (
              <div className="kb-admin-empty">还没有权限分组，点击右上角「新建分组」开始。</div>
            ) : (
              groups.map((group) => (
                <article key={group.id} className="permission-group-card">
                  <div className="permission-group-head">
                    <div>
                      <strong>{group.name}</strong>
                      {group.description ? <p>{group.description}</p> : null}
                    </div>
                    <div className="permission-group-actions">
                      <button type="button" className="kb-admin-reset" onClick={() => openEdit(group)}>编辑</button>
                      <button type="button" className="kb-admin-delete" onClick={() => void removeGroup(group)}>删除</button>
                    </div>
                  </div>
                  <div className="permission-group-meta">
                    <div className="permission-group-block">
                      <span className="permission-group-label">权限（{(group.permissions || []).length}）</span>
                      {(group.permissions || []).length ? (
                        <span className="account-group-tags">
                          {group.permissions.map((p) => (
                            <span key={p} className="account-group-tag">{permissionLabel(p)}</span>
                          ))}
                        </span>
                      ) : (
                        <span className="account-group-none">未分配权限</span>
                      )}
                    </div>
                    <div className="permission-group-block">
                      <span className="permission-group-label">成员（{(group.members || []).length}）</span>
                      {(group.members || []).length ? (
                        <span className="account-group-tags">
                          {group.members.map((m) => (
                            <span key={m.id} className="account-group-tag">{m.display_name || m.username}</span>
                          ))}
                        </span>
                      ) : (
                        <span className="account-group-none">暂无成员</span>
                      )}
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
          {notice ? <div className="kb-admin-notice">{notice}</div> : null}
        </section>
      </div>

      <Dialog.Root open={showCreate} onOpenChange={(open) => !open && setShowCreate(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <div className="content-regenerate-card-head">
              <Dialog.Title>新建权限分组</Dialog.Title>
              <Dialog.Description>分组创建后，可在编辑中勾选权限并添加成员。</Dialog.Description>
            </div>
            <form className="account-form" onSubmit={submitCreate}>
              <label>
                分组名称
                <input value={createForm.name} onChange={(ev) => setCreateForm({ ...createForm, name: ev.target.value })} placeholder="例如 标书组" required />
              </label>
              <label>
                描述（选填）
                <input value={createForm.description} onChange={(ev) => setCreateForm({ ...createForm, description: ev.target.value })} placeholder="例如 负责标书编制的成员" />
              </label>
              {createError ? <p className="account-form-error">{createError}</p> : null}
              <div className="content-regenerate-actions">
                <button type="button" className="secondary-action" onClick={() => setShowCreate(false)}>取消</button>
                <button type="submit" className="primary-action" disabled={creating}>{creating ? '创建中…' : '创建分组'}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card permission-edit-dialog">
            <div className="content-regenerate-card-head">
              <Dialog.Title>编辑分组：{editing?.name}</Dialog.Title>
              <Dialog.Description>勾选该分组拥有的功能权限，并把成员加入（或移出）此分组。</Dialog.Description>
            </div>
            {editing ? (
              <div className="permission-edit-body">
                <div className="permission-edit-col">
                  <span className="permission-group-label">功能权限</span>
                  <div className="permission-check-grid">
                    {catalog.map((perm) => (
                      <label key={perm.key} className={`permission-check ${editPerms.has(perm.key) ? 'is-checked' : ''}`}>
                        <input
                          type="checkbox"
                          checked={editPerms.has(perm.key)}
                          onChange={() => togglePerm(perm.key)}
                        />
                        <span className="permission-check-text">
                          <strong>{perm.label}</strong>
                          {perm.description ? <small>{perm.description}</small> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="permission-edit-col">
                  <span className="permission-group-label">成员（{editMembers.size}）</span>
                  <input
                    className="permission-member-search"
                    value={memberQuery}
                    onChange={(ev) => setMemberQuery(ev.target.value)}
                    placeholder="搜索姓名 / 用户名"
                  />
                  <div className="permission-member-list">
                    {filteredEmployees.map((e) => (
                      <label key={e.id} className={`permission-member-row ${editMembers.has(String(e.id)) ? 'is-checked' : ''}`}>
                        <input
                          type="checkbox"
                          checked={editMembers.has(String(e.id))}
                          onChange={() => toggleMember(e.id)}
                        />
                        <span>
                          <strong>{e.display_name || e.username}</strong>
                          <small>{e.username}{e.role === 'admin' ? ' · 管理员' : ''}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
            {editError ? <p className="account-form-error">{editError}</p> : null}
            <div className="content-regenerate-actions">
              <button type="button" className="secondary-action" onClick={() => setEditing(null)}>取消</button>
              <button type="button" className="primary-action" disabled={saving} onClick={() => void saveEdit()}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
