#!/usr/bin/env python3
# 方案 D（中央服务器知识库）数据层
# 负责：员工账号(employees)、登录会话(sessions)、文件夹树、文档元数据
# 认证方式：仅账号密码 + 员工自助注册 + 管理员审核
# 密码：pbkdf2_hmac(sha256) + 随机 salt，绝不存明文
import sqlite3
import os
import hashlib
import secrets
import datetime
import threading

DB_PATH = os.environ.get('KB_DB', '/toubiao/yibiao-kb-server/kb.sqlite')
# 文档物理存储目录（只在服务器，客户端不留存）
KB_DATA_DIR = os.environ.get('KB_DATA_DIR', '/toubiao/yibiao-kb-server/knowledge-base')
_lock = threading.Lock()

# ---------- 权限目录（前端勾选框的数据源，亦作为 admin 全权限的集合）----------
PERMISSION_CATALOG = [
    ('bid_generation', '标书生成', '技术方案、已有方案扩写、商务标等标书编制功能'),
    ('template_settings', '模版设置', '标书导出模板与排版配置'),
    ('knowledge_base', '知识库', '文档/图片知识库的上传、查阅与管理'),
    ('bid_check', '标书检查', '查重、废标项检查、AI评标'),
    ('bid_opportunity', '投标机会', '投标机会发现与线索跟踪'),
    ('resources', '资源下载', '投标相关资料与工具下载'),
    ('account_manage', '账户管理', '查看与管理团队成员账户'),
    ('permission_manage', '权限管理', '管理权限分组与权限分配'),
]
ALL_PERMISSION_KEYS = [k for k, _, _ in PERMISSION_CATALOG]


def _conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # 多线程并发写时，遇锁自动等待而非立即抛 database is locked
    conn.execute("PRAGMA busy_timeout=5000")
    # 启用外键级联：删除文件夹时自动级联删子文件夹与文档行
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    os.makedirs(KB_DATA_DIR, exist_ok=True)
    conn = _conn()
    with conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS employees (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            display_name  TEXT NOT NULL,
            department    TEXT,
            role          TEXT NOT NULL DEFAULT 'employee',
            status        TEXT NOT NULL DEFAULT 'pending',
            wechat_openid TEXT,
            created_at    TEXT NOT NULL,
            reviewed_at   TEXT,
            reviewed_by   INTEGER,
            reject_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            employee_id INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS knowledge_folders (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            parent_id  INTEGER,
            owner_id   INTEGER,
            created_at TEXT NOT NULL,
            FOREIGN KEY(parent_id) REFERENCES knowledge_folders(id) ON DELETE CASCADE,
            FOREIGN KEY(owner_id) REFERENCES employees(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS knowledge_documents (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id  INTEGER NOT NULL,
            owner_id   INTEGER,
            title      TEXT NOT NULL,
            file_name  TEXT,
            file_path  TEXT,
            file_size  INTEGER,
            mime_type  TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(folder_id) REFERENCES knowledge_folders(id) ON DELETE CASCADE,
            FOREIGN KEY(owner_id) REFERENCES employees(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS permission_groups (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            description TEXT
        );
        CREATE TABLE IF NOT EXISTS group_permissions (
            group_id       INTEGER NOT NULL,
            permission_key TEXT NOT NULL,
            PRIMARY KEY(group_id, permission_key),
            FOREIGN KEY(group_id) REFERENCES permission_groups(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS employee_groups (
            employee_id INTEGER NOT NULL,
            group_id    INTEGER NOT NULL,
            PRIMARY KEY(employee_id, group_id),
            FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
            FOREIGN KEY(group_id) REFERENCES permission_groups(id) ON DELETE CASCADE
        );
        ''')
    conn.close()
    # 一次性迁移：旧库 owner_id 为 NOT NULL 且无 ON DELETE 规则，删员工会被外键挡住。
    # 迁移为可空 + ON DELETE SET NULL，配套 update_employee / delete_employee 实现「只删账号、保 KB」。
    _migrate_owner_id_to_nullable()
    _ensure_admin()


def _hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), 100000)
    return h.hex(), salt


def verify_password(password, salt, expected_hash):
    h, _ = _hash_password(password, salt)
    return h == expected_hash


def _ensure_admin():
    conn = _conn()
    try:
        row = conn.execute("SELECT id FROM employees WHERE role='admin' LIMIT 1").fetchone()
        if row is None:
            pw = os.environ.get('KB_ADMIN_PASSWORD', 'YibiaoAdmin2026')
            h, salt = _hash_password(pw)
            now = datetime.datetime.now().isoformat()
            conn.execute(
                "INSERT INTO employees (username,password_hash,password_salt,display_name,role,status,created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                ('admin', h, salt, '系统管理员', 'admin', 'approved', now))
            conn.commit()
            print('[kb-auth] 初始管理员已创建  用户名=admin  密码=%s  (请尽快登录修改)' % pw, flush=True)
    finally:
        conn.close()


def _migrate_owner_id_to_nullable():
    """把 knowledge_folders / knowledge_documents 的 owner_id 改为 NULLable + ON DELETE SET NULL。

    老 schema: owner_id INTEGER NOT NULL + 无 ON DELETE 规则（默认 RESTRICT）→ 删除员工会被外键挡住。
    新 schema: owner_id INTEGER + ON DELETE SET NULL → 删除员工时其文件夹/文档的 owner_id 自动置 NULL。
    通过 PRAGMA table_info 检测是否需要迁移；只迁移一次，已迁移的库跳过。
    """
    conn = _conn()
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        try:
            info = conn.execute("PRAGMA table_info(knowledge_folders)").fetchall()
            owner = next((r for r in info if r[1] == 'owner_id'), None)
            if owner and int(owner[3]) == 1:
                conn.executescript('''
                    CREATE TABLE knowledge_folders_new (
                        id         INTEGER PRIMARY KEY AUTOINCREMENT,
                        name       TEXT NOT NULL,
                        parent_id  INTEGER,
                        owner_id   INTEGER,
                        created_at TEXT NOT NULL,
                        FOREIGN KEY(parent_id) REFERENCES knowledge_folders(id) ON DELETE CASCADE,
                        FOREIGN KEY(owner_id) REFERENCES employees(id) ON DELETE SET NULL
                    );
                    INSERT INTO knowledge_folders_new (id, name, parent_id, owner_id, created_at)
                        SELECT id, name, parent_id, owner_id, created_at FROM knowledge_folders;
                    DROP TABLE knowledge_folders;
                    ALTER TABLE knowledge_folders_new RENAME TO knowledge_folders;
                ''')
            info = conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()
            owner = next((r for r in info if r[1] == 'owner_id'), None)
            if owner and int(owner[3]) == 1:
                conn.executescript('''
                    CREATE TABLE knowledge_documents_new (
                        id         INTEGER PRIMARY KEY AUTOINCREMENT,
                        folder_id  INTEGER NOT NULL,
                        owner_id   INTEGER,
                        title      TEXT NOT NULL,
                        file_name  TEXT,
                        file_path  TEXT,
                        file_size  INTEGER,
                        mime_type  TEXT,
                        created_at TEXT NOT NULL,
                        FOREIGN KEY(folder_id) REFERENCES knowledge_folders(id) ON DELETE CASCADE,
                        FOREIGN KEY(owner_id) REFERENCES employees(id) ON DELETE SET NULL
                    );
                    INSERT INTO knowledge_documents_new (id, folder_id, owner_id, title, file_name, file_path, file_size, mime_type, created_at)
                        SELECT id, folder_id, owner_id, title, file_name, file_path, file_size, mime_type, created_at
                        FROM knowledge_documents;
                    DROP TABLE knowledge_documents;
                    ALTER TABLE knowledge_documents_new RENAME TO knowledge_documents;
                ''')
            conn.commit()
        finally:
            conn.execute("PRAGMA foreign_keys=ON")
    finally:
        conn.close()


# ---------- 注册 / 登录 ----------

def register(username, password, display_name, department=None):
    username = (username or '').strip()
    display_name = (display_name or '').strip()
    if not username or not password or not display_name:
        return False, '用户名、密码、姓名均必填'
    if len(password) < 6:
        return False, '密码至少 6 位'
    with _lock:
        conn = _conn()
        try:
            if conn.execute("SELECT id FROM employees WHERE username=?", (username,)).fetchone():
                return False, '用户名已存在'
            h, salt = _hash_password(password)
            now = datetime.datetime.now().isoformat()
            conn.execute(
                "INSERT INTO employees (username,password_hash,password_salt,display_name,department,status,created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (username, h, salt, display_name, department, 'pending', now))
            conn.commit()
            return True, None
        finally:
            conn.close()


def authenticate(username, password):
    with _lock:
        conn = _conn()
        try:
            row = conn.execute("SELECT * FROM employees WHERE username=?", (username,)).fetchone()
            if not row:
                return None, '用户不存在'
            if row['status'] != 'approved':
                return None, '账号待审核或未通过'
            if not verify_password(password, row['password_salt'], row['password_hash']):
                return None, '密码错误'
            # 登录前清理该用户旧会话，避免 sessions 表无限增长
            conn.execute("DELETE FROM sessions WHERE employee_id=?", (row['id'],))
            token = secrets.token_urlsafe(32)
            now = datetime.datetime.now()
            expires = (now + datetime.timedelta(days=30)).isoformat()
            conn.execute(
                "INSERT INTO sessions (token,employee_id,expires_at,created_at) VALUES (?,?,?,?)",
                (token, row['id'], expires, now.isoformat()))
            conn.commit()
            return {'token': token, 'role': row['role'],
                    'display_name': row['display_name'], 'username': row['username']}, None
        finally:
            conn.close()


def get_session(token):
    if not token:
        return None
    with _lock:
        conn = _conn()
        try:
            s = conn.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
            if not s:
                return None
            if datetime.datetime.fromisoformat(s['expires_at']) < datetime.datetime.now():
                conn.execute("DELETE FROM sessions WHERE token=?", (token,))
                conn.commit()
                return None
            e = conn.execute("SELECT * FROM employees WHERE id=?", (s['employee_id'],)).fetchone()
            if not e or e['status'] != 'approved':
                return None
            return e
        finally:
            conn.close()


# ---------- 管理员操作 ----------

def list_pending():
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT id,username,display_name,department,created_at FROM employees "
                "WHERE status='pending' ORDER BY created_at").fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def review(user_id, action, admin_id, reject_reason=None):
    if action not in ('approve', 'reject'):
        return False, '无效操作'
    try:
        user_id = int(user_id)
    except (TypeError, ValueError):
        return False, '无效的用户 ID'
    name = None
    with _lock:
        conn = _conn()
        try:
            row = conn.execute("SELECT id,display_name,username FROM employees WHERE id=?", (user_id,)).fetchone()
            if not row:
                return False, '用户不存在'
            name = row['display_name'] or row['username']
            now = datetime.datetime.now().isoformat()
            if action == 'approve':
                conn.execute(
                    "UPDATE employees SET status='approved', reviewed_at=?, reviewed_by=? WHERE id=?",
                    (now, admin_id, user_id))
            else:
                conn.execute(
                    "UPDATE employees SET status='rejected', reviewed_at=?, reviewed_by=?, reject_reason=? WHERE id=?",
                    (now, admin_id, reject_reason, user_id))
            conn.commit()
        finally:
            conn.close()
    # 审核通过时，为该员工建立专属根文件夹（在锁外调用，避免重入死锁）
    if action == 'approve' and name:
        create_root_folder(user_id, name)
    return True, None


def list_employees():
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT id,username,display_name,department,role,status,created_at FROM employees "
                "ORDER BY id").fetchall()
            eg = conn.execute(
                "SELECT eg.employee_id AS employee_id, pg.id AS group_id, pg.name AS group_name "
                "FROM employee_groups eg JOIN permission_groups pg ON pg.id=eg.group_id").fetchall()
            group_map = {}
            for r in eg:
                group_map.setdefault(r['employee_id'], []).append(
                    {'id': r['group_id'], 'name': r['group_name']})
            result = []
            for r in rows:
                d = dict(r)
                d['groups'] = group_map.get(r['id'], [])
                result.append(d)
            return result
        finally:
            conn.close()


def public_fields(e):
    base = {k: e[k] for k in ('id', 'username', 'display_name', 'department', 'role', 'status',
                              'created_at')}
    base['groups'] = get_employee_groups(e['id'])
    base['permissions'] = get_employee_permissions(e)
    return base


# ---------- 账号管理（管理员操作）----------

# 允许设置的账号状态白名单
ALLOWED_STATUS = ('pending', 'approved', 'rejected', 'disabled')


def reset_password(user_id, new_password):
    """管理员重置某用户密码。成功后清掉该用户旧会话，强制重新登录。"""
    new_password = (new_password or '').strip()
    if len(new_password) < 6:
        return False, '密码至少 6 位'
    try:
        user_id = int(user_id)
    except (TypeError, ValueError):
        return False, '无效的用户 ID'
    with _lock:
        conn = _conn()
        try:
            if not conn.execute("SELECT id FROM employees WHERE id=?", (user_id,)).fetchone():
                return False, '用户不存在'
            h, salt = _hash_password(new_password)
            conn.execute(
                "UPDATE employees SET password_hash=?, password_salt=? WHERE id=?",
                (h, salt, user_id))
            conn.execute("DELETE FROM sessions WHERE employee_id=?", (user_id,))
            conn.commit()
            return True, None
        finally:
            conn.close()


def set_employee_status(user_id, status):
    """管理员启用/禁用账号。禁用后清会话，该用户将无法登录。"""
    if status not in ALLOWED_STATUS:
        return False, '非法的账号状态'
    try:
        user_id = int(user_id)
    except (TypeError, ValueError):
        return False, '无效的用户 ID'
    with _lock:
        conn = _conn()
        try:
            row = conn.execute("SELECT id,role,status FROM employees WHERE id=?", (user_id,)).fetchone()
            if not row:
                return False, '用户不存在'
            if row['role'] == 'admin' and status != 'approved':
                return False, '管理员账号不能被禁用或停用'
            if row['status'] == status:
                return False, '账号状态未变化'
            conn.execute("UPDATE employees SET status=? WHERE id=?", (status, user_id))
            if status != 'approved':
                conn.execute("DELETE FROM sessions WHERE employee_id=?", (user_id,))
            conn.commit()
            return True, None
        finally:
            conn.close()


# ---------- 权限分组（RBAC）----------

def create_permission_group(name, description=None):
    name = (name or '').strip()
    if not name:
        return None, '分组名称必填'
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "INSERT INTO permission_groups (name, description) VALUES (?,?)",
                (name, description))
            conn.commit()
            gid = cur.lastrowid
            row = conn.execute("SELECT * FROM permission_groups WHERE id=?", (gid,)).fetchone()
            return dict(row), None
        finally:
            conn.close()


def delete_permission_group(group_id):
    try:
        group_id = int(group_id)
    except (TypeError, ValueError):
        return False, '无效的分组 ID'
    with _lock:
        conn = _conn()
        try:
            if not conn.execute("SELECT id FROM permission_groups WHERE id=?", (group_id,)).fetchone():
                return False, '分组不存在'
            conn.execute("DELETE FROM permission_groups WHERE id=?", (group_id,))
            conn.commit()
            return True, None
        finally:
            conn.close()


def list_permission_groups():
    with _lock:
        conn = _conn()
        try:
            groups = conn.execute(
                "SELECT id,name,description FROM permission_groups ORDER BY id").fetchall()
            perms = conn.execute(
                "SELECT group_id, permission_key FROM group_permissions").fetchall()
            members = conn.execute(
                "SELECT eg.employee_id AS employee_id, eg.group_id AS group_id, "
                "e.display_name AS display_name, e.username AS username "
                "FROM employee_groups eg JOIN employees e ON e.id=eg.employee_id").fetchall()
            perm_map = {}
            for r in perms:
                perm_map.setdefault(r['group_id'], []).append(r['permission_key'])
            mem_map = {}
            for r in members:
                mem_map.setdefault(r['group_id'], []).append({
                    'id': r['employee_id'],
                    'display_name': r['display_name'],
                    'username': r['username'],
                })
            result = []
            for g in groups:
                d = dict(g)
                d['permissions'] = perm_map.get(g['id'], [])
                d['members'] = mem_map.get(g['id'], [])
                result.append(d)
            return result
        finally:
            conn.close()


def get_group_permissions(group_id):
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT permission_key FROM group_permissions WHERE group_id=?",
                (int(group_id),)).fetchall()
            return [r['permission_key'] for r in rows]
        finally:
            conn.close()


def set_group_permissions(group_id, perm_keys):
    try:
        group_id = int(group_id)
    except (TypeError, ValueError):
        return False, '无效的分组 ID'
    keys = []
    for k in (perm_keys or []):
        k = (k or '').strip()
        if k:
            keys.append(k)
    with _lock:
        conn = _conn()
        try:
            if not conn.execute("SELECT id FROM permission_groups WHERE id=?", (group_id,)).fetchone():
                return False, '分组不存在'
            conn.execute("DELETE FROM group_permissions WHERE group_id=?", (group_id,))
            for k in keys:
                conn.execute(
                    "INSERT OR IGNORE INTO group_permissions (group_id, permission_key) VALUES (?,?)",
                    (group_id, k))
            conn.commit()
            return True, None
        finally:
            conn.close()


def get_employee_groups(employee_id):
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT pg.id AS id, pg.name AS name FROM employee_groups eg "
                "JOIN permission_groups pg ON pg.id=eg.group_id WHERE eg.employee_id=?",
                (int(employee_id),)).fetchall()
            return [{'id': r['id'], 'name': r['name']} for r in rows]
        finally:
            conn.close()


def add_employee_group(employee_id, group_id):
    try:
        employee_id = int(employee_id); group_id = int(group_id)
    except (TypeError, ValueError):
        return False, '无效的 ID'
    with _lock:
        conn = _conn()
        try:
            if not conn.execute("SELECT id FROM employees WHERE id=?", (employee_id,)).fetchone():
                return False, '员工不存在'
            if not conn.execute("SELECT id FROM permission_groups WHERE id=?", (group_id,)).fetchone():
                return False, '分组不存在'
            conn.execute(
                "INSERT OR IGNORE INTO employee_groups (employee_id, group_id) VALUES (?,?)",
                (employee_id, group_id))
            conn.commit()
            return True, None
        finally:
            conn.close()


def remove_employee_group(employee_id, group_id):
    try:
        employee_id = int(employee_id); group_id = int(group_id)
    except (TypeError, ValueError):
        return False, '无效的 ID'
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "DELETE FROM employee_groups WHERE employee_id=? AND group_id=?",
                (employee_id, group_id))
            conn.commit()
            return True, None
        finally:
            conn.close()


def get_employee_permissions(employee):
    if employee['role'] == 'admin':
        return list(ALL_PERMISSION_KEYS)
    gids = [g['id'] for g in get_employee_groups(employee['id'])]
    if not gids:
        return []
    with _lock:
        conn = _conn()
        try:
            ph = ','.join('?' * len(gids))
            rows = conn.execute(
                "SELECT DISTINCT permission_key FROM group_permissions WHERE group_id IN (%s)" % ph,
                gids).fetchall()
            return [r['permission_key'] for r in rows]
        finally:
            conn.close()


def admin_create_employee(username, password, display_name, department=None,
                           role='employee', status='approved'):
    username = (username or '').strip()
    display_name = (display_name or '').strip()
    if not username or not password or not display_name:
        return False, '用户名、密码、姓名均必填'
    if len(password) < 6:
        return False, '密码至少 6 位'
    if role not in ('admin', 'employee'):
        role = 'employee'
    if status not in ('approved', 'pending', 'disabled'):
        status = 'approved'
    with _lock:
        conn = _conn()
        try:
            if conn.execute("SELECT id FROM employees WHERE username=?", (username,)).fetchone():
                return False, '用户名已存在'
            h, salt = _hash_password(password)
            now = datetime.datetime.now().isoformat()
            conn.execute(
                "INSERT INTO employees (username,password_hash,password_salt,display_name,department,role,status,created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (username, h, salt, display_name, department, role, status, now))
            conn.commit()
            return True, None
        finally:
            conn.close()


# 可通过 update_employee 修改的字段白名单（防止误改 username / password_hash 等）
_EDITABLE_EMPLOYEE_FIELDS = ('display_name', 'department', 'role', 'status')


def update_employee(user_id, fields):
    """管理员修改员工资料。

    可修改字段：display_name、department、role、status。
    不可修改：username（唯一键）、password_hash（走 reset-password 流程）、created_at。
    特殊字段：group_ids=list[int]——若传入则整组替换 employee_groups 关联（不加则保持原样）。
    返回 (ok, err)。"""
    try:
        user_id = int(user_id)
    except (TypeError, ValueError):
        return False, '无效的 ID'
    if not isinstance(fields, dict):
        return False, '参数格式错误'
    sets = []
    params = []
    if 'display_name' in fields:
        dn = (fields.get('display_name') or '').strip()
        if not dn:
            return False, '姓名不能为空'
        sets.append('display_name=?')
        params.append(dn)
    if 'department' in fields:
        dep = fields.get('department')
        if dep is None:
            dep = None
        elif isinstance(dep, str):
            dep = dep.strip() or None
        else:
            dep = str(dep).strip() or None
        sets.append('department=?')
        params.append(dep)
    if 'role' in fields:
        role = fields.get('role')
        if role not in ('admin', 'employee'):
            return False, '无效的角色'
        sets.append('role=?')
        params.append(role)
    if 'status' in fields:
        status = fields.get('status')
        if status not in ('approved', 'pending', 'disabled', 'rejected'):
            return False, '无效的状态'
        sets.append('status=?')
        params.append(status)
    # 防止传入未声明字段：Python 3.7+ dict 保序，按 _EDITABLE_EMPLOYEE_FIELDS 白名单过滤后剩下的就是
    # 上述 if 已收集的。其它非白名单字段直接忽略，避免误改 username/password_hash。
    replace_groups = 'group_ids' in fields
    raw_group_ids = fields.get('group_ids') if replace_groups else None
    if replace_groups and raw_group_ids is not None and not isinstance(raw_group_ids, (list, tuple)):
        return False, 'group_ids 必须是数组'

    with _lock:
        conn = _conn()
        try:
            row = conn.execute("SELECT id FROM employees WHERE id=?", (user_id,)).fetchone()
            if not row:
                return False, '用户不存在'
            if sets:
                params.append(user_id)
                conn.execute(f"UPDATE employees SET {','.join(sets)} WHERE id=?", params)
            if replace_groups:
                conn.execute("DELETE FROM employee_groups WHERE employee_id=?", (user_id,))
                for gid in (raw_group_ids or []):
                    try:
                        gid_int = int(gid)
                    except (TypeError, ValueError):
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO employee_groups (employee_id, group_id) VALUES (?,?)",
                        (user_id, gid_int))
            conn.commit()
            return True, None
        finally:
            conn.close()


def delete_employee(user_id):
    """删除员工账号，但保留其知识库内容。

    行为：
    1. 校验目标存在且非 admin（不允许删管理员，留一个兜底）。
    2. 该员工拥有的 knowledge_folders / knowledge_documents.owner_id 置 NULL（解绑归属），
       物理文件保持原状。依靠 owner_id ON DELETE SET NULL 也可达到同样效果，但这里
       显式置 NULL 行为更直观且与外键设置解耦。
    3. 删除 sessions / employee_groups。
    4. DELETE FROM employees。
    """
    try:
        user_id = int(user_id)
    except (TypeError, ValueError):
        return False, '无效的 ID'
    with _lock:
        conn = _conn()
        try:
            row = conn.execute("SELECT id,role FROM employees WHERE id=?", (user_id,)).fetchone()
            if not row:
                return False, '用户不存在'
            if row['role'] == 'admin':
                return False, '不能删除管理员账号'
            # 1. 显式 NULL 化 owner_id（即便 FK 已设 SET NULL，显式置 NULL 也能让外键未迁移的旧库保持正确语义）
            conn.execute("UPDATE knowledge_folders SET owner_id=NULL WHERE owner_id=?", (user_id,))
            conn.execute("UPDATE knowledge_documents SET owner_id=NULL WHERE owner_id=?", (user_id,))
            # 2. 清理关联
            conn.execute("DELETE FROM sessions WHERE employee_id=?", (user_id,))
            conn.execute("DELETE FROM employee_groups WHERE employee_id=?", (user_id,))
            # 3. 删员工
            conn.execute("DELETE FROM employees WHERE id=?", (user_id,))
            conn.commit()
            return True, None
        finally:
            conn.close()


# ---------- 根文件夹（每员工一个，parent_id=NULL 且 owner_id=该员工）----------

def get_root_folder(employee_id):
    with _lock:
        conn = _conn()
        try:
            r = conn.execute(
                "SELECT * FROM knowledge_folders WHERE parent_id IS NULL AND owner_id=? ORDER BY id LIMIT 1",
                (employee_id,)).fetchone()
            return dict(r) if r else None
        finally:
            conn.close()


def create_root_folder(employee_id, name):
    with _lock:
        conn = _conn()
        try:
            existing = conn.execute(
                "SELECT id FROM knowledge_folders WHERE parent_id IS NULL AND owner_id=? LIMIT 1",
                (employee_id,)).fetchone()
            if existing:
                r = conn.execute("SELECT * FROM knowledge_folders WHERE id=?", (existing['id'],)).fetchone()
                return dict(r)
            cur = conn.execute(
                "INSERT INTO knowledge_folders (name,parent_id,owner_id,created_at) VALUES (?,NULL,?,?)",
                (name, employee_id, datetime.datetime.now().isoformat()))
            conn.commit()
            r = conn.execute("SELECT * FROM knowledge_folders WHERE id=?", (cur.lastrowid,)).fetchone()
            return dict(r)
        finally:
            conn.close()


def ensure_all_root_folders():
    """为所有已审核通过的员工补建根文件夹（服务启动时调用，兼容历史数据）。"""
    with _lock:
        conn = _conn()
        try:
            emps = conn.execute(
                "SELECT id,display_name,username FROM employees WHERE status='approved'").fetchall()
            for e in emps:
                if not conn.execute(
                        "SELECT id FROM knowledge_folders WHERE parent_id IS NULL AND owner_id=?",
                        (e['id'],)).fetchone():
                    conn.execute(
                        "INSERT INTO knowledge_folders (name,parent_id,owner_id,created_at) VALUES (?,NULL,?,?)",
                        (e['display_name'] or e['username'], e['id'], datetime.datetime.now().isoformat()))
            conn.commit()
        finally:
            conn.close()


# ---------- 文件夹 CRUD ----------

def _subtree_ids(root_id):
    """返回 root_id 及其所有后代文件夹 id 集合（BFS）。"""
    result = {root_id}
    queue = [root_id]
    conn = _conn()
    try:
        while queue:
            cur = queue.pop()
            rows = conn.execute("SELECT id FROM knowledge_folders WHERE parent_id=?", (cur,)).fetchall()
            for r in rows:
                if r['id'] not in result:
                    result.add(r['id'])
                    queue.append(r['id'])
    finally:
        conn.close()
    return result


def is_in_own_subtree(employee_id, folder_id):
    """folder_id 是否落在员工自己根文件夹的子树内。"""
    root = get_root_folder(employee_id)
    if not root:
        return False
    return int(folder_id) == root['id'] or int(folder_id) in _subtree_ids(root['id'])


def create_folder(name, parent_id, owner_id):
    name = (name or '').strip()
    if not name:
        return None, '文件夹名必填'
    with _lock:
        conn = _conn()
        try:
            pid = int(parent_id) if parent_id not in (None, '', 0, '0') else None
            if pid is not None:
                p = conn.execute("SELECT id FROM knowledge_folders WHERE id=?", (pid,)).fetchone()
                if not p:
                    return None, '父文件夹不存在'
            cur = conn.execute(
                "INSERT INTO knowledge_folders (name,parent_id,owner_id,created_at) VALUES (?,?,?,?)",
                (name, pid, owner_id, datetime.datetime.now().isoformat()))
            conn.commit()
            fid = cur.lastrowid
            row = conn.execute("SELECT * FROM knowledge_folders WHERE id=?", (fid,)).fetchone()
            return dict(row), None
        finally:
            conn.close()


def list_folders():
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT id,name,parent_id,owner_id,created_at FROM knowledge_folders ORDER BY name").fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def get_folder(folder_id):
    with _lock:
        conn = _conn()
        try:
            r = conn.execute("SELECT * FROM knowledge_folders WHERE id=?", (int(folder_id),)).fetchone()
            return dict(r) if r else None
        finally:
            conn.close()


def _remove_file(rel_path):
    if not rel_path:
        return
    try:
        p = os.path.join(KB_DATA_DIR, rel_path)
        if os.path.isfile(p):
            os.remove(p)
    except Exception:
        pass


def delete_folder(folder_id):
    """硬删：先删物理文件，再删文件夹行（外键级联删子文件夹与文档行）。"""
    with _lock:
        conn = _conn()
        try:
            ids = list(_subtree_ids(int(folder_id)))
            if not ids:
                return False, '文件夹不存在'
            ph = ','.join('?' * len(ids))
            docs = conn.execute(
                "SELECT id,file_path FROM knowledge_documents WHERE folder_id IN (%s)" % ph, ids).fetchall()
            for d in docs:
                _remove_file(d['file_path'])
            conn.execute("DELETE FROM knowledge_folders WHERE id IN (%s)" % ph, ids)
            conn.commit()
            return True, None
        finally:
            conn.close()


# ---------- 文档（上传/列表/下载/硬删）----------

def upload_document(folder_id, owner_id, title, file_name, mime_type, data):
    folder_id = int(folder_id)
    if not data:
        return None, '文件内容为空'
    with _lock:
        conn = _conn()
        try:
            f = conn.execute("SELECT id FROM knowledge_folders WHERE id=?", (folder_id,)).fetchone()
            if not f:
                return None, '目标文件夹不存在'
            now = datetime.datetime.now().isoformat()
            cur = conn.execute(
                "INSERT INTO knowledge_documents "
                "(folder_id,owner_id,title,file_name,file_path,file_size,mime_type,created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (folder_id, owner_id, title, file_name, '', 0, mime_type, now))
            doc_id = cur.lastrowid
            # 物理文件以 doc_id 命名存入 KB_DATA_DIR（避免中文/特殊文件名问题）
            rel = str(doc_id)
            full = os.path.join(KB_DATA_DIR, rel)
            os.makedirs(KB_DATA_DIR, exist_ok=True)
            with open(full, 'wb') as fh:
                fh.write(data)
            conn.execute(
                "UPDATE knowledge_documents SET file_path=?, file_size=? WHERE id=?",
                (rel, len(data), doc_id))
            conn.commit()
            row = conn.execute("SELECT * FROM knowledge_documents WHERE id=?", (doc_id,)).fetchone()
            return dict(row), None
        finally:
            conn.close()


def create_document_from_personal(master_doc_id, folder_id, owner_id):
    """将 master.sqlite 中的文档导入到团队库 kb.sqlite。返回创建后的 rowid，失败返回 None。"""
    import sqlite3 as sql
    master_conn = _master_db_conn()
    if master_conn is None:
        return None
    try:
        cur = master_conn.execute("PRAGMA table_info(knowledge_documents)")
        cols = [c[1] for c in cur.fetchall()]
        q = 'SELECT document_id'
        if 'title' in cols:
            q += ', title'
        if 'file_name' in cols:
            q += ', file_name'
        if 'file_size' in cols:
            q += ', file_size'
        if 'mime_type' in cols:
            q += ', mime_type'
        if 'folder_id' in cols:
            q += ', folder_id'
        q += ' FROM knowledge_documents WHERE document_id=?'
        row = master_conn.execute(q, (master_doc_id,)).fetchone()
        if not row:
            return None
        d = dict(zip([c.replace('-','_') if '-' in c else c for c in ['document_id','title','file_name','file_size','mime_type','folder_id']], row))
        title = d.get('title') or d.get('file_name') or 'unknown'
        mime = d.get('mime_type') or 'application/octet-stream'
        fsize = d.get('file_size') or 0
        target_fid = folder_id
        # 拷贝文件
        src = os.path.join(MASTER_KB, 'folders', str(d.get('folder_id') or 0), 'documents', str(master_doc_id))
        team_doc = upload_document(target_fid, owner_id, title, d.get('file_name') or 'file', mime, None)
        if team_doc and os.path.isdir(src):
            for fname in os.listdir(src):
                fp = os.path.join(src, fname)
                if os.path.isfile(fp):
                    with open(fp, 'rb') as fh:
                        data = fh.read()
                    rel = str(team_doc['id'])
                    full = os.path.join(KB_DATA_DIR, rel)
                    os.makedirs(KB_DATA_DIR, exist_ok=True)
                    with open(full, 'wb') as out:
                        out.write(data)
                    conn2 = _conn()
                    try:
                        conn2.execute("UPDATE knowledge_documents SET file_path=?, file_size=? WHERE id=?", (rel, len(data), team_doc['id']))
                        conn2.commit()
                    finally:
                        conn2.close()
                    break
        elif team_doc:
            pass  # no source dir, just metadata
        return team_doc['id'] if team_doc else None
    finally:
        master_conn.close()


def list_documents(folder_id=None):
    """folder_id=None 时返回所有文档（无参数调用）。"""
    with _lock:
        conn = _conn()
        try:
            if folder_id is None:
                rows = conn.execute(
                    "SELECT id,folder_id,owner_id,title,file_name,file_size,mime_type,created_at "
                    "FROM knowledge_documents ORDER BY title").fetchall()
            else:
                rows = conn.execute(
                    "SELECT id,folder_id,owner_id,title,file_name,file_size,mime_type,created_at "
                    "FROM knowledge_documents WHERE folder_id=? ORDER BY title",
                    (int(folder_id),)).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def search_documents(keyword):
    """模糊搜索知识库文档标题/文件名。"""
    with _lock:
        conn = _conn()
        try:
            pattern = '%{}%'.format(keyword.replace('%', '').replace('_', ''))
            rows = conn.execute(
                "SELECT id,folder_id,owner_id,title,file_name,file_size,mime_type,created_at "
                "FROM knowledge_documents WHERE title LIKE ? OR file_name LIKE ? ORDER BY title",
                (pattern, pattern)).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def get_document(doc_id):
    with _lock:
        conn = _conn()
        try:
            r = conn.execute("SELECT * FROM knowledge_documents WHERE id=?", (int(doc_id),)).fetchone()
            return dict(r) if r else None
        finally:
            conn.close()


def delete_document(doc_id):
    """硬删：删行 + 物理删文件。"""
    with _lock:
        conn = _conn()
        try:
            r = conn.execute("SELECT id,file_path FROM knowledge_documents WHERE id=?", (int(doc_id),)).fetchone()
            if not r:
                return False, '文档不存在'
            _remove_file(r['file_path'])
            conn.execute("DELETE FROM knowledge_documents WHERE id=?", (int(doc_id),))
            conn.commit()
            return True, None
        finally:
            conn.close()
