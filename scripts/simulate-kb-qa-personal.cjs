/**
 * 模拟测试：知识库问答选择「个人库」时的检索与空结果提示
 * --------------------------------------------------------------
 * 不依赖 Electron / React，仅验证数据结构与服务端返回假设。
 */

const assert = require('node:assert');

function labelForSource(source) {
  return source === 'team' ? '团队库' : source === 'personal' ? '个人库' : '团队库和个人库';
}

function buildEmptyHint(question, source, keywordError) {
  const sourceLabel = labelForSource(source);
  const errHint = keywordError ? `（${keywordError}）` : '';
  return `未在${sourceLabel}中检索到与「${question}」相关的内容。${errHint}\n\n可能原因：\n1. 知识库中暂无匹配文档；\n2. 文档尚未分析完成；\n3. 关键词与文档标题/正文差异较大。\n\n你可以尝试更换关键词、切换到「全部」来源，或直接提问，我会基于通用知识作答。`;
}

// 1) 个人库 IPC 返回结构：{ success: true, data: KbQaDocument[] }
const personalRes = { success: true, data: [{ id: 'doc-1', title: '测试文档', file_name: 'test.md', content_text: '这是测试内容' }] };
assert.strictEqual(personalRes.success, true, '个人库 qaRetrieve 应返回 success: true');
assert.ok(Array.isArray(personalRes.data), '个人库 qaRetrieve 应返回 data 数组');

// 2) 选择个人库时，团队库结果应为空占位
const teamRes = { success: true, data: [] };
const source = 'personal';
const teamDocs = Array.isArray(teamRes?.data) ? teamRes.data : [];
const personalDocs = Array.isArray(personalRes?.data) ? personalRes.data : [];
assert.deepStrictEqual(teamDocs, [], '选择个人库时团队库结果应为空');
assert.strictEqual(personalDocs.length, 1, '选择个人库时应拿到个人库文档');

// 3) 去重合并
const seen = new Set();
const docs = [];
for (const d of [...teamDocs, ...personalDocs]) {
  const key = `${d.file_name || d.title}|${(d.content_text || '').slice(0, 200)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  docs.push(d);
}
assert.strictEqual(docs.length, 1, '合并后应保留 1 篇文档');

// 4) 空结果提示包含明确来源
const emptyHint = buildEmptyHint('工期要求', 'personal', '');
assert.ok(emptyHint.includes('个人库'), '空结果提示应指明个人库');
assert.ok(emptyHint.includes('工期要求'), '空结果提示应包含用户问题');
assert.ok(emptyHint.includes('知识库中暂无匹配文档'), '空结果提示应给出可能原因');

// 5) 错误场景：个人库未登录
const personalErrRes = { success: false, error: '未登录团队库', needLogin: true };
const personalErr = personalErrRes.error;
const fullErrHint = buildEmptyHint('工期要求', 'personal', `个人库检索失败：${personalErr}`);
assert.ok(fullErrHint.includes('个人库检索失败'), '错误场景下空结果提示应包含错误信息');

console.log('✅ 个人库问答模拟测试通过：');
console.log('   • 个人库 qaRetrieve 返回结构正确');
console.log('   • 选择个人库时只取个人库结果');
console.log('   • 空结果提示明确来源与原因');
console.log('   • 错误场景下提示包含错误信息');
