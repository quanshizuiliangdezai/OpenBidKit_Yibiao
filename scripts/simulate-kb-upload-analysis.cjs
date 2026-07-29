/**
 * 知识库「团队库上传后卡在『等待处理』」回归模拟
 * --------------------------------------------------------------
 * 复现 v0.1.202607290902 (commit 9a15610) 引入的显示层 bug：
 *   loadTeamTree / handleSearch 的水合条件从
 *     if (!localStatus && kbTab === 'team')
 *   被放大为
 *     if (kbTab === 'team' && (!localStatus || localStatus.status !== 'success'))
 *   导致任何「非 success」的本地状态（copying/extracting/matching/error…）都会被
 *   hydrateTeamAnalysis 覆盖回 pending —— 服务器尚无共享分析时返回 null，于是界面
 *   永远显示「等待处理」，实际分析在主进程正常进行。
 *
 * 本脚本不依赖 Electron / better-sqlite3，纯逻辑复现并断言修复前后行为。
 */

// ---- 复现两套显示决策逻辑（与 KnowledgeBasePage.tsx 中 loadTeamTree / handleSearch 一致）----

// BUGGY: 只要本地状态不是 success 就水合（9a15610）
function resolveBuggy(localStatus, serverHasAnalysis) {
  const kbTab = 'team';
  let ls = localStatus;
  if (kbTab === 'team' && (!ls || ls.status !== 'success')) {
    ls = serverHasAnalysis ? { status: 'success' } : null;
  }
  return ls?.status || 'pending';
}

// FIXED: 仅本机无记录或本地仍是初始 pending 才水合（本次修复）
function resolveFixed(localStatus, serverHasAnalysis) {
  const kbTab = 'team';
  let ls = localStatus;
  if (kbTab === 'team' && (!ls || ls.status === 'pending')) {
    ls = serverHasAnalysis ? { status: 'success' } : null;
  }
  return ls?.status || 'pending';
}

const statusLabel = {
  pending: '等待处理', copying: '复制文件', converting: '转换 Markdown',
  extracting: '提取条目', ready_for_matching: '待匹配', matching: '匹配段落',
  recovering: '补漏中', saving: '保存结果', success: '已完成', error: '失败',
};

// 主进程分析管道实际会依次产出的状态序列（analyzeExternalFile → prepareDocument → matchDocument → saveAnalysis）
const pipelineSequence = [
  'pending', 'copying', 'converting', 'extracting', 'ready_for_matching',
  'matching', 'recovering', 'saving', 'success',
];

const assert = (cond, msg) => {
  if (!cond) {
    console.error('  ✗ 断言失败:', msg);
    process.exitCode = 1;
    return false;
  }
  console.log('  ✓', msg);
  return true;
};

console.log('========================================================');
console.log(' 场景一：团队库上传后，主进程分析进行中（服务器尚无共享分析）');
console.log('========================================================');
console.log(' 主进程真实状态 ->  [BUGY 显示]   /  [FIXED 显示]');
let buggyAllPending = true;
let fixedShowsProgress = true;
for (const real of pipelineSequence) {
  const buggy = resolveBuggy({ status: real }, false);
  const fixed = resolveFixed({ status: real }, false);
  if (real !== 'success' && buggy !== 'pending') buggyAllPending = false;
  if (real !== 'success' && fixed !== real) fixedShowsProgress = false;
  console.log(
    `   ${real.padEnd(18)} ->  [${statusLabel[buggy].padEnd(4)}]   /  [${statusLabel[fixed].padEnd(4)}]`,
  );
}
assert(buggyAllPending, 'BUGGY: 分析过程中界面始终显示「等待处理」（即 bug 复现）');
assert(fixedShowsProgress, 'FIXED: 界面如实展示 copying→…→saving 的实时进度');

console.log('');
console.log('========================================================');
console.log(' 场景二：分析中途出错（如 AI 解析失败）');
console.log('========================================================');
{
  const buggy = resolveBuggy({ status: 'error' }, false);
  const fixed = resolveFixed({ status: 'error' }, false);
  console.log(`   本地 error ->  [BUGY ${statusLabel[buggy]}]  /  [FIXED ${statusLabel[fixed]}]`);
  assert(buggy === 'pending', 'BUGGY: 错误被掩盖成「等待处理」，用户无从排查');
  assert(fixed === 'error', 'FIXED: 错误状态可见，用户能看到真实失败原因');
}

console.log('');
console.log('========================================================');
console.log(' 场景三：团队成员 B 打开 A 已分析并回写服务器的文档（共享分析）');
console.log('========================================================');
{
  const buggy = resolveBuggy(null, true); // B 本机无记录，服务器有分析
  const fixed = resolveFixed(null, true);
  console.log(`   本机无记录+服务器有分析 ->  [BUGY ${statusLabel[buggy]}]  /  [FIXED ${statusLabel[fixed]}]`);
  assert(buggy === 'success' && fixed === 'success', '两种逻辑下共享分析均可被正确水合为「已完成」');
}
{
  const buggy = resolveBuggy(null, false); // B 本机无记录，服务器也还没有分析
  const fixed = resolveFixed(null, false);
  console.log(`   本机无记录+服务器无分析 ->  [BUGY ${statusLabel[buggy]}]  /  [FIXED ${statusLabel[fixed]}]`);
  assert(buggy === 'pending' && fixed === 'pending', '两种逻辑下「真正未分析」的文档均显示「等待处理」（正确）');
}

console.log('');
console.log('========================================================');
console.log(' 场景四：陈旧空记录（本地 pending，但服务器已有共享分析）');
console.log('========================================================');
{
  const buggy = resolveBuggy({ status: 'pending' }, true);
  const fixed = resolveFixed({ status: 'pending' }, true);
  console.log(`   本地 pending+服务器有分析 ->  [BUGY ${statusLabel[buggy]}]  /  [FIXED ${statusLabel[fixed]}]`);
  assert(buggy === 'success' && fixed === 'success', 'FIXED 仍保留 9a15610 的初衷：陈旧 pending 可被服务器共享分析水合');
}

console.log('');
if (process.exitCode === 1) {
  console.error('❌ 模拟测试存在失败断言，请检查修复逻辑。');
} else {
  console.log('✅ 全部断言通过：修复后团队库上传会如实显示分析进度，不再卡在「等待处理」，且共享分析水合不受影响。');
}
console.log('========================================================');
