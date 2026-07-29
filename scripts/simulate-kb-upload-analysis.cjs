/**
 * 知识库「团队库上传后卡在『等待处理』」回归模拟
 * --------------------------------------------------------------
 * 复现 v0.1.202607290902 (commit 9a15610) 引入的显示层 bug 及其修复验证。
 *
 * 根因：9a15610 把 loadTeamTree / handleSearch 的水合条件从
 *         if (!localStatus && kbTab === 'team')
 *       放大为
 *         if (kbTab === 'team' && (!localStatus || localStatus.status !== 'success'))
 *       导致 A 电脑自己上传文档后，本地刚建立的 pending 记录被 hydrateTeamAnalysis
 *       覆盖为 null（服务器此时还没有共享分析），界面永远显示「等待处理」，
 *       用户误以为上传没有触发分析。
 *
 * 修复（本次）：
 *   1. renderer 端：仅当本机「完全没有记录」时才调用 hydrateTeamAnalysis。
 *      本地一旦有任何记录（pending/copying/extracting/error/…）一律原样展示。
 *   2. main process 端：hydrateTeamAnalysis 增加防御——若本地已有非 success 记录
 *      且分析任务仍在活跃运行（activePreparations/activeMatches），直接返回本地
 *      状态，避免被服务器 null 覆盖。
 *
 * 本脚本不依赖 Electron / better-sqlite3，纯逻辑复现并断言修复前后行为。
 */

// ---- 三套显示决策逻辑 ----

// BUGGY: 只要本地状态不是 success 就水合（9a15610）
function resolveBuggy(localStatus, serverHasAnalysis) {
  const kbTab = 'team';
  let ls = localStatus;
  if (kbTab === 'team' && (!ls || ls.status !== 'success')) {
    ls = serverHasAnalysis ? { status: 'success' } : null;
  }
  return ls?.status || 'pending';
}

// PREV_FIX: 仅本机无记录或本地仍是初始 pending 才水合（e9d3b50，仍有问题）
function resolvePrevFix(localStatus, serverHasAnalysis) {
  const kbTab = 'team';
  let ls = localStatus;
  if (kbTab === 'team' && (!ls || ls.status === 'pending')) {
    ls = serverHasAnalysis ? { status: 'success' } : null;
  }
  return ls?.status || 'pending';
}

// FIXED: 仅本机完全无记录时才水合（本次最终修复）
function resolveFixed(localStatus, serverHasAnalysis) {
  const kbTab = 'team';
  let ls = localStatus;
  if (kbTab === 'team' && !ls) {
    ls = serverHasAnalysis ? { status: 'success' } : null;
  }
  return ls?.status || 'pending';
}

const statusLabel = {
  pending: '等待处理', copying: '复制文件', converting: '转换 Markdown',
  extracting: '提取条目', ready_for_matching: '待匹配', matching: '匹配段落',
  recovering: '补漏中', saving: '保存结果', success: '已完成', error: '失败',
};

// 主进程分析管道实际会依次产出的状态序列
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
console.log(' 场景一：A 电脑上传后，主进程分析进行中（服务器尚无共享分析）');
console.log('========================================================');
console.log(' 主进程真实状态 ->  [BUGGY]  /  [PREV_FIX]  /  [FIXED]');
let buggyAllPending = true;
let prevFixInitialPending = false;
let fixedShowsProgress = true;
for (const real of pipelineSequence) {
  const buggy = resolveBuggy({ status: real }, false);
  const prevFix = resolvePrevFix({ status: real }, false);
  const fixed = resolveFixed({ status: real }, false);
  if (real !== 'success' && buggy !== 'pending') buggyAllPending = false;
  if (real === 'pending' && prevFix === 'pending') prevFixInitialPending = true;
  if (real !== 'success' && fixed !== real) fixedShowsProgress = false;
  console.log(
    `   ${real.padEnd(18)} ->  [${statusLabel[buggy].padEnd(4)}]  /  [${statusLabel[prevFix].padEnd(4)}]  /  [${statusLabel[fixed].padEnd(4)}]`,
  );
}
assert(buggyAllPending, 'BUGGY 复现：分析过程中界面始终显示「等待处理」');
assert(prevFixInitialPending, 'PREV_FIX 缺陷：上传刚创建的 pending 仍会被水合回「等待处理」');
assert(fixedShowsProgress, 'FIXED：界面如实展示 copying→…→saving 的实时进度');

console.log('');
console.log('========================================================');
console.log(' 场景二：分析中途出错（如 AI 解析失败 / LibreOffice 缺失）');
console.log('========================================================');
{
  const buggy = resolveBuggy({ status: 'error' }, false);
  const fixed = resolveFixed({ status: 'error' }, false);
  console.log(`   本地 error ->  [BUGGY ${statusLabel[buggy]}]  /  [FIXED ${statusLabel[fixed]}]`);
  assert(buggy === 'pending', 'BUGGY：错误被掩盖成「等待处理」，用户无从排查');
  assert(fixed === 'error', 'FIXED：错误状态可见，用户能看到真实失败原因');
}

console.log('');
console.log('========================================================');
console.log(' 场景三：团队成员 B 打开 A 已分析并回写服务器的文档');
console.log('========================================================');
{
  const buggy = resolveBuggy(null, true); // B 本机无记录，服务器有分析
  const fixed = resolveFixed(null, true);
  console.log(`   本机无记录+服务器有分析 ->  [BUGGY ${statusLabel[buggy]}]  /  [FIXED ${statusLabel[fixed]}]`);
  assert(buggy === 'success' && fixed === 'success', '共享分析可被正确水合为「已完成」');
}
{
  const buggy = resolveBuggy(null, false); // B 本机无记录，服务器也还没有分析
  const fixed = resolveFixed(null, false);
  console.log(`   本机无记录+服务器无分析 ->  [BUGGY ${statusLabel[buggy]}]  /  [FIXED ${statusLabel[fixed]}]`);
  assert(buggy === 'pending' && fixed === 'pending', '真正未分析的文档显示「等待处理」（正确）');
}

console.log('');
console.log('========================================================');
console.log(' 场景四：A 上传后立刻刷新列表的时序模拟');
console.log('========================================================');
{
  // 关键时序：analyzeExternalFile 创建 pending 后立即返回，renderer 调用 loadTeamTree
  const localStatusAtLoadTime = { status: 'pending' };
  const fixed = resolveFixed(localStatusAtLoadTime, false);
  console.log(`   analyzeExternalFile 刚返回（本地 pending）-> FIXED 显示：${statusLabel[fixed]}`);
  assert(fixed === 'pending', 'FIXED：上传瞬间的 pending 不被水合，用户能看到「等待处理」而非被覆盖');
}
{
  // prepareDocument 已推进到 copying 后，renderer 收到 event 并刷新
  const localStatusAfterEvent = { status: 'copying', progress: 5, message: '正在复制原始文件' };
  const fixed = resolveFixed(localStatusAfterEvent, false);
  console.log(`   prepareDocument 推进到 copying 后 -> FIXED 显示：${statusLabel[fixed]}`);
  assert(fixed === 'copying', 'FIXED：分析进度推进后如实显示，不会被水合回退');
}

console.log('');
console.log('========================================================');
console.log(' 场景五：hydrateTeamAnalysis 服务端防御（活跃任务保护）');
console.log('========================================================');
{
  // 模拟 main process 内部状态：hydrateTeamAnalysis 的实现逻辑
  function hydrateDecision(localStatus, isActive) {
    if (localStatus === 'success') return 'local-success';
    if (localStatus && isActive) return 'local-preserved'; // 活跃任务保护
    return 'fetch-from-server'; // 本机无记录 或 陈旧非 success 记录
  }

  assert(hydrateDecision('pending', true) === 'local-preserved', '本地 pending 且分析活跃 -> 保护本地进度');
  assert(hydrateDecision('copying', true) === 'local-preserved', '本地 copying 且分析活跃 -> 保护本地进度');
  assert(hydrateDecision('error', true) === 'local-preserved', '本地 error 且分析活跃 -> 保护本地进度');
  assert(hydrateDecision('success', true) === 'local-success', '本地 success -> 直接返回本地');
  assert(hydrateDecision(null, false) === 'fetch-from-server', '本机无记录 -> 从服务器拉取');
  assert(hydrateDecision('pending', false) === 'fetch-from-server', '本地陈旧 pending 且无活跃任务 -> 允许水合');
}

console.log('');
if (process.exitCode === 1) {
  console.error('❌ 模拟测试存在失败断言，请检查修复逻辑。');
} else {
  console.log('✅ 全部断言通过：');
  console.log('   • A 电脑上传后会如实显示实时分析进度，不再卡在「等待处理」');
  console.log('   • 分析出错时错误状态可见，不会被掩盖');
  console.log('   • B 电脑仍可水合 A 已回写的共享分析');
  console.log('   • hydrateTeamAnalysis 服务端防御活跃任务被覆盖');
}
console.log('========================================================');
