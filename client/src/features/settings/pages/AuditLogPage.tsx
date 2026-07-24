import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/auth/AuthContext';
import type { AuditLogEntry } from '../../../shared/types/ipc';

/** 通过 WebRTC 获取本机局域网 IP（不发起真实网络请求） */
async function resolveLocalIP(): Promise<string> {
  return new Promise((resolve) => {
    try {
      const pc = new (window.RTCPeerConnection || (window as unknown as { webkitRTCPeerConnection: typeof RTCPeerConnection }).webkitRTCPeerConnection)({ iceServers: [] });
      pc.createDataChannel('_');
      pc.createOffer().then((o) => pc.setLocalDescription(o));
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const m = ev.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (m && !m[1].startsWith('127.')) {
          resolve(m[1]);
          pc.close();
        }
      };
      setTimeout(() => resolve('本机'), 1200);
    } catch {
      resolve('本机');
    }
  });
}

const ACTION_LABELS: Record<string, string> = {
  login: '登录',
  logout: '退出登录',
  sync_push: '同步推送',
  folder: '文件夹',
  doc: '文档',
  admin: '管理操作',
  group: '分组',
};

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  employee: '成员',
  sync_client: '同步客户端',
};

const ACTION_FILTERS = ['login', 'logout', 'sync_push', 'folder', 'doc', 'admin', 'group'];

function formatAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function formatAccountType(type: string): string {
  return ACCOUNT_TYPE_LABELS[type] ?? type;
}

export default function AuditLogPage() {
  const { showToast } = useToast();
  const auth = useAuth();
  const isAdmin = auth.isAdmin;

  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [localIP, setLocalIP] = useState('本机');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.yibiao.kbAuth.listAudit();
      if (!res?.success) throw new Error(res?.error || '获取操作日志失败');
      setLogs((res.data || []) as AuditLogEntry[]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void resolveLocalIP().then(setLocalIP);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((log) => {
      if (actionFilter && log.action !== actionFilter) return false;
      if (!q) return true;
      return (
        (log.account_name || '').toLowerCase().includes(q) ||
        (log.detail || '').toLowerCase().includes(q) ||
        (log.action || '').toLowerCase().includes(q)
      );
    });
  }, [logs, query, actionFilter]);

  if (!isAdmin) {
    return (
      <div className="settings-page">
        <div className="settings-page-scroll">
          <section className="settings-page-section">
            <div className="settings-section-title">
              <span />
              <strong>操作日志</strong>
            </div>
            <div className="kb-admin-empty">仅管理员可查看操作日志。</div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <div className="settings-page-scroll">
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>操作日志</strong>
          </div>

          <div className="account-list-toolbar">
            <p className="account-list-desc">
              记录账号登录、文档操作、同步推送等审计事件，便于追溯责任与排查问题。
            </p>
            <button type="button" className="inline-action account-add-button" onClick={() => void loadAll()} disabled={loading}>
              {loading ? '刷新中…' : '刷新'}
            </button>
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <input
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
              placeholder="搜索账号 / 详情 / 操作"
              style={{ flex: '1 1 260px', minWidth: 200, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border, #d6dae2)' }}
            />
            <select
              value={actionFilter}
              onChange={(ev) => setActionFilter(ev.target.value)}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border, #d6dae2)' }}
            >
              <option value="">全部操作</option>
              {ACTION_FILTERS.map((a) => (
                <option key={a} value={a}>{formatAction(a)}</option>
              ))}
            </select>
          </div>

          {loading ? (
            <div className="kb-admin-empty">加载中…</div>
          ) : logs.length === 0 ? (
            <div className="kb-admin-empty">暂无操作日志。</div>
          ) : filtered.length === 0 ? (
            <div className="kb-admin-empty">没有符合筛选条件的记录。</div>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid var(--border, #e3e7ee)', borderRadius: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 720 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f4f6f9)', textAlign: 'left', color: 'var(--text-2, #5b6573)' }}>
                    <th style={thStyle}>时间</th>
                    <th style={thStyle}>账号</th>
                    <th style={thStyle}>类型</th>
                    <th style={thStyle}>操作</th>
                    <th style={thStyle}>对象</th>
                    <th style={thStyle}>详情</th>
                    <th style={thStyle}>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((log) => (
                    <tr key={log.id} style={{ borderTop: '1px solid var(--border, #eef1f5)' }}>
                      <td style={tdStyle}>{log.created_at}</td>
                      <td style={tdStyle}>{log.account_name || '—'}{log.role ? `（${log.role}）` : ''}</td>
                      <td style={tdStyle}>{formatAccountType(log.account_type)}</td>
                      <td style={tdStyle}>{formatAction(log.action)}</td>
                      <td style={tdStyle}>{[log.target_type, log.target_id].filter(Boolean).join(' · ') || '—'}</td>
                      <td style={tdStyle}>{log.detail || '—'}</td>
                      <td style={tdStyle}>{localIP}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && logs.length > 0 ? (
            <p style={{ marginTop: 12, color: 'var(--text-2, #5b6573)', fontSize: 12 }}>
              共 {logs.length} 条记录，当前显示 {filtered.length} 条。
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

const thStyle: CSSProperties = { padding: '10px 12px', fontWeight: 600, whiteSpace: 'nowrap' };
const tdStyle: CSSProperties = { padding: '10px 12px', verticalAlign: 'top' };
