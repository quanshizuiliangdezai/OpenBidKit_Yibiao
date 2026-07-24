/**
 * kbAuthService.cjs —— 方案 D 中央知识库服务器客户端登录
 *
 * 职责（仅阶段③，单薄、无业务耦合）：
 * 1. 管理服务器地址与登录令牌，持久化到 userData/kb_auth.json（仅本机，不随配置同步）。
 * 2. 提供 login / logout / getStatus / me，并暴露带鉴权的 apiFetch 供给阶段④的
 *    知识库 REST 调用复用（Beaer token 自动注入）。
 *
 * 注意：本服务不依赖本地 better-sqlite3，也不触碰本地知识库分析数据。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SERVER_URL = 'http://59.49.48.147:15004';
const AUTH_FILE_NAME = 'kb_auth.json';

function createKbAuthService({ app }) {
  const authPath = path.join(app.getPath('userData'), AUTH_FILE_NAME);
  let cache = null;
  // 401 未授权回调：由主进程注册，用于通知渲染进程会话已失效（重新弹出门禁）
  let unauthorizedHandler = null;
  function onUnauthorized(fn) {
    unauthorizedHandler = typeof fn === 'function' ? fn : null;
  }

  function read() {
    if (cache) return cache;
    try {
      if (fs.existsSync(authPath)) {
        const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
        cache = {
          serverUrl: raw.serverUrl || DEFAULT_SERVER_URL,
          token: raw.token || null,
          employee: raw.employee || null,
        };
        return cache;
      }
    } catch {
      // 损坏的文件直接当作未登录处理
    }
    cache = { serverUrl: DEFAULT_SERVER_URL, token: null, employee: null };
    return cache;
  }

  function write(next) {
    cache = { serverUrl: next.serverUrl || DEFAULT_SERVER_URL, token: next.token || null, employee: next.employee || null };
    try {
      fs.mkdirSync(path.dirname(authPath), { recursive: true });
      fs.writeFileSync(authPath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (error) {
      throw new Error(`保存团队库登录信息失败：${error?.message || String(error)}`);
    }
    return cache;
  }

  function getServerUrl() {
    return read().serverUrl;
  }

  function getToken() {
    return read().token;
  }

  function getEmployee() {
    return read().employee;
  }

  function isLoggedIn() {
    const state = read();
    return Boolean(state.token && state.employee);
  }

  // 带鉴权的 REST 请求封装，供阶段④知识库调用复用。
  // 返回 { ok, status, data }；非 2xx 时 ok=false 且 data 可能为服务器错误对象。
  async function apiFetch(apiPath, { method = 'GET', body = null, headers = {} } = {}) {
    const state = read();
    const base = (state.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
    const url = `${base}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
    const reqHeaders = { ...headers };
    if (state.token) reqHeaders.Authorization = `Bearer ${state.token}`;
    const init = { method, headers: reqHeaders };
    if (body !== null) {
      if (body instanceof FormData || (typeof FormData !== 'undefined' && body?.constructor?.name === 'FormData')) {
        init.body = body; // 让 fetch 自动带 boundary
      } else {
        reqHeaders['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, init);
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    // 令牌失效：通知上层，便于渲染进程重新弹出门禁
    if (res.status === 401 && unauthorizedHandler) {
      try { unauthorizedHandler(); } catch { /* 忽略回调异常 */ }
    }
    return { ok: res.ok, status: res.status, data };
  }

  async function login({ username, password, serverUrl }) {
    const base = (serverUrl || getServerUrl() || DEFAULT_SERVER_URL).replace(/\/+$/, '');
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { error: text }; }
    }
    if (!res.ok || !payload?.success) {
      const message = payload?.error || (res.status === 401 ? '用户名或密码错误' : `登录失败（${res.status}）`);
      throw new Error(message);
    }
    const data = payload.data || {};
    // 服务端把用户信息平铺在 data 中（token/role/display_name/username），
    // 也可能嵌套在 data.employee。统一归一化为 employee 对象，确保 isLoggedIn() 为真，
    // 以便后续 getMe() 能拉取 /api/me 的完整信息（含 id / groups / permissions）。
    const src = (data.employee && typeof data.employee === 'object') ? data.employee : data;
    const employee = {
      id: src.id ?? null,
      username: src.username ?? null,
      display_name: src.display_name ?? null,
      role: src.role ?? 'employee',
      status: src.status ?? null,
      department: src.department ?? null,
    };
    write({ serverUrl: base, token: data.token || null, employee });
    return { success: true, employee };
  }

  function logout() {
    write({ serverUrl: getServerUrl(), token: null, employee: null });
  }

  // 自助注册：创建 pending 账号，不写入登录令牌（注册后需管理员审核）。
  async function register({ username, password, display_name, department, serverUrl }) {
    const base = (serverUrl || getServerUrl() || DEFAULT_SERVER_URL).replace(/\/+$/, '');
    const res = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, display_name, department }),
    });
    const text = await res.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { error: text }; }
    }
    if (!res.ok || !payload?.success) {
      const message = payload?.error || (res.status === 400 ? '注册失败，请检查填写内容' : `注册失败（${res.status}）`);
      throw new Error(message);
    }
    return { success: true };
  }

  // ===== 管理员操作（需已登录且为 admin，apiFetch 自动注入 Bearer token）=====

  async function listEmployees() {
    const { ok, status, data } = await apiFetch('/api/admin/employees');
    if (!ok) throw new Error(data?.error || `获取员工列表失败（${status}）`);
    return data?.data || [];
  }

  async function listPending() {
    const { ok, status, data } = await apiFetch('/api/admin/pending');
    if (!ok) throw new Error(data?.error || `获取待审核列表失败（${status}）`);
    return data?.data || [];
  }

  async function review(user_id, action, reject_reason) {
    const { ok, status, data } = await apiFetch('/api/admin/review', {
      method: 'POST',
      body: { user_id, action, reject_reason },
    });
    if (!ok) throw new Error(data?.error || `审核失败（${status}）`);
    return data || {};
  }

  async function resetPassword(user_id, new_password) {
    const { ok, status, data } = await apiFetch('/api/admin/reset-password', {
      method: 'POST',
      body: { user_id, new_password },
    });
    if (!ok) throw new Error(data?.error || `重置密码失败（${status}）`);
    return data || {};
  }

  async function setEmployeeStatus(user_id, status) {
    const { ok, status: st, data } = await apiFetch('/api/admin/set-status', {
      method: 'POST',
      body: { user_id, status },
    });
    if (!ok) throw new Error(data?.error || `更新状态失败（${st}）`);
    return data || {};
  }

  async function deleteEmployee(user_id) {
    const { ok, status, data } = await apiFetch(`/api/admin/employees/${user_id}`, {
      method: 'DELETE',
    });
    if (!ok) throw new Error(data?.error || `删除账号失败（${status}）`);
    return data || {};
  }

  // 管理员修改员工资料（display_name / department / role / status / group_ids）
  async function adminUpdateEmployee(user_id, fields) {
    const { ok, status, data } = await apiFetch(`/api/admin/employees/${user_id}`, {
      method: 'PUT',
      body: fields,
    });
    if (!ok) throw new Error(data?.error || `更新账号失败（${status}）`);
    return data || {};
  }

  // ===== 权限分组（RBAC）=====

  async function listPermissions() {
    const { ok, status, data } = await apiFetch('/api/permissions');
    if (!ok) throw new Error(data?.error || `获取权限目录失败（${status}）`);
    return data?.data || [];
  }

  async function listGroups() {
    const { ok, status, data } = await apiFetch('/api/admin/groups');
    if (!ok) throw new Error(data?.error || `获取权限分组失败（${status}）`);
    return data?.data || [];
  }

  async function createGroup({ name, description }) {
    const { ok, status, data } = await apiFetch('/api/admin/groups', {
      method: 'POST',
      body: { name, description },
    });
    if (!ok) throw new Error(data?.error || `创建分组失败（${status}）`);
    return data?.data || {};
  }

  async function deleteGroup(group_id) {
    const { ok, status, data } = await apiFetch(`/api/admin/groups/${group_id}`, {
      method: 'DELETE',
    });
    if (!ok) throw new Error(data?.error || `删除分组失败（${status}）`);
    return data || {};
  }

  async function setGroupPermissions(group_id, permissions) {
    const { ok, status, data } = await apiFetch(`/api/admin/groups/${group_id}/permissions`, {
      method: 'PUT',
      body: { permissions },
    });
    if (!ok) throw new Error(data?.error || `保存分组权限失败（${status}）`);
    return data || {};
  }

  async function addGroupMember(group_id, employee_id) {
    const { ok, status, data } = await apiFetch(`/api/admin/groups/${group_id}/members`, {
      method: 'POST',
      body: { employee_id },
    });
    if (!ok) throw new Error(data?.error || `加入分组失败（${status}）`);
    return data || {};
  }

  async function removeGroupMember(group_id, employee_id) {
    const { ok, status, data } = await apiFetch(`/api/admin/groups/${group_id}/members/${employee_id}`, {
      method: 'DELETE',
    });
    if (!ok) throw new Error(data?.error || `移出分组失败（${status}）`);
    return data || {};
  }

  async function adminCreateEmployee({ username, password, display_name, department, role, status }) {
    const { ok, status: st, data } = await apiFetch('/api/admin/employees', {
      method: 'POST',
      body: { username, password, display_name, department, role, status },
    });
    if (!ok) throw new Error(data?.error || `创建账号失败（${st}）`);
    return data || {};
  }

  async function getMe() {
    if (!isLoggedIn()) return null;
    const { ok, status, data } = await apiFetch('/api/me');
    if (!ok || status === 401) {
      // 令牌失效，自动登出
      logout();
      return null;
    }
    const employee = data?.data || data || null;
    if (employee && !cache?.employee?.id) {
      // 仅当缓存缺失时回写
      write({ serverUrl: getServerUrl(), token: getToken(), employee });
    } else if (employee) {
      cache.employee = employee;
    }
    return employee;
  }

  // 拉取操作审计日志（需已登录且为 admin，apiFetch 自动注入 Bearer token）
  async function listAudit({ limit = 200 } = {}) {
    const { ok, status, data } = await apiFetch(`/api/admin/audit?limit=${encodeURIComponent(limit)}`);
    if (!ok) throw new Error(data?.error || `获取操作日志失败（${status}）`);
    return data?.data || [];
  }

  function setServerUrl(serverUrl) {
    if (!serverUrl || !String(serverUrl).trim()) {
      throw new Error('服务器地址不能为空');
    }
    write({ serverUrl: String(serverUrl).trim().replace(/\/+$/, ''), token: getToken(), employee: getEmployee() });
  }

  function getStatus() {
    const state = read();
    return {
      loggedIn: Boolean(state.token && state.employee),
      serverUrl: state.serverUrl,
      employee: state.employee,
    };
  }

  return {
    getServerUrl,
    getToken,
    getEmployee,
    isLoggedIn,
    apiFetch,
    onUnauthorized,
    login,
    logout,
    register,
    getMe,
    setServerUrl,
    getStatus,
    listEmployees,
    listPending,
    review,
    resetPassword,
    setEmployeeStatus,
    deleteEmployee,
    adminUpdateEmployee,
    listPermissions,
    listGroups,
    createGroup,
    deleteGroup,
    setGroupPermissions,
    addGroupMember,
    removeGroupMember,
    adminCreateEmployee,
    listAudit,
  };
}

module.exports = { createKbAuthService, DEFAULT_SERVER_URL };
