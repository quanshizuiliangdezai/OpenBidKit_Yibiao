#!/usr/bin/env python3
# 方案 D（中央服务器知识库）数据层
# 负责：员工账号(employees)、登录会话(sessions)、文件夹树、文档元数据
# 认证方式：仅账号密码 + 员工自助注册 + 管理员审核
# 密码：pbkdf2_hmac(sha256) + 随机 salt，绝不存明文
import sqlite3
import os
import re
import json
import hashlib
import secrets
import datetime
import threading
import subprocess
import tempfile
import shutil

DB_PATH = os.environ.get('KB_DB', '/toubiao/yibiao-kb-server/kb.sqlite')
# 文档物理存储目录（只在服务器，客户端不留存）
KB_DATA_DIR = os.environ.get('KB_DATA_DIR', '/toubiao/yibiao-kb-server/knowledge-base')
_lock = threading.RLock()  # 可重入锁：purge_expired_trash 会嵌套调用 _hard_delete_*，避免同线程死锁

# ---------- 权限目录（前端勾选框的数据源，亦作为 admin 全权限的集合）----------
PERMISSION_CATALOG = [
    ('bid_generation', '标书生成', '技术方案、已有方案扩写、商务标等标书编制功能'),
    ('template_settings', '模版设置', '标书导出模板与排版配置'),
    ('knowledge_base', '知识库', '文档/图片知识库的上传、查阅与管理'),
    ('bid_check', '标书检查', '查重、废标项检查、AI评标'),
    ('bid_opportunity', '投标机会', '投标机会发现与线索跟踪'),
    ('resources', '资源下载', '投标相关资料与工具下载'),
    ('model_config', '模型配置', 'AI 模型接入与全局模型参数配置'),
    ('account_manage', '账户管理', '查看与管理团队成员账户'),
    ('permission_manage', '权限管理', '管理权限分组与权限分配'),
]
ALL_PERMISSION_KEYS = [k for k, _, _ in PERMISSION_CATALOG]


def _conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # 多线程并发写时，遇锁自动等待而非立即抛 database is locked
    conn.execute("PRAGMA busy_timeout=5000")
    # WAL 模式：读写互不阻塞，并发上传/检索不会互卡（8T 级库必需）
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass
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
        CREATE TABLE IF NOT EXISTS kb_analysis (
            document_id   INTEGER PRIMARY KEY,
            status        TEXT,
            payload       TEXT,
            item_count    INTEGER,
            block_count   INTEGER,
            analyzer_id   INTEGER,
            analyzer_name TEXT,
            updated_at    TEXT NOT NULL,
            FOREIGN KEY(document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
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
        CREATE TABLE IF NOT EXISTS operation_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id  INTEGER,
            account_name TEXT,
            account_type TEXT NOT NULL DEFAULT 'employee',
            role        TEXT,
            action      TEXT NOT NULL,
            target_type TEXT,
            target_id   TEXT,
            detail      TEXT,
            ip          TEXT,
            created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_operation_log_created_at ON operation_log(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_operation_log_account ON operation_log(account_id);
        CREATE TABLE IF NOT EXISTS model_config (
            id              INTEGER PRIMARY KEY CHECK (id = 1),
            analysis_model  TEXT NOT NULL DEFAULT 'sensenova-6.7-flash-lite',
            qa_model        TEXT NOT NULL DEFAULT 'sensenova-6.7-flash-lite',
            embedding_model TEXT,
            base_url        TEXT NOT NULL DEFAULT 'http://127.0.0.1:15005/v1',
            api_key         TEXT,
            file_parser_provider TEXT NOT NULL DEFAULT 'local',
            pdf_image_parser_provider TEXT NOT NULL DEFAULT 'mineru-agent-api',
            mineru_token    TEXT,
            updated_at      TEXT NOT NULL
        );
        -- 知识库问答会话（按账号隔离，软删除，跨设备可读）
        CREATE TABLE IF NOT EXISTS kb_qa_sessions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id  INTEGER NOT NULL,
            title        TEXT NOT NULL DEFAULT '新对话',
            library_type TEXT NOT NULL DEFAULT 'team',
            status       TEXT NOT NULL DEFAULT 'idle',
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL,
            deleted_at   TEXT,
            FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_kb_qa_sessions_emp
            ON kb_qa_sessions(employee_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS kb_qa_messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER NOT NULL,
            employee_id INTEGER NOT NULL,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL DEFAULT 'done',
            sources     TEXT,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES kb_qa_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_kb_qa_messages_session
            ON kb_qa_messages(session_id, id);
        ''')
    conn.close()
    # 一次性迁移：旧库 owner_id 为 NOT NULL 且无 ON DELETE 规则，删员工会被外键挡住。
    # 迁移为可空 + ON DELETE SET NULL，配套 update_employee / delete_employee 实现「只删账号、保 KB」。
    _migrate_owner_id_to_nullable()
    # 回收站软删列 + 全文检索列（向后兼容旧库）
    _migrate_recycle_and_fulltext_columns()
    # 8T 级性能优化：建高频过滤列索引 + 团队库 FTS5 全文索引（trigram，兼容中文子串）
    _ensure_kb_indexes()
    _rebuild_team_fts_if_needed()
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


def _migrate_recycle_and_fulltext_columns():
    """向后兼容迁移：给知识库表加回收站软删列 + 全文检索列。

    - knowledge_folders / knowledge_documents 增加 deleted_at（软删时间戳，NULL=未删）
    - knowledge_documents 增加 content_text（上传时抽取的纯文本，供全文检索）
    只迁移一次，已存在的列跳过。
    """
    conn = _conn()
    try:
        for tbl in ('knowledge_folders', 'knowledge_documents'):
            cols = {r[1] for r in conn.execute("PRAGMA table_info(%s)" % tbl).fetchall()}
            if 'deleted_at' not in cols:
                conn.execute("ALTER TABLE %s ADD COLUMN deleted_at TEXT" % tbl)
            if 'deleted_by' not in cols:
                conn.execute("ALTER TABLE %s ADD COLUMN deleted_by TEXT" % tbl)
        doc_cols = {r[1] for r in conn.execute("PRAGMA table_info(knowledge_documents)").fetchall()}
        if 'content_text' not in doc_cols:
            conn.execute("ALTER TABLE knowledge_documents ADD COLUMN content_text TEXT")
        conn.commit()
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
            # 返回 dict 而非 sqlite3.Row：server.py 多处依赖 employee.get('role') 等 .get() 访问，
            # Row 对象无 .get() 方法会抛 AttributeError 导致 500（见 _personal_documents 等）。
            return dict(e)
        finally:
            conn.close()


def verify_admin_password(admin_id, password):
    """校验当前管理员密码是否正确（仅校验，不创建/清理 session）。"""
    if not admin_id or not password:
        return False, '管理员 ID 与密码均不能为空'
    with _lock:
        conn = _conn()
        try:
            row = conn.execute("SELECT * FROM employees WHERE id=? AND role='admin'", (int(admin_id),)).fetchone()
            if not row:
                return False, '管理员不存在或无权限'
            if not verify_password(password, row['password_salt'], row['password_hash']):
                return False, '管理员密码错误'
            return True, None
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


# ---------- 审计日志 ----------

def audit_log(action, target_type=None, target_id=None, detail=None,
              account_id=None, account_name=None, account_type='employee',
              role=None, ip=None):
    """写入操作审计日志。异常会被静默捕获，避免影响主流程。"""
    try:
        with _lock:
            conn = _conn()
            try:
                conn.execute(
                    """INSERT INTO operation_log
                        (account_id, account_name, account_type, role, action, target_type, target_id, detail, ip, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (account_id, account_name, account_type, role, action,
                     target_type, target_id, detail, ip,
                     datetime.datetime.now().isoformat()))
                conn.commit()
            finally:
                conn.close()
    except Exception:
        # 审计失败不应阻断业务，静默吞掉
        pass


# ---------- 账号管理（管理员操作）----------

# 允许设置的账号状态白名单
ALLOWED_STATUS = ('pending', 'approved', 'rejected', 'disabled')


def reset_password(user_id, new_password, keep_token=None):
    """管理员重置某用户密码。成功后清掉该用户旧会话，强制重新登录。
    若传入 keep_token 且属于该用户，则保留该会话（用于管理员重置自己密码时不踢掉自己）。
    """
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
            if keep_token:
                conn.execute(
                    "DELETE FROM sessions WHERE employee_id=? AND token != ?",
                    (user_id, keep_token))
            else:
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

def _subtree_ids(root_id, include_deleted=False):
    """返回 root_id 及其所有后代文件夹 id 集合（BFS）。

    include_deleted=True 时连已被软删的文件夹也纳入（用于回收站级联删除/恢复）。
    """
    result = {root_id}
    queue = [root_id]
    conn = _conn()
    try:
        while queue:
            cur = queue.pop()
            q = "SELECT id FROM knowledge_folders WHERE parent_id=?"
            if not include_deleted:
                q += " AND (deleted_at IS NULL OR deleted_at='')"
            rows = conn.execute(q, (cur,)).fetchall()
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


def list_folders(include_deleted=False):
    with _lock:
        conn = _conn()
        try:
            q = ("SELECT id,name,parent_id,owner_id,created_at,deleted_at FROM knowledge_folders"
                 " WHERE (deleted_at IS NULL OR deleted_at='')" if not include_deleted
                 else "SELECT id,name,parent_id,owner_id,created_at,deleted_at FROM knowledge_folders")
            q += " ORDER BY name"
            rows = conn.execute(q).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def get_folder(folder_id, include_deleted=False):
    with _lock:
        conn = _conn()
        try:
            q = "SELECT * FROM knowledge_folders WHERE id=?"
            if not include_deleted:
                q += " AND (deleted_at IS NULL OR deleted_at='')"
            r = conn.execute(q, (int(folder_id),)).fetchone()
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


def delete_folder(folder_id, deleted_by=None):
    """软删（进回收站）：标记文件夹及其所有后代文件夹、文档的 deleted_at。

    物理文件保留，待 purge_expired_trash 超时后物理删除。
    返回 (True, None) 或 (False, 错误)。
    """
    with _lock:
        conn = _conn()
        try:
            ids = list(_subtree_ids(int(folder_id), include_deleted=True))
            if not ids:
                return False, '文件夹不存在'
            ts = datetime.datetime.now().isoformat()
            ph = ','.join('?' * len(ids))
            # 级联标记后代文件夹
            conn.execute(
                "UPDATE knowledge_folders SET deleted_at=?, deleted_by=? WHERE id IN (%s)" % ph,
                [ts, str(deleted_by) if deleted_by is not None else None] + ids)
            # 级联标记其下所有文档
            docs = conn.execute(
                "SELECT id FROM knowledge_documents WHERE folder_id IN (%s)" % ph, ids).fetchall()
            if docs:
                dph = ','.join('?' * len(docs))
                conn.execute(
                    "UPDATE knowledge_documents SET deleted_at=?, deleted_by=? WHERE id IN (%s)" % dph,
                    [ts, str(deleted_by) if deleted_by is not None else None] + [d['id'] for d in docs])
            conn.commit()
            return True, None
        finally:
            conn.close()


def _hard_delete_folder_tree(folder_id):
    """物理硬删：彻底删除文件夹树及其文档与物理文件（回收站清理用）。"""
    with _lock:
        conn = _conn()
        try:
            ids = list(_subtree_ids(int(folder_id), include_deleted=True))
            ph = ','.join('?' * len(ids))
            docs = conn.execute(
                "SELECT id,file_path FROM knowledge_documents WHERE folder_id IN (%s)" % ph, ids).fetchall()
            for d in docs:
                _remove_file(d['file_path'])
            conn.execute("DELETE FROM knowledge_documents WHERE folder_id IN (%s)" % ph, ids)
            conn.execute("DELETE FROM knowledge_folders WHERE id IN (%s)" % ph, ids)
            conn.commit()
        finally:
            conn.close()


def restore_folder(folder_id):
    """从回收站恢复：取消文件夹及其后代、文档的 deleted_at。"""
    with _lock:
        conn = _conn()
        try:
            ids = list(_subtree_ids(int(folder_id), include_deleted=True))
            if not ids:
                return False, '文件夹不存在'
            ph = ','.join('?' * len(ids))
            conn.execute(
                "UPDATE knowledge_folders SET deleted_at=NULL WHERE id IN (%s)" % ph, ids)
            conn.execute(
                "UPDATE knowledge_documents SET deleted_at=NULL WHERE folder_id IN (%s)" % ph, ids)
            conn.commit()
            return True, None
        finally:
            conn.close()


def rename_folder(folder_id, name):
    name = (name or '').strip()
    if not name:
        return False, '文件夹名不能为空'
    with _lock:
        conn = _conn()
        try:
            r = conn.execute(
                "SELECT id FROM knowledge_folders WHERE id=? AND (deleted_at IS NULL OR deleted_at='')",
                (int(folder_id),)).fetchone()
            if not r:
                return False, '文件夹不存在'
            conn.execute("UPDATE knowledge_folders SET name=? WHERE id=?", (name, int(folder_id)))
            conn.commit()
            return True, None
        finally:
            conn.close()


def move_folder(folder_id, new_parent_id):
    """移动文件夹到 new_parent_id 下（None/0 表示根目录）。含防环校验：不能移到自身或自己的后代下。"""
    fid = int(folder_id)
    with _lock:
        conn = _conn()
        try:
            r = conn.execute(
                "SELECT id FROM knowledge_folders WHERE id=? AND (deleted_at IS NULL OR deleted_at='')",
                (fid,)).fetchone()
            if not r:
                return False, '文件夹不存在'
            pid = None if new_parent_id in (None, '', 0, '0') else int(new_parent_id)
            if pid is not None:
                p = conn.execute(
                    "SELECT id FROM knowledge_folders WHERE id=? AND (deleted_at IS NULL OR deleted_at='')",
                    (pid,)).fetchone()
                if not p:
                    return False, '目标文件夹不存在'
                # 防环：目标不能是自身或自己的后代
                subtree = _subtree_ids(fid, include_deleted=True)
                if pid in subtree:
                    return False, '不能移动到自身或其子文件夹下'
            conn.execute("UPDATE knowledge_folders SET parent_id=? WHERE id=?", (pid, fid))
            conn.commit()
            return True, None
        finally:
            conn.close()


def move_document(doc_id, new_folder_id):
    """移动文档到 new_folder_id 下。校验文档与目标文件夹均存在且未删除。"""
    did = int(doc_id)
    with _lock:
        conn = _conn()
        try:
            d = conn.execute(
                "SELECT id FROM knowledge_documents WHERE id=? AND (deleted_at IS NULL OR deleted_at='')",
                (did,)).fetchone()
            if not d:
                return False, '文档不存在'
            fid = int(new_folder_id)
            f = conn.execute(
                "SELECT id FROM knowledge_folders WHERE id=? AND (deleted_at IS NULL OR deleted_at='')",
                (fid,)).fetchone()
            if not f:
                return False, '目标文件夹不存在'
            conn.execute("UPDATE knowledge_documents SET folder_id=? WHERE id=?", (fid, did))
            conn.commit()
            return True, None
        finally:
            conn.close()


# ---------- 文档（上传/列表/下载/硬删）----------

def _libreoffice_to_text(data, ext):
    """使用 LibreOffice 将 office/pdf 文件转换为纯文本。ext 应包含点，如 .docx。"""
    if not shutil.which('libreoffice') and not shutil.which('soffice'):
        return ''
    tmpdir = tempfile.mkdtemp(prefix='yibiao_extract_')
    try:
        src = os.path.join(tmpdir, f'src{ext}')
        with open(src, 'wb') as f:
            f.write(data)
        cmd = ['libreoffice', '--headless', '--convert-to', 'txt:Text', '--outdir', tmpdir, src]
        try:
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
        except Exception:
            return ''
        txt_path = os.path.join(tmpdir, f'src.txt')
        if not os.path.exists(txt_path):
            return ''
        with open(txt_path, 'rb') as f:
            return f.read()[:200000].decode('utf-8', 'replace')
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _extract_text_for_search(data, file_name, mime_type):
    """从上传内容中抽取纯文本，供全文检索/RAG使用。失败时返回空，不阻断上传。"""
    try:
        ext = (file_name or '').lower().rsplit('.', 1)[-1] if '.' in (file_name or '') else ''
        ext_with_dot = f'.{ext}' if ext else ''
        textish = {'txt', 'md', 'markdown', 'csv', 'json', 'log', 'xml', 'html', 'htm', 'text', 'yaml', 'yml', 'ini', 'conf'}
        if ext in textish or (mime_type or '').startswith('text/'):
            try:
                return data[:200000].decode('utf-8', 'replace')
            except Exception:
                return ''
        # PDF：优先 PyPDF2，失败用 LibreOffice
        if ext == 'pdf':
            text = ''
            try:
                from PyPDF2 import PdfReader
                import io as _io
                reader = PdfReader(_io.BytesIO(data))
                text = '\n'.join((p.extract_text() or '') for p in reader.pages)[:200000]
            except Exception:
                pass
            if not text:
                text = _libreoffice_to_text(data, ext_with_dot)
            return text
        # DOCX：优先 python-docx，失败用 LibreOffice
        if ext == 'docx':
            text = ''
            try:
                import docx
                import io as _io
                d = docx.Document(_io.BytesIO(data))
                text = '\n'.join(par.text for par in d.paragraphs)[:200000]
            except Exception:
                pass
            if not text:
                text = _libreoffice_to_text(data, ext_with_dot)
            return text
        # DOC/WPS/XLS/XLSX/PPT/PPTX 等：直接走 LibreOffice
        if ext in ('doc', 'wps', 'et', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'):
            return _libreoffice_to_text(data, ext_with_dot)
    except Exception:
        return ''
    return ''


def extract_content_text_from_analysis(payload):
    """从分析结果 payload 的 markdown 中抽取纯文本，供全文检索 / QA 召回使用。

    背景：上传阶段的 _extract_text_for_search 对扫描件 PDF 无能为力
    （PyPDF2 与 LibreOffice 都拿不到文字层），content_text 会是空串，
    导致这类文档在「按正文搜索」和知识库问答里永远召不回来。
    而 Worker 走 OCR / 本地解析后，payload.markdown 里已有完整正文，
    这里把它复用成 content_text，避免二次解析。
    对 docx 也有收益：python-docx 只取 paragraphs，会漏掉表格里的文字，
    markdown 则包含表格内容。
    """
    try:
        obj = json.loads(payload) if isinstance(payload, str) else payload
    except (TypeError, ValueError):
        return ''
    if not isinstance(obj, dict):
        return ''
    md = obj.get('markdown') or obj.get('content') or ''
    if not isinstance(md, str) or not md.strip():
        return ''
    text = md
    # HTML 表格/段落标签 -> 空白，保留单元格文字
    text = re.sub(r'</\s*(tr|table|p|div|h[1-6]|li)\s*>', '\n', text, flags=re.I)
    text = re.sub(r'</\s*(td|th)\s*>', ' ', text, flags=re.I)
    text = re.sub(r'<[^>]+>', '', text)
    # markdown 图片丢弃、链接只留文字
    text = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', text)
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)
    # 压缩空白
    text = re.sub(r'[ \t\u00a0]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()[:200000]


def reextract_document_text(doc_id):
    """根据磁盘上的原始文件重新抽取 content_text，用于修复历史数据。"""
    with _lock:
        conn = _conn()
        try:
            row = conn.execute("SELECT id, file_name, mime_type, file_path FROM knowledge_documents WHERE id=?", (int(doc_id),)).fetchone()
            if not row:
                return False, '文档不存在'
            full = os.path.join(KB_DATA_DIR, row['file_path']) if row['file_path'] else ''
            if not full or not os.path.exists(full):
                return False, '物理文件不存在'
            with open(full, 'rb') as f:
                data = f.read()
            content_text = _extract_text_for_search(data, row['file_name'], row['mime_type'])
            conn.execute("UPDATE knowledge_documents SET content_text=? WHERE id=?", (content_text, int(doc_id)))
            conn.commit()
            return True, None
        finally:
            conn.close()


def reextract_all_documents_text():
    """批量重抽所有非删除文档的 content_text，返回 (成功数, 失败列表)。"""
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT id FROM knowledge_documents WHERE (deleted_at IS NULL OR deleted_at='')"
            ).fetchall()
        finally:
            conn.close()
    ok = 0
    fails = []
    for row in rows:
        success, err = reextract_document_text(row['id'])
        if success:
            ok += 1
        else:
            fails.append((row['id'], err))
    return ok, fails


def upload_document(folder_id, owner_id, title, file_name, mime_type, data):
    folder_id = int(folder_id)
    if not data:
        return None, '文件内容为空'
    content_text = _extract_text_for_search(data, file_name, mime_type)
    with _lock:
        conn = _conn()
        try:
            f = conn.execute("SELECT id FROM knowledge_folders WHERE id=?", (folder_id,)).fetchone()
            if not f:
                return None, '目标文件夹不存在'
            now = datetime.datetime.now().isoformat()
            cur = conn.execute(
                "INSERT INTO knowledge_documents "
                "(folder_id,owner_id,title,file_name,file_path,file_size,mime_type,created_at,content_text) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (folder_id, owner_id, title, file_name, '', 0, mime_type, now, content_text))
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


def list_documents(folder_id=None, include_deleted=False, page=None, limit=None):
    """folder_id=None 时返回所有文档（无参数调用）。默认过滤已进回收站的文档。

    8T 级优化：支持分页（page 从 1 起，limit 上限 1000）。未分页的全库列举（folder=None）
    加 5000 安全上限，避免一次返回 80 万行巨型 JSON 撑爆服务端/客户端。
    """
    base = ("SELECT d.id,d.folder_id,d.owner_id,d.title,d.file_name,d.file_size,d.mime_type,"
            "d.created_at,d.deleted_at,COALESCE(e.display_name,e.username) AS uploaded_by_name,"
            "d.owner_id AS uploaded_by "
            "FROM knowledge_documents d LEFT JOIN employees e ON e.id=d.owner_id")
    if not include_deleted:
        base += " WHERE (d.deleted_at IS NULL OR d.deleted_at='')"
    with _lock:
        conn = _conn()
        try:
            if folder_id is not None:
                q = (base + " AND d.folder_id=?" if not include_deleted
                     else base + " WHERE d.folder_id=?") + " ORDER BY d.title"
                rows = conn.execute(q, (int(folder_id),)).fetchall()
                return [dict(r) for r in rows]
            # 全库列举
            if limit:
                try:
                    limit = max(1, min(int(limit), 1000))
                except (TypeError, ValueError):
                    limit = 1000
                try:
                    page = max(0, int(page) - 1) if page else 0
                except (TypeError, ValueError):
                    page = 0
                q = base + " ORDER BY d.title LIMIT ? OFFSET ?"
                rows = conn.execute(q, (limit, page * limit)).fetchall()
            else:
                # 无分页：安全上限，避免超大库一次返回巨量 JSON
                q = base + " ORDER BY d.title LIMIT 5000"
                rows = conn.execute(q).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


# ============================================================
# 8T 级性能优化：FTS5 全文索引（trigram 分词，兼容中文子串）
# ============================================================
def ensure_fts(conn, rowid_col='id', cols=('title', 'file_name', 'content_text')):
    """为 knowledge_documents 建 FTS5(trigram) 全文索引表 kb_fts + 同步触发器。幂等。

    把标题/文件名/正文的全文检索从 O(N) 的 LIKE 全表扫描降到索引查找。
    团队库 knowledge_documents 主键为 INTEGER id，可直接用外部内容表（content=knowledge_documents），
    索引按内容表 rowid 关联、几乎不额外占存储。个人库主键为 TEXT document_id（无整数 rowid），
    不支持外部内容，个人库检索走下面的 LIMIT 截断兜底（见 server._personal_search）。
    """
    col_defs = ', '.join(cols)
    new_cols = ', '.join('new.' + c for c in cols)
    old_cols = ', '.join('old.' + c for c in cols)
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5("
            "%s, content='knowledge_documents', content_rowid='%s', tokenize='trigram')"
            % (col_defs, rowid_col)
        )
    except Exception:
        return False
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS kb_fts_ai AFTER INSERT ON knowledge_documents BEGIN "
        "INSERT INTO kb_fts(rowid, %s) VALUES (new.%s, %s); END"
        % (col_defs, rowid_col, new_cols))
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS kb_fts_ad AFTER DELETE ON knowledge_documents BEGIN "
        "INSERT INTO kb_fts(kb_fts, rowid, %s) VALUES('delete', old.%s, %s); END"
        % (col_defs, rowid_col, old_cols))
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS kb_fts_au AFTER UPDATE ON knowledge_documents BEGIN "
        "INSERT INTO kb_fts(kb_fts, rowid, %s) VALUES('delete', old.%s, %s); "
        "INSERT INTO kb_fts(rowid, %s) VALUES (new.%s, %s); END"
        % (col_defs, rowid_col, old_cols, col_defs, rowid_col, new_cols))
    return True


def fts_match_ids(conn, keyword, rowid_col='id', limit=None):
    """用 FTS5 trigram 返回匹配的关键字 rowid 列表；返回 None 表示应回退 LIKE
    （FTS 不可用 / 空索引 / 关键词 < 3 字符，trigram 至少需要 3 字符）。"""
    kw = (keyword or '').strip()
    if len(kw) < 3:
        return None
    try:
        cnt = conn.execute("SELECT count(*) FROM kb_fts").fetchone()[0]
        if cnt == 0:
            total = conn.execute("SELECT count(*) FROM knowledge_documents").fetchone()[0]
            if total > 0:
                return None  # 索引尚未建立（如批量导入未触发触发器），回退 LIKE 保证正确
        q = '"' + kw.replace('"', '""') + '"'
        if limit:
            rows = conn.execute("SELECT rowid FROM kb_fts WHERE kb_fts MATCH ? LIMIT ?", (q, limit)).fetchall()
        else:
            rows = conn.execute("SELECT rowid FROM kb_fts WHERE kb_fts MATCH ?", (q,)).fetchall()
        return [r[0] for r in rows]
    except Exception:
        return None


def _ensure_kb_indexes():
    """为团队库高频过滤列建索引（文件夹/回收站/时间/owner），加速列举与扫描过滤。"""
    try:
        conn = _conn()
        try:
            for sql in [
                'CREATE INDEX IF NOT EXISTS idx_kb_docs_folder ON knowledge_documents(folder_id)',
                'CREATE INDEX IF NOT EXISTS idx_kb_docs_deleted ON knowledge_documents(deleted_at)',
                'CREATE INDEX IF NOT EXISTS idx_kb_docs_created ON knowledge_documents(created_at)',
                'CREATE INDEX IF NOT EXISTS idx_kb_docs_owner ON knowledge_documents(owner_id)',
                'CREATE INDEX IF NOT EXISTS idx_kb_folders_parent ON knowledge_folders(parent_id)',
                'CREATE INDEX IF NOT EXISTS idx_kb_folders_owner ON knowledge_folders(owner_id)',
            ]:
                try:
                    conn.execute(sql)
                except Exception:
                    pass
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        print('[kb-auth] 团队库索引创建跳过: %s' % e, flush=True)


def _rebuild_team_fts_if_needed(threshold=200000):
    """启动兜底：若 FTS 空而文档数<=threshold，自动一次性重建；超过阈值则跳过（避免 8T 库启动卡死），
    由管理员调用 /api/admin/rebuild-fts 手动触发。正常经 App 上传的文档会由触发器增量建索引。"""
    try:
        conn = _conn()
        try:
            ensure_fts(conn)
            total = conn.execute("SELECT count(*) FROM knowledge_documents").fetchone()[0]
            fts_cnt = conn.execute("SELECT count(*) FROM kb_fts").fetchone()[0]
            if fts_cnt == 0 and 0 < total <= threshold:
                conn.execute("INSERT INTO kb_fts(kb_fts) VALUES('rebuild')")
                conn.execute(
                    "INSERT INTO kb_fts(rowid, title, file_name, content_text) "
                    "SELECT id, title, file_name, COALESCE(content_text,'') FROM knowledge_documents")
                conn.commit()
                print('[kb-auth] 团队库 FTS 索引已重建，文档数=%d' % total, flush=True)
            elif fts_cnt == 0 and total > threshold:
                print('[kb-auth] 团队库文档数=%d 超过自动重建阈值，跳过（请用 /api/admin/rebuild-fts 手动触发）' % total, flush=True)
        finally:
            conn.close()
    except Exception as e:
        print('[kb-auth] FTS 初始化跳过: %s' % e, flush=True)


def rebuild_team_fts():
    """手动重建团队库 FTS 索引（供 /api/admin/rebuild-fts 调用）。返回索引后的文档数。"""
    conn = _conn()
    try:
        ensure_fts(conn)
        conn.execute("INSERT INTO kb_fts(kb_fts) VALUES('rebuild')")
        conn.execute(
            "INSERT INTO kb_fts(rowid, title, file_name, content_text) "
            "SELECT id, title, file_name, COALESCE(content_text,'') FROM knowledge_documents")
        conn.commit()
        return conn.execute("SELECT count(*) FROM kb_fts").fetchone()[0]
    finally:
        conn.close()


def search_documents(keyword, limit=500):
    """按文件名/标题模糊搜索（回收站外）。优先 FTS5，缺索引时回退 LIKE。"""
    pattern = '%{}%'.format(keyword.replace('%', '').replace('_', ''))
    base_sel = ("SELECT d.id,d.folder_id,d.owner_id,d.title,d.file_name,d.file_size,d.mime_type,d.created_at,"
                "COALESCE(e.display_name,e.username) AS uploaded_by_name,d.owner_id AS uploaded_by "
                "FROM knowledge_documents d LEFT JOIN employees e ON e.id=d.owner_id "
                "WHERE (d.deleted_at IS NULL OR d.deleted_at='')")
    with _lock:
        conn = _conn()
        try:
            ensure_fts(conn)
            ids = fts_match_ids(conn, keyword, limit=limit * 4)
            if ids is not None:
                if not ids:
                    return []
                ph = ','.join('?' * len(ids))
                rows = conn.execute(base_sel + " AND d.id IN (%s)" % ph, tuple(ids)).fetchall()
                # 名字模式：仅保留标题/文件名命中的（FTS 可能命中正文）
                low = keyword.lower()
                rows = [r for r in rows
                        if low in (r['title'] or '').lower() or low in (r['file_name'] or '').lower()]
                return [dict(r) for r in rows][:limit]
            q = base_sel + " AND (d.title LIKE ? OR d.file_name LIKE ?) ORDER BY d.title LIMIT ?"
            rows = conn.execute(q, (pattern, pattern, limit)).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def search_documents_fulltext(keyword, limit=500):
    """全文检索：标题/文件名/抽取正文（content_text）模糊匹配。优先 FTS5，缺索引时回退 LIKE。"""
    pattern = '%{}%'.format(keyword.replace('%', '').replace('_', ''))
    base_sel = ("SELECT d.id,d.folder_id,d.owner_id,d.title,d.file_name,d.file_size,d.mime_type,d.created_at,"
                "COALESCE(e.display_name,e.username) AS uploaded_by_name,d.owner_id AS uploaded_by "
                "FROM knowledge_documents d LEFT JOIN employees e ON e.id=d.owner_id "
                "WHERE (d.deleted_at IS NULL OR d.deleted_at='')")
    with _lock:
        conn = _conn()
        try:
            ensure_fts(conn)
            ids = fts_match_ids(conn, keyword, limit=limit)
            if ids is not None:
                if not ids:
                    return []
                ph = ','.join('?' * len(ids))
                rows = conn.execute(base_sel + " AND d.id IN (%s) ORDER BY d.title" % ph, tuple(ids)).fetchall()
                return [dict(r) for r in rows]
            q = base_sel + (" AND (d.title LIKE ? OR d.file_name LIKE ? OR COALESCE(d.content_text,'') LIKE ?) "
                            "ORDER BY d.title LIMIT ?")
            rows = conn.execute(q, (pattern, pattern, pattern, limit)).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


# ---------- 团队库分析共享（任一人分析，全员可读）----------

def save_team_analysis(document_id, status, payload, item_count=None, block_count=None,
                       analyzer_id=None, analyzer_name=None):
    """写回/更新某团队文档的分析结果（切块/条目等序列化为 JSON 文本）。"""
    with _lock:
        conn = _conn()
        try:
            payload_str = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
            conn.execute(
                """INSERT INTO kb_analysis
                   (document_id, status, payload, item_count, block_count, analyzer_id, analyzer_name, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(document_id) DO UPDATE SET
                     status=excluded.status, payload=excluded.payload,
                     item_count=excluded.item_count, block_count=excluded.block_count,
                     analyzer_id=excluded.analyzer_id, analyzer_name=excluded.analyzer_name,
                     updated_at=excluded.updated_at""",
                (int(document_id), status, payload_str, item_count, block_count,
                 analyzer_id, analyzer_name, datetime.datetime.now().isoformat())
            )
            # 分析成功时用解析出的正文回填 content_text：扫描件 PDF 上传阶段抽不出
            # 文字（content_text 为空），只有这里能补上，否则全文检索/问答召不回。
            if status == 'success':
                try:
                    text = extract_content_text_from_analysis(payload_str)
                    if text:
                        cols = {c[1] for c in conn.execute(
                            "PRAGMA table_info(knowledge_documents)").fetchall()}
                        if 'content_text' in cols:
                            row = conn.execute(
                                "SELECT LENGTH(COALESCE(content_text,'')) AS n "
                                "FROM knowledge_documents WHERE id=?", (int(document_id),)).fetchone()
                            # 仅在解析文本更完整时覆盖，避免把干净正文换成更差的结果
                            if not row or (row['n'] or 0) < len(text):
                                conn.execute(
                                    "UPDATE knowledge_documents SET content_text=? WHERE id=?",
                                    (text, int(document_id)))
                except Exception:
                    pass
            conn.commit()
        finally:
            conn.close()


def get_team_analysis(document_id):
    """返回分析结果 dict 或 None。"""
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT document_id, status, payload, item_count, block_count, analyzer_id, analyzer_name, updated_at "
                "FROM kb_analysis WHERE document_id=?", (int(document_id),)
            ).fetchone()
        finally:
            conn.close()
    if not row:
        return None
    payload = row['payload']
    try:
        payload_obj = json.loads(payload) if payload else None
    except (TypeError, ValueError):
        payload_obj = None
    return {
        'document_id': row['document_id'],
        'status': row['status'],
        'payload': payload_obj,
        'item_count': row['item_count'],
        'block_count': row['block_count'],
        'analyzer_id': row['analyzer_id'],
        'analyzer_name': row['analyzer_name'],
        'updated_at': row['updated_at'],
    }


def delete_team_analysis(document_id):
    """删除某文档的分析缓存（文档被删时调用）。"""
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM kb_analysis WHERE document_id=?", (int(document_id),))
            conn.commit()
        finally:
            conn.close()


# ---------- 全局模型配置（管理员在设置页配置，全员统一生效）----------

def _ensure_model_config_row():
    """确保 id=1 的配置行存在（首次访问时插入默认）。"""
    conn = _conn()
    try:
        row = conn.execute("SELECT id FROM model_config WHERE id=1").fetchone()
        # 迁移：已存在的库补加文件解析方式字段（不影响新建库）
        try:
            cols = {r['name'] for r in conn.execute("PRAGMA table_info(model_config)").fetchall()}
            if 'file_parser_provider' not in cols:
                conn.execute("ALTER TABLE model_config ADD COLUMN file_parser_provider TEXT NOT NULL DEFAULT 'local'")
            if 'mineru_token' not in cols:
                conn.execute("ALTER TABLE model_config ADD COLUMN mineru_token TEXT")
            if 'pdf_image_parser_provider' not in cols:
                conn.execute("ALTER TABLE model_config ADD COLUMN pdf_image_parser_provider TEXT NOT NULL DEFAULT 'mineru-agent-api'")
            # DDL 必须显式提交：本函数仅在配置行已存在时不走下面的 commit 分支，
            # 否则 ALTER 会随连接关闭被回滚（实测导致字段丢失）。
            conn.commit()
        except Exception:
            pass
        if not row:
            now = datetime.datetime.now().isoformat()
            conn.execute(
                "INSERT INTO model_config (id, analysis_model, qa_model, embedding_model, base_url, api_key, "
                "file_parser_provider, mineru_token, updated_at) "
                "VALUES (1, 'sensenova-6.7-flash-lite', 'sensenova-6.7-flash-lite', NULL, "
                "'http://127.0.0.1:15005/v1', NULL, 'local', NULL, ?)",
                (now,))
            conn.commit()
    finally:
        conn.close()


def get_model_config():
    """返回全局模型配置 dict（base_url/api_key/analysis_model/qa_model/embedding_model）。"""
    _ensure_model_config_row()
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT base_url, api_key, analysis_model, qa_model, embedding_model, "
                "file_parser_provider, pdf_image_parser_provider, mineru_token, updated_at "
                "FROM model_config WHERE id=1").fetchone()
        finally:
            conn.close()
    if not row:
        return {
            'base_url': 'http://127.0.0.1:15005/v1', 'api_key': None,
            'analysis_model': 'sensenova-6.7-flash-lite', 'qa_model': 'sensenova-6.7-flash-lite',
            'embedding_model': None, 'file_parser_provider': 'local', 'pdf_image_parser_provider': 'local', 'mineru_token': None,
            'updated_at': None,
        }
    return {
        'base_url': row['base_url'],
        'api_key': row['api_key'],
        'analysis_model': row['analysis_model'],
        'qa_model': row['qa_model'],
        'embedding_model': row['embedding_model'],
        'file_parser_provider': row['file_parser_provider'] or 'local',
        'pdf_image_parser_provider': row['pdf_image_parser_provider'] or 'local',
        'mineru_token': row['mineru_token'],
        'updated_at': row['updated_at'],
    }


def save_model_config(base_url, api_key, analysis_model, qa_model, embedding_model,
                      file_parser_provider='local', pdf_image_parser_provider=None, mineru_token=None):
    """更新全局模型配置（upsert id=1）。"""
    _ensure_model_config_row()
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "UPDATE model_config SET base_url=?, api_key=?, analysis_model=?, qa_model=?, "
                "embedding_model=?, file_parser_provider=?, pdf_image_parser_provider=?, mineru_token=?, updated_at=? WHERE id=1",
                (base_url, api_key, analysis_model, qa_model, embedding_model,
                 file_parser_provider or 'local', pdf_image_parser_provider or 'local', mineru_token,
                 datetime.datetime.now().isoformat()))
            conn.commit()
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


def delete_document(doc_id, deleted_by=None):
    """软删（进回收站）：标记 deleted_at，物理文件保留待清理。"""
    with _lock:
        conn = _conn()
        try:
            r = conn.execute(
                "SELECT id FROM knowledge_documents WHERE id=? AND (deleted_at IS NULL OR deleted_at='')",
                (int(doc_id),)).fetchone()
            if not r:
                return False, '文档不存在'
            ts = datetime.datetime.now().isoformat()
            conn.execute(
                "UPDATE knowledge_documents SET deleted_at=?, deleted_by=? WHERE id=?",
                (ts, str(deleted_by) if deleted_by is not None else None, int(doc_id)))
            conn.commit()
            return True, None
        finally:
            conn.close()


def _hard_delete_document(doc_id):
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


def restore_document(doc_id):
    with _lock:
        conn = _conn()
        try:
            r = conn.execute("SELECT id FROM knowledge_documents WHERE id=?", (int(doc_id),)).fetchone()
            if not r:
                return False, '文档不存在'
            conn.execute("UPDATE knowledge_documents SET deleted_at=NULL WHERE id=?", (int(doc_id),))
            conn.commit()
            return True, None
        finally:
            conn.close()


def list_trash():
    """返回回收站内容：已软删的文件夹与文档（含 deleted_by 供恢复权限判断）。"""
    with _lock:
        conn = _conn()
        try:
            folders = conn.execute(
                "SELECT id,name,parent_id,owner_id,created_at,deleted_at,deleted_by FROM knowledge_folders "
                "WHERE deleted_at IS NOT NULL AND deleted_at<>'' ORDER BY deleted_at DESC").fetchall()
            docs = conn.execute(
                "SELECT id,folder_id,owner_id,title,file_name,file_size,mime_type,created_at,deleted_at,deleted_by "
                "FROM knowledge_documents WHERE deleted_at IS NOT NULL AND deleted_at<>'' ORDER BY deleted_at DESC").fetchall()
            return {
                'folders': [dict(r) for r in folders],
                'documents': [dict(r) for r in docs],
            }
        finally:
            conn.close()


def purge_expired_trash(hours=24):
    """物理清理超过 hours 小时的回收站内容。返回 (folders, docs) 清理数量。"""
    cutoff = (datetime.datetime.now() - datetime.timedelta(hours=hours)).isoformat()
    nf = nd = 0
    with _lock:
        conn = _conn()
        try:
            frows = conn.execute(
                "SELECT id FROM knowledge_folders WHERE deleted_at IS NOT NULL AND deleted_at<>'' AND deleted_at<?",
                (cutoff,)).fetchall()
            for f in frows:
                _hard_delete_folder_tree(f['id'])
                nf += 1
            drows = conn.execute(
                "SELECT id FROM knowledge_documents WHERE deleted_at IS NOT NULL AND deleted_at<>'' AND deleted_at<?",
                (cutoff,)).fetchall()
            for d in drows:
                _hard_delete_document(d['id'])
                nd += 1
            return nf, nd
        finally:
            conn.close()


# ==================== 知识库问答会话（kb_qa_sessions / kb_qa_messages）====================
# 设计要点：
#  1) 全部按 employee_id 隔离，任何读写都必须带上调用者 employee_id，杜绝越权访问他人会话；
#  2) 会话软删除（deleted_at），30 天后由 qa_purge_deleted_sessions 物理清理；
#  3) assistant 消息支持 pending 状态 —— 用户离开问答页去生成标书时，回答仍在后台继续，
#     完成后回写 content + status='done'，回来即可看到结果。

QA_DEFAULT_TITLE = '新对话'
QA_TITLE_MAX = 40


def _qa_now():
    return datetime.datetime.now().isoformat()


def _qa_title_from_question(question):
    text = (question or '').strip().replace('\n', ' ')
    if not text:
        return QA_DEFAULT_TITLE
    return text[:QA_TITLE_MAX] + ('…' if len(text) > QA_TITLE_MAX else '')


def _qa_message_row(r):
    if not r:
        return None
    d = dict(r)
    raw = d.pop('sources', None)
    try:
        d['sources'] = json.loads(raw) if raw else []
    except Exception:
        d['sources'] = []
    return d


def qa_create_session(employee_id, title=None, library_type='team'):
    """新建问答会话，返回会话 dict。"""
    now = _qa_now()
    lib = library_type if library_type in ('team', 'personal') else 'team'
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "INSERT INTO kb_qa_sessions (employee_id,title,library_type,status,created_at,updated_at) "
                "VALUES (?,?,?,'idle',?,?)",
                (int(employee_id), (title or QA_DEFAULT_TITLE)[:QA_TITLE_MAX + 1], lib, now, now))
            conn.commit()
            sid = cur.lastrowid
            row = conn.execute("SELECT * FROM kb_qa_sessions WHERE id=?", (sid,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()


def qa_list_sessions(employee_id, limit=100):
    """列出该账号的问答会话（不含已删），附带消息数与最后一条消息摘要。"""
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT s.*, "
                " (SELECT COUNT(1) FROM kb_qa_messages m WHERE m.session_id=s.id) AS message_count, "
                " (SELECT m.content FROM kb_qa_messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) AS last_content, "
                " (SELECT m.status FROM kb_qa_messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) AS last_status "
                "FROM kb_qa_sessions s "
                "WHERE s.employee_id=? AND (s.deleted_at IS NULL OR s.deleted_at='') "
                "ORDER BY s.updated_at DESC LIMIT ?",
                (int(employee_id), int(limit))).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                preview = (d.pop('last_content', None) or '').strip().replace('\n', ' ')
                d['preview'] = preview[:60]
                out.append(d)
            return out
        finally:
            conn.close()


def qa_get_session(session_id, employee_id):
    """取单个会话（校验归属）。"""
    with _lock:
        conn = _conn()
        try:
            r = conn.execute(
                "SELECT * FROM kb_qa_sessions WHERE id=? AND employee_id=? "
                "AND (deleted_at IS NULL OR deleted_at='')",
                (int(session_id), int(employee_id))).fetchone()
            return dict(r) if r else None
        finally:
            conn.close()


def qa_rename_session(session_id, employee_id, title):
    name = (title or '').strip()
    if not name:
        return False
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "UPDATE kb_qa_sessions SET title=?, updated_at=? "
                "WHERE id=? AND employee_id=? AND (deleted_at IS NULL OR deleted_at='')",
                (name[:QA_TITLE_MAX + 1], _qa_now(), int(session_id), int(employee_id)))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def qa_set_session_status(session_id, employee_id, status):
    st = status if status in ('idle', 'running', 'error') else 'idle'
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "UPDATE kb_qa_sessions SET status=?, updated_at=? WHERE id=? AND employee_id=?",
                (st, _qa_now(), int(session_id), int(employee_id)))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def qa_delete_session(session_id, employee_id):
    """软删会话。"""
    now = _qa_now()
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "UPDATE kb_qa_sessions SET deleted_at=?, updated_at=? WHERE id=? AND employee_id=?",
                (now, now, int(session_id), int(employee_id)))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def qa_clear_sessions(employee_id):
    """清空该账号全部会话（软删）。返回受影响条数。"""
    now = _qa_now()
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "UPDATE kb_qa_sessions SET deleted_at=?, updated_at=? "
                "WHERE employee_id=? AND (deleted_at IS NULL OR deleted_at='')",
                (now, now, int(employee_id)))
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()


def qa_list_messages(session_id, employee_id, after_id=0):
    """列出会话消息（校验归属）。after_id 用于增量轮询；无权访问返回 None。"""
    with _lock:
        conn = _conn()
        try:
            own = conn.execute(
                "SELECT id FROM kb_qa_sessions WHERE id=? AND employee_id=?",
                (int(session_id), int(employee_id))).fetchone()
            if not own:
                return None
            rows = conn.execute(
                "SELECT id,session_id,role,content,status,sources,created_at,updated_at "
                "FROM kb_qa_messages WHERE session_id=? AND id>? ORDER BY id ASC",
                (int(session_id), int(after_id or 0))).fetchall()
            return [_qa_message_row(r) for r in rows]
        finally:
            conn.close()


def qa_add_message(session_id, employee_id, role, content='', status='done', sources=None):
    """追加一条消息；首条用户提问自动作为会话标题。返回消息 dict。"""
    if role not in ('user', 'assistant'):
        return None
    now = _qa_now()
    src = json.dumps(sources, ensure_ascii=False) if sources else None
    with _lock:
        conn = _conn()
        try:
            sess = conn.execute(
                "SELECT id,title FROM kb_qa_sessions WHERE id=? AND employee_id=? "
                "AND (deleted_at IS NULL OR deleted_at='')",
                (int(session_id), int(employee_id))).fetchone()
            if not sess:
                return None
            cur = conn.execute(
                "INSERT INTO kb_qa_messages (session_id,employee_id,role,content,status,sources,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (int(session_id), int(employee_id), role, content or '', status, src, now, now))
            mid = cur.lastrowid
            if role == 'user' and (sess['title'] or '') in ('', QA_DEFAULT_TITLE):
                conn.execute("UPDATE kb_qa_sessions SET title=? WHERE id=?",
                             (_qa_title_from_question(content), int(session_id)))
            conn.execute("UPDATE kb_qa_sessions SET updated_at=? WHERE id=?", (now, int(session_id)))
            conn.commit()
            row = conn.execute(
                "SELECT id,session_id,role,content,status,sources,created_at,updated_at "
                "FROM kb_qa_messages WHERE id=?", (mid,)).fetchone()
            return _qa_message_row(row)
        finally:
            conn.close()


def qa_update_message(message_id, employee_id, content=None, status=None, sources=None):
    """更新消息（后台生成完成时回写）。只能改自己的消息。"""
    sets, args = [], []
    if content is not None:
        sets.append("content=?")
        args.append(content)
    if status is not None:
        sets.append("status=?")
        args.append(status)
    if sources is not None:
        sets.append("sources=?")
        args.append(json.dumps(sources, ensure_ascii=False) if sources else None)
    if not sets:
        return None
    now = _qa_now()
    sets.append("updated_at=?")
    args.append(now)
    args.extend([int(message_id), int(employee_id)])
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "UPDATE kb_qa_messages SET " + ", ".join(sets) + " WHERE id=? AND employee_id=?", args)
            if cur.rowcount == 0:
                return None
            row = conn.execute(
                "SELECT id,session_id,role,content,status,sources,created_at,updated_at "
                "FROM kb_qa_messages WHERE id=?", (int(message_id),)).fetchone()
            if row:
                conn.execute("UPDATE kb_qa_sessions SET updated_at=? WHERE id=?",
                             (now, row['session_id']))
            conn.commit()
            return _qa_message_row(row)
        finally:
            conn.close()


def qa_purge_deleted_sessions(days=30):
    """物理清理软删超过 days 天的会话及其消息。返回清理数量。"""
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT id FROM kb_qa_sessions WHERE deleted_at IS NOT NULL AND deleted_at<>'' AND deleted_at<?",
                (cutoff,)).fetchall()
            n = 0
            for r in rows:
                conn.execute("DELETE FROM kb_qa_messages WHERE session_id=?", (r['id'],))
                conn.execute("DELETE FROM kb_qa_sessions WHERE id=?", (r['id'],))
                n += 1
            conn.commit()
            return n
        finally:
            conn.close()


def qa_purge_old_sessions(days=7, now=None):
    """定时滚动清理：硬删除最近 days 天内无活动（updated_at 早于 cutoff）的活跃会话及其消息。
    软删除（deleted_at 非空）的会话不在此处理，由 qa_purge_deleted_sessions 负责。
    返回清理的会话数量。"""
    if now is None:
        now = datetime.datetime.now()
    cutoff = (now - datetime.timedelta(days=days)).isoformat()
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT id FROM kb_qa_sessions WHERE deleted_at IS NULL AND updated_at<?",
                (cutoff,)).fetchall()
            n = 0
            for r in rows:
                conn.execute("DELETE FROM kb_qa_messages WHERE session_id=?", (r['id'],))
                conn.execute("DELETE FROM kb_qa_sessions WHERE id=?", (r['id'],))
                n += 1
            conn.commit()
            return n
        finally:
            conn.close()
