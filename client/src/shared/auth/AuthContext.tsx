import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface AuthEmployee {
  id: string | number;
  username: string;
  display_name?: string;
  role: 'admin' | 'employee';
  status?: string;
  department?: string | null;
  groups?: Array<{ id: string | number; name: string }>;
  permissions?: string[];
  [key: string]: unknown;
}

export interface AuthContextValue {
  loading: boolean;
  loggedIn: boolean;
  employee: AuthEmployee | null;
  permissions: string[];
  groups: Array<{ id: string | number; name: string }>;
  isAdmin: boolean;
  hasPermission: (key: string) => boolean;
  login: (username: string, password: string, serverUrl?: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  sessionExpired: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readEmployee(raw: unknown): AuthEmployee | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  // 优先用 id；缺失时退化为 username 作为身份标识，保证登录态可用
  const id = (e.id !== undefined && e.id !== null && e.id !== '') ? e.id : (e.username ?? null);
  if (id === null || id === undefined || id === '') return null;
  return {
    id: e.id as string | number,
    username: String(e.username || ''),
    display_name: e.display_name ? String(e.display_name) : undefined,
    role: e.role === 'admin' ? 'admin' : 'employee',
    status: e.status ? String(e.status) : undefined,
    department: e.department === undefined ? null : (e.department as string | null),
    groups: Array.isArray(e.groups) ? (e.groups as Array<{ id: string | number; name: string }>) : [],
    permissions: Array.isArray(e.permissions) ? (e.permissions as string[]) : [],
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [employee, setEmployee] = useState<AuthEmployee | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  async function loadMe(): Promise<boolean> {
    try {
      const me = await window.yibiao.kbAuth.me();
      const parsed = readEmployee(me);
      if (parsed) {
        setEmployee(parsed);
        return true;
      }
    } catch {
      // 忽略，保持未登录
    }
    return false;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await window.yibiao.kbAuth.getStatus();
        if (status.loggedIn && !cancelled) {
          await loadMe();
        }
      } catch {
        // 忽略
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 令牌失效（401）时，由主进程通知，清空登录态以重新弹出门禁
  useEffect(() => {
    const off = window.yibiao?.kbAuth.onSessionExpired?.(() => {
      setEmployee(null);
      setSessionExpired(true);
    });
    return () => {
      off?.();
    };
  }, []);

  const isAdmin = employee?.role === 'admin';
  const permissions = useMemo(() => {
    if (!employee) return [];
    if (isAdmin) {
      // 管理员拥有全部权限；若服务器已返回全量则直接用，否则标记为空（界面仍按 isAdmin 放行）
      return Array.isArray(employee.permissions) ? employee.permissions : [];
    }
    return Array.isArray(employee.permissions) ? employee.permissions : [];
  }, [employee, isAdmin]);
  const groups = useMemo(() => Array.isArray(employee?.groups) ? employee!.groups! : [], [employee]);
  const loggedIn = Boolean(employee);

  const hasPermission = (key: string) => isAdmin || permissions.includes(key);

  async function login(username: string, password: string, serverUrl?: string) {
    const result = await window.yibiao.kbAuth.login({ username, password, serverUrl });
    if (!result || !result.success) {
      throw new Error(result?.error || '登录失败');
    }
    const ok = await loadMe();
    if (ok) setSessionExpired(false);
    if (!ok) {
      // /api/me 异常时回退：使用 login 已写入的 employee（可能无 id，但可凭 username 进入客户端）
      const st = await window.yibiao.kbAuth.getStatus();
      if (st?.employee) {
        const parsed = readEmployee(st.employee);
        if (parsed) {
          setEmployee(parsed);
          return;
        }
      }
      throw new Error('登录成功但获取用户信息失败，请重试');
    }
  }

  function logout() {
    window.yibiao.kbAuth.logout();
    setEmployee(null);
    setSessionExpired(false);
  }

  async function refresh() {
    await loadMe();
  }

  const value: AuthContextValue = {
    loading,
    loggedIn,
    employee,
    permissions,
    groups,
    isAdmin,
    hasPermission,
    login,
    logout,
    refresh,
    sessionExpired,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth 必须在 AuthProvider 内使用');
  }
  return ctx;
}
