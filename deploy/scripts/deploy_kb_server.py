#!/usr/bin/env python3
# 部署 yibiao-combined 服务（kb_db.py + server.py）到 59.49.48.147:5566
#
# 用法：
#   1) 复制 env 模板并填值：  cp env.example .env
#   2) 加载环境变量后运行：    python3 scripts/deploy_kb_server.py
#      （Windows PowerShell:  Get-Content .env | ForEach-Object { $k,$v = $_ -split '=',2; [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim()) } ; python scripts/deploy_kb_server.py）
#
# 注意：本脚本不硬编码任何密码，全部从环境变量读取，.env 已加入 .gitignore，切勿提交。
import paramiko
import sys
import os
import time
import datetime
import pathlib

HOST = os.environ.get('KB_DEPLOY_HOST', '59.49.48.147')
# 22 端口是 H3C Comware 路由器网关（非 Linux SSH），真正的 Linux SSH 在 5566。
PORT = int(os.environ.get('KB_DEPLOY_PORT', '5566'))
USER = os.environ.get('KB_DEPLOY_USER', 'root')
PASSWORD = os.environ.get('KB_DEPLOY_SSH_PASSWORD')
if not PASSWORD:
    sys.exit('缺少环境变量 KB_DEPLOY_SSH_PASSWORD，请先配置 .env 或从环境变量注入')

LOCAL_BASE = os.environ.get(
    'KB_DEPLOY_LOCAL_BASE',
    r'C:\Users\13370\Desktop\Workspace\OpenBidKit_Yibiao\server\yibiao-combined',
)
REMOTE_DIR = os.environ.get('KB_DEPLOY_REMOTE_DIR', '/toubiao/yibiao-combined')
FILES = ['kb_db.py', 'server.py', 'kb_audit.html']

# 跨设备同步合并脚本（merge.py）
MERGE_LOCAL = os.environ.get(
    'KB_DEPLOY_MERGE_LOCAL',
    r'C:\Users\13370\Desktop\Workspace\OpenBidKit_Yibiao\sync-server\merge.py',
)
MERGE_REMOTE_DIR = os.environ.get('KB_DEPLOY_MERGE_REMOTE_DIR', '/toubiao/yibiao-sync')
MERGE_REMOTE_PATH = os.environ.get('KB_DEPLOY_MERGE_REMOTE_PATH', f'{MERGE_REMOTE_DIR}/merge.py')


def run(ssh, cmd, timeout=60):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    rc = stdout.channel.recv_exit_status()
    return rc, out, err


def sftp_put_bytes(ssh, data, remote_path):
    sftp = ssh.open_sftp()
    try:
        with sftp.open(remote_path, 'wb') as f:
            f.write(data)
    finally:
        sftp.close()


def main():
    print(f'[{datetime.datetime.now():%H:%M:%S}] connecting {HOST}:{PORT} ...', flush=True)
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    transport_kwargs = dict(
        disabled_algorithms={
            'kex': [
                'curve25519-sha256', 'curve25519-sha256@libssh.org',
                'curve448-sha512', 'ecdh-sha2-nistp521', 'ecdh-sha2-nistp384',
                'diffie-hellman-group-exchange-sha256',
                'diffie-hellman-group-exchange-sha1',
            ],
            'ciphers': [
                'aes256-gcm@openssh.com', 'chacha20-poly1305@openssh.com',
                'aes256-ctr', 'aes192-ctr', 'aes128-ctr',
            ],
        },
    )
    ssh.connect(
        HOST, port=PORT, username=USER, password=PASSWORD, timeout=15,
        allow_agent=False, look_for_keys=False,
        **transport_kwargs,
    )
    try:
        sftp = ssh.open_sftp()
        rc, out, _ = run(ssh, f'ls -ld {REMOTE_DIR} 2>&1')
        print(f'[remote dir] {out.strip()}')

        # 备份
        ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        backup_dir = f'/tmp/kb-server-backup-{ts}'
        run(ssh, f'mkdir -p {backup_dir}')
        for f in FILES:
            remote_path = f'{REMOTE_DIR}/{f}'
            rc, out, _ = run(ssh, f'test -f {remote_path} && echo OK || echo MISSING')
            if 'OK' in out:
                run(ssh, f'cp {remote_path} {backup_dir}/{f}.bak')
                print(f'[backup] {remote_path} -> {backup_dir}/{f}.bak')

        # 上传
        for f in FILES:
            local_path = pathlib.Path(LOCAL_BASE) / f
            remote_path = f'{REMOTE_DIR}/{f}'
            if not local_path.exists():
                print(f'[skip] {local_path} not found')
                continue
            print(f'[upload] {local_path} -> {remote_path} ({local_path.stat().st_size} bytes)')
            sftp.put(str(local_path), remote_path)

        # 清缓存
        rc, out, _ = run(ssh, f'find {REMOTE_DIR} -name __pycache__ -type d -exec rm -rf {{}} + 2>/dev/null; find {REMOTE_DIR} -name "*.pyc" -delete 2>/dev/null; echo cleaned')
        print(f'[clean] {out.strip()}')

        # 语法校验
        sftp_put_bytes(ssh, b'''
import ast, sys
for f in ("server.py", "kb_db.py"):
    try:
        ast.parse(open(f, encoding="utf-8").read())
        print(f, "OK")
    except SyntaxError as e:
        print(f, "FAIL", e); sys.exit(1)
''', '/tmp/_check_syntax.py')
        rc, out, err = run(ssh, f'cd {REMOTE_DIR} && python3 /tmp/_check_syntax.py')
        print(f'[syntax] rc={rc} {out.strip()} {err.strip()}')
        if rc != 0:
            raise SystemExit('syntax check failed, aborting restart')

        # 重启
        rc, out, err = run(ssh, 'systemctl restart yibiao-combined', timeout=30)
        print(f'[restart] rc={rc} {out.strip()} {err.strip()}')
        if rc != 0:
            raise SystemExit('restart failed')

        for i in range(10):
            time.sleep(1)
            rc, out, err = run(ssh, 'systemctl is-active yibiao-combined', timeout=5)
            if 'active' in out:
                print(f'[status] active (after {i+1}s)')
                break
        else:
            print('[status] WARN not active, check journalctl')

        rc, out, _ = run(ssh, 'curl -s -m 5 http://127.0.0.1:15004/api/health', timeout=10)
        print(f'[health] {out.strip()}')

        # 部署跨设备同步合并脚本 merge.py
        merge_local = pathlib.Path(MERGE_LOCAL)
        if merge_local.exists():
            run(ssh, f'mkdir -p {MERGE_REMOTE_DIR}')
            remote_merge = MERGE_REMOTE_PATH
            rc, out, _ = run(ssh, f'test -f {remote_merge} && echo OK || echo MISSING')
            if 'OK' in out:
                run(ssh, f'cp {remote_merge} {backup_dir}/merge.py.bak')
                print(f'[backup] {remote_merge} -> {backup_dir}/merge.py.bak')
            print(f'[upload] {merge_local} -> {remote_merge} ({merge_local.stat().st_size} bytes)')
            sftp.put(str(merge_local), remote_merge)
            sftp.chmod(remote_merge, 0o755)
            print(f'[merge] {remote_merge} deployed')
        else:
            print(f'[merge] skip: {merge_local} not found')

        print(f'[{datetime.datetime.now():%H:%M:%S}] deploy done.')
    finally:
        ssh.close()


if __name__ == '__main__':
    main()
