#!/usr/bin/env python3
# 部署 sub2api-image-proxy 到服务器
#
# 用法：
#   1) 复制 env 模板并填值：  cp env.example .env
#   2) 加载环境变量后运行：    python3 scripts/deploy_image_proxy.py
#
# 注意：本脚本不硬编码密码，全部从环境变量读取。
import paramiko
import sys
import os
import time
import datetime
import pathlib

HOST = os.environ.get('KB_DEPLOY_HOST', '59.49.48.147')
PORT = int(os.environ.get('KB_DEPLOY_PORT', '5566'))
USER = os.environ.get('KB_DEPLOY_USER', 'root')
PASSWORD = os.environ.get('KB_DEPLOY_SSH_PASSWORD')
if not PASSWORD:
    sys.exit('缺少环境变量 KB_DEPLOY_SSH_PASSWORD，请先配置 .env 或从环境变量注入')

LOCAL_PROXY = os.environ.get(
    'KB_DEPLOY_PROXY_LOCAL',
    r'C:\Users\13370\Desktop\Workspace\OpenBidKit_Yibiao\deploy\scripts\sub2api-image-proxy.py',
)
REMOTE_PROXY_DIR = os.environ.get('KB_DEPLOY_PROXY_REMOTE_DIR', '/opt/sub2api-image-proxy')
REMOTE_PROXY_PATH = os.environ.get('KB_DEPLOY_PROXY_REMOTE_PATH', f'{REMOTE_PROXY_DIR}/proxy.py')


def run(ssh, cmd, timeout=60):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    rc = stdout.channel.recv_exit_status()
    return rc, out, err


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
        local_path = pathlib.Path(LOCAL_PROXY)
        if not local_path.exists():
            print(f'[skip] {local_path} not found')
            return

        sftp = ssh.open_sftp()
        run(ssh, f'mkdir -p {REMOTE_PROXY_DIR}')

        # 备份
        ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        backup_dir = f'/tmp/image-proxy-backup-{ts}'
        run(ssh, f'mkdir -p {backup_dir}')
        rc, out, _ = run(ssh, f'test -f {REMOTE_PROXY_PATH} && echo OK || echo MISSING')
        if 'OK' in out:
            run(ssh, f'cp {REMOTE_PROXY_PATH} {backup_dir}/proxy.py.bak')
            print(f'[backup] {REMOTE_PROXY_PATH} -> {backup_dir}/proxy.py.bak')

        print(f'[upload] {local_path} -> {REMOTE_PROXY_PATH} ({local_path.stat().st_size} bytes)')
        sftp.put(str(local_path), REMOTE_PROXY_PATH)
        sftp.chmod(REMOTE_PROXY_PATH, 0o755)

        # 语法校验
        rc, out, err = run(ssh, f'python3 -m py_compile {REMOTE_PROXY_PATH}')
        print(f'[syntax] rc={rc} {out.strip()} {err.strip()}')
        if rc != 0:
            raise SystemExit('syntax check failed, aborting restart')

        # 重启
        rc, out, err = run(ssh, 'systemctl restart sub2api-image-proxy', timeout=30)
        print(f'[restart] rc={rc} {out.strip()} {err.strip()}')
        if rc != 0:
            raise SystemExit('restart failed')

        for i in range(10):
            time.sleep(1)
            rc, out, err = run(ssh, 'systemctl is-active sub2api-image-proxy', timeout=5)
            if 'active' in out:
                print(f'[status] active (after {i+1}s)')
                break
        else:
            print('[status] WARN not active, check journalctl')

        rc, out, _ = run(ssh, 'curl -s -m 5 http://127.0.0.1:18080/v1/models', timeout=10)
        print(f'[health] {out.strip()[:200]}')

        print(f'[{datetime.datetime.now():%H:%M:%S}] image proxy deploy done.')
    finally:
        ssh.close()


if __name__ == '__main__':
    main()
