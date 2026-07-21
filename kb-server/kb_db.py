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
            owner_id   INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(parent_id) REFERENCES knowledge_folders(id) ON DELETE CASCADE,
            FOREIGN KEY(owner_id) REFERENCES employees(id)
        );
        CREATE TABLE IF NOT EXISTS knowledge_documents (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id  INTEGER NOT NULL,
            owner_id   INTEGER NOT NULL,
            title      TEXT NOT NULL,
            file_name  TEXT,
            file_path  TEXT,
            file_size  INTEGER,
            mime_type  TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(folder_id) REFERENCES knowledge_folders(id) ON DELETE CASCADE,
            FOREIGN KEY(owner_id) REFERENCES employees(id)
        );
        ''')
    conn.close()
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
            return [dict(r) for r in rows]
        finally:
            conn.close()


def public_fields(e):
    return {k: e[k] for k in ('id', 'username', 'display_name', 'department', 'role', 'status',
                              'created_at')}


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


def list_documents(folder_id):
    with _lock:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT id,folder_id,owner_id,title,file_name,file_size,mime_type,created_at "
                "FROM knowledge_documents WHERE folder_id=? ORDER BY title",
                (int(folder_id),)).fetchall()
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
