#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merge.py —— 团队知识库主库合并（服务器 cron 自动运行）

职责：
  1. 扫描 Samba 共享 incoming/ 下的 *.zip（同事/管理员在软件里点「同步到团队库」push 上来的增量包）。
  2. 把其中主库没有的文档合并进 master.sqlite（只 INSERT 不 UPDATE，靠 document_id 幂等）。
  3. 合并时写入 uploaded_by / uploaded_at（来自增量包 manifest 的 username）。
  4. 处理完的 zip 移入 incoming/processed/ 留档。
  5. 重建 master.zip（knowledge.sqlite + knowledge-base 文件目录），供同事 pull。

关键约束（与客户端 syncService.cjs 共用同一语义）：
  - 子表（knowledge_blocks / items / ...）带 INTEGER PRIMARY KEY AUTOINCREMENT 的 id 列，
    跨库合并时必须排除 id，让主库自增，否则不同来源的自增 id 会撞主键。所有复制统一排除列名为 'id'。
  - 文档级幂等：主库已有 document_id → 整篇跳过。

路径可用环境变量覆盖（默认按 /toubiao 挂载点）：
  YIBIAO_MASTER_DIR  /toubiao/yibiao-kb
  YIBIAO_SHARE_DIR   /toubiao/yibiao-share

依赖：仅 Python3 标准库（sqlite3 / zipfile / shutil），Linux 自带，零依赖。
"""

import os
import sys
import glob
import shutil
import sqlite3
import zipfile
import json
import tempfile
import datetime
import traceback

MASTER_DIR = os.environ.get('YIBIAO_MASTER_DIR', '/toubiao/yibiao-kb')
SHARE_DIR = os.environ.get('YIBIAO_SHARE_DIR', '/toubiao/yibiao-share')
INCOMING = os.path.join(SHARE_DIR, 'incoming')
PROCESSED = os.path.join(INCOMING, 'processed')
MASTER_KB = os.path.join(MASTER_DIR, 'knowledge-base')
MASTER_DB = os.path.join(MASTER_DIR, 'master.sqlite')
MASTER_ZIP = os.path.join(SHARE_DIR, 'master.zip')

# knowledge_* 中按 document_id 关联的子表
DOC_CHILD_TABLES = [
    'knowledge_blocks',
    'knowledge_candidate_items',
    'knowledge_items',
    'knowledge_item_blocks',
    'knowledge_discarded_groups',
    'knowledge_reports',
    'knowledge_document_steps',
    'knowledge_match_batches',
]

# 主库建表 schema（含 uploaded_by / uploaded_at）。需与软件 knowledge_* schema 保持一致。
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS knowledge_migration_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  legacy_index_hash TEXT, status TEXT NOT NULL DEFAULT 'idle',
  migrated_folder_count INTEGER NOT NULL DEFAULT 0, migrated_document_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, completed_at TEXT, cleanup_completed_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS knowledge_folders (
  folder_id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_documents (
  document_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, file_name TEXT NOT NULL,
  document_dir TEXT NOT NULL, source_path TEXT NOT NULL, markdown_path TEXT NOT NULL,
  markdown_hash TEXT, markdown_chars INTEGER NOT NULL DEFAULT 0, source_extension TEXT,
  status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
  error TEXT, item_count INTEGER NOT NULL DEFAULT 0, block_count INTEGER NOT NULL DEFAULT 0,
  filtered_block_count INTEGER NOT NULL DEFAULT 0, candidate_item_count INTEGER NOT NULL DEFAULT 0,
  discarded_block_count INTEGER NOT NULL DEFAULT 0, system_discarded_after_retry_count INTEGER NOT NULL DEFAULT 0,
  last_batch_size INTEGER, parser_label TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  uploaded_by TEXT, uploaded_at TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  FOREIGN KEY (folder_id) REFERENCES knowledge_folders(folder_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS knowledge_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, block_id TEXT NOT NULL,
  type TEXT NOT NULL, heading_path_json TEXT, content TEXT NOT NULL, content_chars INTEGER NOT NULL DEFAULT 0,
  is_filtered INTEGER NOT NULL DEFAULT 0, filter_reason TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  UNIQUE(document_id, block_id, is_filtered)
);
CREATE TABLE IF NOT EXISTS knowledge_candidate_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, item_id TEXT NOT NULL,
  title TEXT NOT NULL, summary TEXT NOT NULL, source TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  UNIQUE(document_id, item_id)
);
CREATE TABLE IF NOT EXISTS knowledge_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, item_id TEXT NOT NULL,
  title TEXT NOT NULL, resume TEXT NOT NULL, content TEXT NOT NULL, source_file TEXT,
  content_chars INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  UNIQUE(document_id, item_id)
);
CREATE TABLE IF NOT EXISTS knowledge_item_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, item_id TEXT NOT NULL,
  block_id TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  UNIQUE(document_id, item_id, block_id)
);
CREATE TABLE IF NOT EXISTS knowledge_discarded_groups (
  group_id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, source TEXT NOT NULL,
  reason TEXT NOT NULL, block_ids_json TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS knowledge_reports (
  document_id TEXT PRIMARY KEY, total_blocks INTEGER NOT NULL DEFAULT 0,
  filtered_blocks_count INTEGER NOT NULL DEFAULT 0, candidate_items_count INTEGER NOT NULL DEFAULT 0,
  final_items_count INTEGER NOT NULL DEFAULT 0, matched_blocks_count INTEGER NOT NULL DEFAULT 0,
  discarded_blocks_count INTEGER NOT NULL DEFAULT 0, system_discarded_after_retry_count INTEGER NOT NULL DEFAULT 0,
  new_items_from_recovery_count INTEGER NOT NULL DEFAULT 0, recovery_attempt_count INTEGER NOT NULL DEFAULT 0,
  batch_size INTEGER NOT NULL DEFAULT 20, coverage_rate REAL NOT NULL DEFAULT 0, matched_rate REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS knowledge_document_steps (
  document_id TEXT NOT NULL, step_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
  result_json TEXT, error TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, step_key),
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS knowledge_match_batches (
  document_id TEXT NOT NULL, batch_index INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
  item_ids_json TEXT NOT NULL DEFAULT '[]', matches_json TEXT, error TEXT, started_at TEXT,
  completed_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, batch_index),
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(document_id) ON DELETE CASCADE
);
"""


def ensure_master():
    os.makedirs(MASTER_DIR, exist_ok=True)
    os.makedirs(MASTER_KB, exist_ok=True)
    os.makedirs(INCOMING, exist_ok=True)
    os.makedirs(PROCESSED, exist_ok=True)
    conn = sqlite3.connect(MASTER_DB)
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    conn.close()


def copy_rows_by_doc(src, dst, table, document_id):
    cur = src.execute("SELECT * FROM %s WHERE document_id = ?" % table, (document_id,))
    rows = cur.fetchall()
    if not rows:
        return
    cols = [d[0] for d in cur.description]
    cols_no_id = [c for c in cols if c != 'id']
    placeholders = ','.join('?' * len(cols_no_id))
    sql = "INSERT OR IGNORE INTO %s (%s) VALUES (%s)" % (
        table, ','.join(cols_no_id), placeholders)
    dst.executemany(sql, [tuple(row[cols.index(c)] for c in cols_no_id) for row in rows])


def column_exists(conn, table, column):
    cur = conn.execute("PRAGMA table_info(%s)" % table)
    return any(c[1] == column for c in cur.fetchall())


def copy_document(src, dst, document_id, username, now):
    cur = src.execute("SELECT * FROM knowledge_documents WHERE document_id = ?", (document_id,))
    row = cur.fetchone()
    if not row:
        return
    cols = [d[0] for d in cur.description]
    is_deleted = 0
    if 'is_deleted' in cols:
        is_deleted = int(row[cols.index('is_deleted')] or 0)

    if is_deleted:
        # 删除指令：主库有则软删，没有则忽略（避免把已删文档插进去）
        exists = dst.execute(
            "SELECT 1 FROM knowledge_documents WHERE document_id=?", (document_id,)
        ).fetchone()
        if exists:
            dst.execute(
                "UPDATE knowledge_documents SET is_deleted=1, deleted_at=?, uploaded_by=?, uploaded_at=? WHERE document_id=?",
                (now, username, now, document_id)
            )
        return

    cols_no_id = [c for c in cols if c != 'id']
    vals = [row[cols.index(c)] for c in cols_no_id]
    cols_no_id.append('uploaded_by')
    vals.append(username)
    cols_no_id.append('uploaded_at')
    vals.append(now)
    sql = "INSERT OR IGNORE INTO knowledge_documents (%s) VALUES (%s)" % (
        ','.join(cols_no_id), ','.join('?' * len(cols_no_id)))
    dst.execute(sql, vals)
    for t in DOC_CHILD_TABLES:
        copy_rows_by_doc(src, dst, t, document_id)




def copy_folders(src, dst, folder_ids):
    if not folder_ids:
        return
    q = "SELECT * FROM knowledge_folders WHERE folder_id IN (%s)" % ','.join('?' * len(folder_ids))
    cur = src.execute(q, list(folder_ids))
    rows = cur.fetchall()
    if not rows:
        return
    cols = [d[0] for d in cur.description]
    cols_no_id = [c for c in cols if c != 'id']
    sql = "INSERT OR IGNORE INTO knowledge_folders (%s) VALUES (%s)" % (
        ','.join(cols_no_id), ','.join('?' * len(cols_no_id)))
    dst.executemany(sql, [tuple(r[cols.index(c)] for c in cols_no_id) for r in rows])


def copy_doc_files(src_kb, dst_kb, folder_id, document_id):
    src = os.path.join(src_kb, 'folders', folder_id, 'documents', document_id)
    if not os.path.isdir(src):
        return
    dst = os.path.join(dst_kb, 'folders', folder_id, 'documents', document_id)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def rebuild_master_zip():
    if os.path.exists(MASTER_ZIP):
        os.remove(MASTER_ZIP)
    with zipfile.ZipFile(MASTER_ZIP, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(MASTER_DB, 'knowledge.sqlite')
        for root, _dirs, files in os.walk(MASTER_KB):
            for f in files:
                fp = os.path.join(root, f)
                arc = os.path.join('kb', os.path.relpath(fp, MASTER_KB))
                z.write(fp, arc)
        # 如果 master 目录下有 user_config.json，也打包进去
        remote_cfg = os.path.join(MASTER_DIR, 'user_config.json')
        if os.path.exists(remote_cfg):
            z.write(remote_cfg, 'user_config.json')


def process_package(zip_path, master):
    tmp = tempfile.mkdtemp(prefix='yibiao-merge-')
    try:
        with zipfile.ZipFile(zip_path, 'r') as z:
            z.extractall(tmp)
        pkg_db = os.path.join(tmp, 'knowledge.sqlite')
        if not os.path.exists(pkg_db):
            print("[SKIP] %s: 缺少 knowledge.sqlite" % os.path.basename(zip_path))
            return False
        username = 'unknown'
        manifest_path = os.path.join(tmp, 'manifest.json')
        if os.path.exists(manifest_path):
            try:
                manifest = json.load(open(manifest_path, encoding='utf-8'))
                username = manifest.get('username', 'unknown')
            except Exception:
                pass
        
        # 如果 zip 里有 user_config.json，合并到服务器端配置
        pkg_config = os.path.join(tmp, 'user_config.json')
        remote_config = os.path.join(MASTER_DIR, 'user_config.json')
        if os.path.exists(pkg_config):
            try:
                pkg_cfg = json.load(open(pkg_config, encoding='utf-8'))
                if os.path.exists(remote_config):
                    # 已存在远程配置，合并（远程配置优先保留 AI 字段）
                    remote_cfg = json.load(open(remote_config, encoding='utf-8'))
                    merged_cfg = {
                        **remote_cfg,
                        'text_model_provider': pkg_cfg.get('text_model_provider', remote_cfg.get('text_model_provider')),
                        'text_model_profiles': {**remote_cfg.get('text_model_profiles', {}), **pkg_cfg.get('text_model_profiles', {})},
                        'image_model_profiles': {**remote_cfg.get('image_model_profiles', {}), **pkg_cfg.get('image_model_profiles', {})},
                        'image_model': pkg_cfg.get('image_model', remote_cfg.get('image_model')),
                    }
                    with open(remote_config, 'w', encoding='utf-8') as f:
                        json.dump(merged_cfg, f, ensure_ascii=False, indent=2)
                else:
                    # 首次上传配置，直接复制
                    shutil.copy2(pkg_config, remote_config)
                print("[CONFIG] user_config.json 已合并（来自 %s）" % username)
            except Exception as e:
                print("[WARN] user_config.json 合并失败: %s" % e)
        
        src = sqlite3.connect(pkg_db)
        now = datetime.datetime.now().isoformat()
        pkg_has_deleted = column_exists(src, 'knowledge_documents', 'is_deleted')
        where_clause = "status='success'"
        if pkg_has_deleted:
            where_clause = "status='success' OR is_deleted=1"
        docs = src.execute(
            "SELECT document_id, folder_id FROM knowledge_documents WHERE %s" % where_clause
        ).fetchall()
        copy_folders(src, master, set(d[1] for d in docs))
        merged = 0
        deleted = 0
        for doc_id, folder_id in docs:
            exists = master.execute(
                "SELECT 1 FROM knowledge_documents WHERE document_id=?", (doc_id,)
            ).fetchone()
            if pkg_has_deleted:
                is_deleted = src.execute(
                    "SELECT is_deleted FROM knowledge_documents WHERE document_id=?", (doc_id,)
                ).fetchone()
                if is_deleted and int(is_deleted[0] or 0):
                    if exists:
                        master.execute(
                            "UPDATE knowledge_documents SET is_deleted=1, deleted_at=?, uploaded_by=? WHERE document_id=?",
                            (now, username, doc_id)
                        )
                        deleted += 1
                    continue
            if exists:
                continue
            copy_document(src, master, doc_id, username, now)
            copy_doc_files(os.path.join(tmp, 'kb'), MASTER_KB, folder_id, doc_id)
            merged += 1
        src.close()
        master.commit()
        print("[OK] %s by %s: merged=%d, deleted=%d" % (os.path.basename(zip_path), username, merged, deleted))
        return True

    except Exception as e:
        master.rollback()
        print("[ERR] %s: %s" % (os.path.basename(zip_path), e))
        traceback.print_exc()
        return False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ensure_master()
    master = sqlite3.connect(MASTER_DB)
    master.execute('PRAGMA journal_mode=WAL')
    try:
        zips = sorted(glob.glob(os.path.join(INCOMING, '*.zip')))
        if not zips:
            print("[INFO] incoming/ 无增量包")
        for zp in zips:
            if process_package(zp, master):
                dest = os.path.join(PROCESSED, os.path.basename(zp))
                shutil.move(zp, dest)
    finally:
        master.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        master.close()
    rebuild_master_zip()
    print("[INFO] master.zip 已重建")


if __name__ == '__main__':
    main()
