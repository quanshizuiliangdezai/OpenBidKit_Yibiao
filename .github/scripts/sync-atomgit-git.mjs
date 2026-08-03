import { spawn } from 'node:child_process';

const MAIN_BRANCH = 'main';
const RELEASE_TAG_PATTERN = 'v*';

/** 读取环境变量；为空时返回 null（允许优雅跳过）。 */
function readEnv(name) {
  const value = String(process.env[name] || '').trim();
  return value || null;
}

/** 执行 Git 命令并继承当前终端输出。 */
function runGit(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env,
      stdio: 'inherit',
      windowsHide: true,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

/** 将 GitHub 的 main 分支和版本标签单向同步到 AtomGit。 */
async function main() {
  const token = readEnv('ATOMGIT_ACCESS_TOKEN');
  const owner = readEnv('ATOMGIT_OWNER');
  const repo = readEnv('ATOMGIT_REPO');

  if (!token || !owner || !repo) {
    console.log('AtomGit 同步已跳过：未配置 ATOMGIT_ACCESS_TOKEN / ATOMGIT_OWNER / ATOMGIT_REPO。');
    console.log('如需启用同步，请在 GitHub 仓库设置中配置：');
    console.log('  - Secrets: ATOMGIT_ACCESS_TOKEN（AtomGit 个人访问令牌）');
    console.log('  - Variables: ATOMGIT_OWNER（AtomGit 用户名/组织名）');
    console.log('  - Variables: ATOMGIT_REPO（AtomGit 仓库名）');
    return;
  }

  const remoteUrl = `https://atomgit.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;

  await runGit([
    'fetch',
    '--force',
    '--prune',
    'origin',
    `+refs/heads/${MAIN_BRANCH}:refs/remotes/origin/${MAIN_BRANCH}`,
    `+refs/tags/${RELEASE_TAG_PATTERN}:refs/tags/${RELEASE_TAG_PATTERN}`,
  ]);

  const authorization = Buffer.from(`${owner}:${token}`, 'utf8').toString('base64');
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
    GIT_TERMINAL_PROMPT: '0',
  };

  // 仅推送 main 分支 + 最新 10 个发布标签（避免 292 个历史标签全量冷推过慢）。
  // 首次冷推后，后续均为增量推送，速度很快。
  const MAX_TAGS = 10;
  const refspecs = [`refs/remotes/origin/${MAIN_BRANCH}:refs/heads/${MAIN_BRANCH}`];
  try {
    const { execSync } = await import('node:child_process');
    const tagList = execSync(
      `git tag --list '${RELEASE_TAG_PATTERN}' --sort=-creatordate`,
      { encoding: 'utf8' },
    ).split('\n').map((t) => t.trim()).filter(Boolean);
    for (const t of tagList.slice(0, MAX_TAGS)) {
      refspecs.push(`refs/tags/${t}:refs/tags/${t}`);
    }
    console.log(`AtomGit 同步将推送 ${tagList.length} 个标签中的最新 ${Math.min(MAX_TAGS, tagList.length)} 个。`);
  } catch {
    // 取标签失败时退回到推送全部匹配标签，保证不丢数据
    refspecs.push(`refs/tags/${RELEASE_TAG_PATTERN}:refs/tags/${RELEASE_TAG_PATTERN}`);
    console.log('获取标签列表失败，回退为推送全部发布标签。');
  }

  await runGit([
    'push',
    '--force',
    remoteUrl,
    ...refspecs,
  ], gitEnv);

  console.log(`AtomGit code synchronized: ${owner}/${repo} (${MAIN_BRANCH}, ${RELEASE_TAG_PATTERN}).`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
