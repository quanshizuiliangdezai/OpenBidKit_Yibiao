// 通用目录合规审核模块（outlineComplianceAudit）
// ---------------------------------------------------------------------------
// 设计原则（务必遵守）：本模块不写死任何章节名词、不假设任何标的的固定格式。
// 判断目录是否合规的唯一事实来源是“招标文件提取出的评分项清单(groups)”，
// 该清单随每个项目不同而变化。下一个标的的文字、结构、章节命名都会不同，
// 因此所有判定都由模型基于传入的 groups + requirements 自主完成。
//
// 审核内容：
//   A. 越界(orphan)：目录项实际属于另一个评分大类，或在本项目评分清单里找不到任何来源
//      —— 自动从目录中删除。
//   B. 错位(misplaced)：内容应该存在但挂错了父章节 —— 仅标记，不删除。
//   C. 不确定(uncertain)：无法判断 —— 保守起见不删除，仅标记。
//   D. 遗漏(missing)：评分清单中的大类/细项在目录中完全找不到对应章节 —— 提示，不自动生成。
//
// 暴露：runOutlineComplianceAudit / buildComplianceAuditMessages（便于单测）。

const AUDIT_PROGRESS = Object.freeze({
  start: 76,
  activity: 79,
  end: 82,
});

// 把（可能已聚合的）groups 拍平为“评分项单元”列表，每项为 { requirement_id, title, description, detail_points }。
// 聚合后的 group 通过 items 携带原始各项；未聚合的 group 自身即一项。
function flattenRequirementGroups(groups) {
  const flat = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const items = Array.isArray(g.items) && g.items.length ? g.items : [g];
    for (const it of items) {
      const source = it && typeof it === 'object' ? it : g;
      const detailPoints = Array.isArray(source.detail_points)
        ? source.detail_points
        : (Array.isArray(g.detail_points) ? g.detail_points : []);
      flat.push({
        requirement_id: String(source.requirement_id || g.requirement_id || '').trim(),
        title: String(source.title || g.title || '').trim(),
        description: String(source.description || g.description || '').trim(),
        detail_points: detailPoints.map((point) => String(point)).filter(Boolean),
      });
    }
  }
  return flat;
}

function buildComplianceAuditMessages({ payload, outline, sourceGroups }) {
  const messages = [];
  messages.push({ role: 'user', content: `项目概述：\n${payload?.overview || ''}` });
  messages.push({
    role: 'user',
    content: `招标文件技术/商务评分要求（用于理解评分项背景与响应口径）：\n${payload?.requirements || ''}`,
  });
  messages.push({
    role: 'user',
    content: `招标文件评分项清单（判断目录合规性的唯一事实来源，来自本项目招标文件的评分办法）：\n${JSON.stringify(sourceGroups, null, 2)}`,
  });
  messages.push({
    role: 'user',
    content: `当前生成目录 JSON：\n${JSON.stringify(outline, null, 2)}`,
  });
  messages.push({
    role: 'user',
    content: `你是严谨的招投标技术方案目录合规审计专家。请对照上面三份材料完成目录合规审核。

【审核对象】
1) “招标文件评分项清单”：本项目从招标文件评分办法提取出的所有评分大类及其细项（detail_points），是判断目录是否合规的唯一事实来源。
2) “当前生成目录”：系统为本项目生成的响应文件目录（含一/二/三级）。

【逐条核对任务】
对目录中的每一个目录项，判断它能否追溯到某个评分大类或其细项：
- 可追溯(compliant)：该项内容明显对应某个评分大类/细项的响应要求（即清单里要求编写、提供或响应的内容）。
- 越界(orphan)：该项内容实际属于另一个评分大类（例如把“案例/业绩/证明材料”写进了“实施方案/技术方案”类章节），或在本项目评分清单里找不到任何对应来源。越界项应从当前章节删除，并放入 removeItemIds。
- 错位(misplaced)：该项应当存在，但挂错了父章节。不要删除，标记为 misplaced 并说明建议归属。
- 不确定(uncertain)：无法判断归属。保守起见不要删除，标记为 uncertain。

【遗漏检查】
逐条核对评分清单中的每个大类及其 detail_points，是否都能在目录中找到对应章节。对完全缺失的细项记入 missingRequirements（requirementId 填该大类 requirement_id，detailPoint 填缺失的细项文字）。

【重要约束】
- 严禁凭空套用任何通用目录模板或固定骨架；一切以本项目“招标文件评分项清单”的文字为准。
- 不要把评分清单本身改造成目录项，也不要因为遗漏就擅自编造内容。

【输出要求】
只返回一个 JSON 对象，不要输出任何解释文字。字段如下：
{
  "passed": true | false,
  "summary": "一句话中文总结",
  "removeItemIds": ["应被删除的目录项 id 列表（越界项）"],
  "missingRequirements": [ { "requirementId": "R9", "detailPoint": "缺失的细项文字", "note": "说明" } ],
  "itemVerdicts": [
    { "id": "目录项 id", "verdict": "compliant|orphan|misplaced|uncertain", "tracesTo": ["对应评分大类 requirement_id"], "reason": "简短中文说明" }
  ]
}
passed 为 true 当且仅当 removeItemIds 为空且没有明显错位/遗漏。`,
  });
  return messages;
}

function normalizeComplianceAuditResponse(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const removeItemIds = Array.isArray(obj.removeItemIds)
    ? obj.removeItemIds.map((id) => String(id)).filter(Boolean)
    : [];
  const missingRequirements = Array.isArray(obj.missingRequirements)
    ? obj.missingRequirements.map((m) => ({
      requirementId: String(m?.requirementId || m?.requirement_id || '').trim(),
      detailPoint: String(m?.detailPoint || m?.detail_point || '').trim(),
      note: String(m?.note || '').trim(),
    }))
    : [];
  const allowedVerdicts = ['compliant', 'orphan', 'misplaced', 'uncertain'];
  const itemVerdicts = Array.isArray(obj.itemVerdicts)
    ? obj.itemVerdicts.map((v) => ({
      id: String(v?.id || '').trim(),
      verdict: allowedVerdicts.includes(v?.verdict) ? v.verdict : 'uncertain',
      tracesTo: Array.isArray(v?.tracesTo) ? v.tracesTo.map((id) => String(id)).filter(Boolean) : [],
      reason: String(v?.reason || '').trim(),
    }))
    : [];
  return {
    passed: Boolean(obj.passed),
    summary: String(obj.summary || '').trim(),
    removeItemIds,
    missingRequirements,
    itemVerdicts,
  };
}

function validateComplianceAuditResponse(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('目录合规审核结果格式无效');
  }
  if (!Array.isArray(value.removeItemIds)) {
    throw new Error('目录合规审核结果的 removeItemIds 字段格式无效');
  }
  if (!Array.isArray(value.itemVerdicts)) {
    throw new Error('目录合规审核结果的 itemVerdicts 字段格式无效');
  }
  return value;
}

function buildComplianceAuditRepairMessages({ invalidContent, issues, progressLabel }) {
  return [
    {
      role: 'user',
      content: `你刚才返回的目录合规审核结果无法解析：${issues || '格式错误'}。\n\n原始内容：\n${invalidContent}\n\n请严格只返回一个 JSON 对象，包含字段 passed(boolean)、summary(string)、removeItemIds(string[])、missingRequirements(array)、itemVerdicts(array)。不要输出任何解释文字。`,
    },
  ];
}

async function collectJson(aiService, options) {
  if (aiService && typeof aiService.collectJsonResponse === 'function') {
    return aiService.collectJsonResponse(options);
  }
  if (aiService && typeof aiService.requestJson === 'function') {
    return aiService.requestJson(options);
  }
  throw new Error('aiService 未提供 collectJsonResponse / requestJson 方法');
}

function pruneOutlineItemsById(outline, idsToRemove) {
  const idSet = idsToRemove instanceof Set ? idsToRemove : new Set(idsToRemove);
  const pruneList = (items) => {
    const kept = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (idSet.has(String(item.id))) {
        continue; // 删除该节点及其整棵子树
      }
      const children = item.children && item.children.length
        ? pruneList(item.children)
        : item.children;
      kept.push({ ...item, children });
    }
    return kept;
  };
  return { ...outline, outline: pruneList(outline.outline) };
}

function renumberItems(items, parentPrefix = '') {
  return (items || []).map((item, index) => {
    const id = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
    const children = item.children && item.children.length
      ? renumberItems(item.children, id)
      : (item.children || undefined);
    return { ...item, id, children };
  });
}

function renumberOutlineItems(outline) {
  return { ...outline, outline: renumberItems(outline.outline) };
}

// 主入口：对照招标文件评分项审核目录并自动删除越界项。
// 返回 { outline, auditReport, removedCount }。
async function runOutlineComplianceAudit({ aiService, payload, outline, groups, log }) {
  if (!outline || !Array.isArray(outline.outline) || !outline.outline.length) {
    throw new Error('合规审核缺少目录数据');
  }
  const sourceGroups = flattenRequirementGroups(groups);
  log('开始对照招标文件评分项逐条审核目录合规性与越界情况。', AUDIT_PROGRESS.start);

  let response;
  try {
    response = await collectJson(aiService, {
      messages: buildComplianceAuditMessages({ payload, outline, sourceGroups }),
      normalizer: normalizeComplianceAuditResponse,
      validator: validateComplianceAuditResponse,
      repairMessagesBuilder: buildComplianceAuditRepairMessages,
      progressCallback: (message) => log(message, AUDIT_PROGRESS.activity),
      progressLabel: '目录合规审核',
      failureMessage: '模型返回的目录合规审核结果格式无效',
    });
  } catch (error) {
    log(`目录合规审核调用失败：${error && error.message ? error.message : String(error)}`, AUDIT_PROGRESS.end);
    throw error;
  }

  const removeIds = new Set(response.removeItemIds.filter(Boolean));
  const verdictMap = new Map();
  for (const v of response.itemVerdicts) {
    if (v.id) verdictMap.set(v.id, v);
  }

  let prunedOutline = outline;
  if (removeIds.size) {
    prunedOutline = pruneOutlineItemsById(outline, removeIds);
    prunedOutline = renumberOutlineItems(prunedOutline);
  }

  const compliantCount = response.itemVerdicts.filter((v) => v.verdict === 'compliant').length;
  const orphanCount = response.itemVerdicts.filter((v) => v.verdict === 'orphan').length;
  const misplacedCount = response.itemVerdicts.filter((v) => v.verdict === 'misplaced').length;
  log(
    `目录合规审核完成：${response.summary || ''} 通过项 ${compliantCount}，越界删除 ${removeIds.size}，错位 ${misplacedCount}，漏项 ${response.missingRequirements.length}。`,
    AUDIT_PROGRESS.end,
  );
  for (const id of removeIds) {
    const v = verdictMap.get(id);
    log(`已删除越界目录项：${id}（${v && v.reason ? v.reason : '不在招标文件评分项范围内'}）`, AUDIT_PROGRESS.end);
  }
  for (const m of response.missingRequirements) {
    log(`提示：评分项 ${m.requirementId || '-'} 的「${m.detailPoint || ''}」在目录中未见对应章节。${m.note || ''}`, AUDIT_PROGRESS.end);
  }

  return { outline: prunedOutline, auditReport: response, removedCount: removeIds.size };
}

module.exports = {
  runOutlineComplianceAudit,
  buildComplianceAuditMessages,
  flattenRequirementGroups,
};
