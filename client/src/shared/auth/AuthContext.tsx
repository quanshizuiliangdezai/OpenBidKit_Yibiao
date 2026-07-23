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
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readEmployee(raw: unknown): AuthEmployee | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (!e.id && e.id !== 0) return null;
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
    await window.yibiao.kbAuth.login({ username, password, serverUrl });
    await loadMe();
  }

  function logout() {
    window.yibiao.kbAuth.logout();
    setEmployee(null);
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
