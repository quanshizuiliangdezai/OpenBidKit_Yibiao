const crypto = require('node:crypto');
const { runBidSectionExtractionTask } = require('./bidSectionExtractionTask.cjs');
const { runBidAnalysisTask } = require('./bidAnalysisTask.cjs');
const { runContentGenerationTask } = require('./contentGenerationTask.cjs');
const { runGlobalFactsTask } = require('./globalFactsTask.cjs');
const { runOutlineGenerationTask, runOutlineWizardStep } = require('./outlineGenerationTask.cjs');
const { runRejectionCheckTask, runRejectionItemsExtractionTask } = require('./rejectionCheckTask.cjs');

// 仅 recover 需要的 OUTLINE_PROGRESS 子集（与 outlineGenerationTask.cjs 保持一致）。
// 必须与 outlineGenerationTask.cjs 中的 OUTLINE_PROGRESS 同步修改。
const OUTLINE_PROGRESS_VALUES = Object.freeze({
  mainComplete: 55,
  knowledgeEnhancementEnd: 65,
  finalReviewEnd: 75,
  complianceAuditEnd: 82,
  complete: 100,
});

const taskDefinitions = {
  'bid-section-extraction': {
    label: '多标段识别',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'bidSectionExtractionTask',
  },
  'bid-analysis': {
    label: '招标文件解析',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'bidAnalysisTask',
  },
  'outline-generation': {
    label: '目录生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'outlineGenerationTask',
  },
  'global-facts-generation': {
    label: '全局事实设定',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'globalFactsTask',
  },
  'content-generation': {
    label: '正文生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 5,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'contentGenerationTask',
  },
  'rejection-items-extraction': {
    label: '无效与废标项解析',
    group: 'rejection-check',
    groupLabel: '废标项检查',
    step: 1,
    lockPolicy: 'group-exclusive',
    stateKey: 'rejectionCheck',
    field: 'extractionTask',
  },
  'rejection-check-run': {
    label: '废标项检查',
    group: 'rejection-check',
    groupLabel: '废标项检查',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'rejectionCheck',
    field: 'checkTask',
  },
  'duplicate-analysis': {
    label: '标书查重分析',
    group: 'duplicate-check',
    groupLabel: '标书查重',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'duplicateCheck',
    field: 'analysisTask',
  },
};

function now() {
  return new Date().toISOString();
}

function getTaskDefinition(type) {
  return taskDefinitions[type] || { label: type, stateKey: 'technicalPlan', field: undefined, lockPolicy: 'none' };
}

function getScopeId(payload) {
  const scopeId = payload?.scopeId ?? payload?.scope_id;
  return scopeId === undefined || scopeId === null ? '' : String(scopeId);
}

function createDuplicateCheckPayloadSignature(payload = {}) {
  const tenderFiles = Array.isArray(payload.tenderFiles) ? payload.tenderFiles : [payload.tenderFile].filter(Boolean);
  const files = [...tenderFiles, ...(Array.isArray(payload.bidFiles) ? payload.bidFiles : [])]
    .filter(Boolean)
    .map((file) => `${file.file_path}|${file.size}|${file.modified_at}`);
  return crypto.createHash('sha1').update(files.join('\n')).digest('hex');
}

function getPayloadSignature(type, payload) {
  if (type === 'duplicate-analysis') {
    return createDuplicateCheckPayloadSignature(payload);
  }
  return undefined;
}

function isActiveTaskStatus(status) {
  return status === 'running' || status === 'pausing';
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function copyPatchFields(target, source, fields) {
  for (const field of fields) {
    if (hasOwn(source, field)) {
      target[field] = source[field];
    }
  }
}

// 提取技术方案流程中由用户选择或填写的任务参数，不包含生成结果和正文缓存。
function createTechnicalPlanUserSettings(state = {}) {
  const settings = {};
  copyPatchFields(settings, state, [
    'workflowKind',
    'step',
    'tenderFile',
    'tenderFiles',
    'originalPlanFile',
    'bidAnalysisMode',
    'bidAnalysisSelectedTaskIds',
    'bidSectionMode',
    'outlineMode',
    'outlineExpansionMode',
    'outlineWordControlOptions',
    'outlineWordControlSnapshot',
    'referenceKnowledgeDocumentIds',
    'contentGenerationOptions',
  ]);
  return settings;
}

const INTERRUPTED_SECTION_ERROR = '上次生成被中断，请继续生成。';

function clearOutlineContentByIds(items, interruptedIds) {
  if (!(interruptedIds instanceof Set) || !interruptedIds.size) {
    return items;
  }

  return (items || []).map((item) => {
    const nextItem = interruptedIds.has(item.id) ? { ...item, content: '' } : { ...item };
    if (item?.children?.length) {
      nextItem.children = clearOutlineContentByIds(item.children, interruptedIds);
    }
    return nextItem;
  });
}

function normalizeInterruptedContentSections(technicalPlan) {
  const sections = technicalPlan?.contentGenerationSections || {};
  const interruptedIds = new Set();
  const nextSections = { ...sections };

  for (const [itemId, section] of Object.entries(sections)) {
    if (section?.status !== 'running') {
      continue;
    }
    interruptedIds.add(itemId);
    // 单小节重新生成时异常退出可能丢失旧正文；场景极窄，恢复优先保证可继续重跑，不额外保存旧正文。
    nextSections[itemId] = {
      ...section,
      status: 'error',
      content: '',
      error: INTERRUPTED_SECTION_ERROR,
      updated_at: now(),
    };
  }

  if (!interruptedIds.size) {
    return { sections, outlineData: technicalPlan?.outlineData, interruptedIds };
  }

  const outlineData = technicalPlan?.outlineData?.outline
    ? {
      ...technicalPlan.outlineData,
      outline: clearOutlineContentByIds(technicalPlan.outlineData.outline, interruptedIds),
    }
    : technicalPlan?.outlineData;

  return { sections: nextSections, outlineData, interruptedIds };
}

function inferContentGenerationPhase(technicalPlan) {
  return technicalPlan?.contentGenerationTask?.stats?.content?.phase
    || technicalPlan?.contentGenerationRuntime?.phase
    || 'planning';
}

function createTask(type, payload) {
  const definition = getTaskDefinition(type);
  const scopeId = getScopeId(payload);
  const payloadSignature = getPayloadSignature(type, payload);
  return {
    task_id: crypto.randomUUID(),
    type,
    group: definition.group,
    step: definition.step,
    lock_policy: definition.lockPolicy,
    scope_id: scopeId || undefined,
    payload_signature: payloadSignature,
    status: 'running',
    progress: 0,
    logs: [],
    started_at: now(),
    updated_at: now(),
  };
}

function createTaskService({ aiService, agentService, technicalPlanStore, rejectionCheckStore, duplicateCheckStore, knowledgeBaseService, duplicateCheckService }) {
  const subscribers = new Set();
  const callbackSubscribers = new Set();
  const activeTasks = new Map();
  const activeTaskControls = new Map();

  function emit(task, snapshot) {
    const event = { task, ...snapshot };
    for (const webContents of subscribers) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', event);
      }
    }
    for (const callback of callbackSubscribers) {
      callback(event);
    }
  }

  function buildTechnicalPlanSnapshot(task, state = {}, eventPatch = {}) {
    const patch = { ...(eventPatch.technicalPlanPatch || {}) };
    const taskField = getTaskField(task.type);
    if (taskField) {
      patch[taskField] = state?.[taskField] || task;
    }

    if (task.type === 'bid-analysis') {
      copyPatchFields(patch, state, ['bidAnalysisMode', 'bidAnalysisProgress', 'projectOverview', 'techRequirements', 'bidAnalysisTasks']);
      if (state.outlineData === null) {
        copyPatchFields(patch, state, [
          'outlineData',
          'outlineWordControlSnapshot',
          'outlineGenerationTask',
          'globalFactsTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationOptions',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'bid-section-extraction') {
      copyPatchFields(patch, state, [
        'bidSectionMode',
        'bidSections',
        'bidSectionExtractionStatus',
        'bidSectionExtractionError',
        'tenderFile',
        'bidAnalysisTask',
        'bidAnalysisTasks',
        'bidAnalysisProgress',
        'projectOverview',
        'techRequirements',
        'outlineData',
        'outlineWordControlSnapshot',
        'outlineGenerationTask',
        'referenceKnowledgeDocumentIds',
        'globalFactsTask',
        'globalFacts',
        'contentGenerationTask',
        'contentGenerationOptions',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentIllustrationPlan',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'outline-generation') {
      copyPatchFields(patch, state, [
        'outlineMode',
        'outlineExpansionMode',
        'outlineWordControlOptions',
        'outlineWordControlSnapshot',
        'referenceKnowledgeDocumentIds',
        'outlineWizard',
      ]);
      if (task.status === 'success' || state.outlineData === null || hasOwn(eventPatch, 'outlineData')) {
        copyPatchFields(patch, state, [
          'outlineData',
          'globalFactsTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'global-facts-generation') {
      copyPatchFields(patch, state, ['globalFacts']);
      if (!isActiveTaskStatus(task.status)) {
        copyPatchFields(patch, state, [
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'content-generation') {
      copyPatchFields(patch, state, ['outlineWordControlSnapshot', 'contentIllustrationPlan', 'contentGenerationRuntime']);
      if (!isActiveTaskStatus(task.status)) {
        copyPatchFields(patch, state, [
          'outlineData',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentIllustrationPlan',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (hasOwn(eventPatch, 'outlineData')) {
      patch.outlineData = eventPatch.outlineData;
    }
    if (hasOwn(eventPatch, 'contentRuntime')) {
      patch.contentGenerationRuntime = eventPatch.contentRuntime;
    }

    const event = { technicalPlanPatch: patch };
    if (hasOwn(eventPatch, 'bidItem')) event.bidItem = eventPatch.bidItem;
    if (hasOwn(eventPatch, 'outlineData')) event.outlineData = eventPatch.outlineData;
    if (hasOwn(eventPatch, 'contentSection')) event.contentSection = eventPatch.contentSection;
    if (hasOwn(eventPatch, 'contentPlan')) event.contentPlan = eventPatch.contentPlan;
    if (hasOwn(eventPatch, 'contentRuntime')) event.contentRuntime = eventPatch.contentRuntime;
    return event;
  }

  function buildSnapshot(definition, state, task, eventPatch) {
    if (definition.stateKey === 'technicalPlan') {
      return buildTechnicalPlanSnapshot(task, state, eventPatch);
    }
    if (definition.stateKey === 'rejectionCheck') {
      return { rejectionCheck: state };
    }
    if (definition.stateKey === 'duplicateCheck') {
      return { duplicateCheck: state };
    }
    return {};
  }

  function getSnapshotForTask(task) {
    const definition = getTaskDefinition(task.type);
    if (definition.stateKey === 'technicalPlan') {
      return buildSnapshot(definition, technicalPlanStore.loadTechnicalPlan(), task);
    }
    if (definition.stateKey === 'rejectionCheck') {
      return { rejectionCheck: rejectionCheckStore.loadRejectionCheck() };
    }
    if (definition.stateKey === 'duplicateCheck') {
      return { duplicateCheck: duplicateCheckStore.loadDuplicateCheck() };
    }
    return {};
  }

  function subscribe(webContents) {
    subscribers.add(webContents);
    for (const task of activeTasks.values()) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', { task, ...getSnapshotForTask(task) });
      }
    }
    webContents.once('destroyed', () => subscribers.delete(webContents));
  }

  /**
   * 订阅 Main 进程中的任务事件，并返回取消订阅函数
   */
  function subscribeCallback(callback) {
    callbackSubscribers.add(callback);
    for (const task of activeTasks.values()) {
      callback({ task, ...getSnapshotForTask(task) });
    }
    return () => callbackSubscribers.delete(callback);
  }

  function getTaskField(type) {
    return getTaskDefinition(type).field;
  }

  function getActiveTaskConflict(type, payload) {
    const definition = getTaskDefinition(type);
    if (definition.lockPolicy === 'none' || !definition.group) {
      return null;
    }

    const nextScopeId = getScopeId(payload);
    for (const task of activeTasks.values()) {
      if (!isActiveTaskStatus(task.status) || task.type === type) {
        continue;
      }

      const activeDefinition = getTaskDefinition(task.type);
      if (activeDefinition.group !== definition.group) {
        continue;
      }

      if (definition.lockPolicy === 'group-exclusive' || activeDefinition.lockPolicy === 'group-exclusive') {
        return { task, definition: activeDefinition };
      }

      if (definition.lockPolicy === 'scope-exclusive' && nextScopeId && task.scope_id === nextScopeId) {
        return { task, definition: activeDefinition };
      }
    }

    return null;
  }

  function assertTaskCanStart(type, payload) {
    const conflict = getActiveTaskConflict(type, payload);
    if (!conflict) {
      const definition = getTaskDefinition(type);
      if (definition.group === 'technical-plan') {
        const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
        const pausedContentTask = technicalPlan.contentGenerationTask;
        if (pausedContentTask?.status === 'paused') {
          if (type === 'content-generation' && payload?.resume) {
            return;
          }
          throw new Error('正文生成已暂停，请先继续当前正文生成任务或重置技术方案后再启动新的任务。');
        }
      }
      return;
    }

    const definition = getTaskDefinition(type);
    throw new Error(`当前${definition.groupLabel || '任务组'}正在执行“${conflict.definition.label || conflict.task.type}”，请完成后再启动“${definition.label || type}”。`);
  }

  function updateWorkspaceState(definition, partial) {
    if (definition.stateKey === 'technicalPlan') {
      return technicalPlanStore.updateTechnicalPlan(partial);
    }
    if (definition.stateKey === 'rejectionCheck') {
      return rejectionCheckStore.updateRejectionCheck(partial);
    }
    if (definition.stateKey === 'duplicateCheck') {
      return duplicateCheckStore.updateDuplicateCheck(partial);
    }
    return technicalPlanStore.updateTechnicalPlan(partial);
  }

  function loadWorkspaceState(definition) {
    if (definition.stateKey === 'technicalPlan') {
      return technicalPlanStore.loadTechnicalPlan();
    }
    if (definition.stateKey === 'rejectionCheck') {
      return rejectionCheckStore.loadRejectionCheck();
    }
    if (definition.stateKey === 'duplicateCheck') {
      return duplicateCheckStore.loadDuplicateCheck();
    }
    return technicalPlanStore.loadTechnicalPlan();
  }

  // 在 Agent 失败时采集父任务及其前置步骤的用户参数快照。
  function createAgentUserTaskContext(type, definition, payload, currentTask) {
    const workspaceState = loadWorkspaceState(definition) || {};
    return {
      managed_task: {
        type,
        label: definition.label || type,
        group: definition.group || '',
        group_label: definition.groupLabel || '',
        step: definition.step,
        state_key: definition.stateKey || '',
        payload,
        state: currentTask,
      },
      workflow_settings: definition.stateKey === 'technicalPlan'
        ? createTechnicalPlanUserSettings(workspaceState)
        : {},
    };
  }

  function startManagedTask(type, payload, runner, initialPartial = {}) {
    const existingTask = activeTasks.get(type);
    if (existingTask && isActiveTaskStatus(existingTask.status)) {
      const nextPayloadSignature = getPayloadSignature(type, payload);
      if (existingTask.payload_signature && nextPayloadSignature && existingTask.payload_signature !== nextPayloadSignature) {
        const definition = getTaskDefinition(type);
        throw new Error(`当前${definition.groupLabel || '任务组'}正在执行“${definition.label || type}”，请等待当前任务完成后再重新分析新的文件集合。`);
      }
      emit(existingTask, getSnapshotForTask(existingTask));
      return existingTask;
    }

    assertTaskCanStart(type, payload);

    const definition = getTaskDefinition(type);
    const task = createTask(type, payload);
    const queueScopeId = `${type}:${task.task_id}`;
    activeTasks.set(type, task);
    const taskField = getTaskField(type);
    let currentTask = task;
    const taskControl = {
      queueScopeId,
      pauseRequested: false,
      isPauseRequested() {
        return this.pauseRequested;
      },
      requestPause() {
        this.pauseRequested = true;
        const pausedLogs = currentTask.logs?.length
          ? currentTask.logs
          : ['已请求暂停，正在等待当前 AI 请求完成。'];
        const pausingTask = updateTask({ status: 'pausing', pause_requested: true, logs: pausedLogs });
        const state = updateWorkspaceState(definition, { [taskField]: pausingTask });
        emit(pausingTask, buildSnapshot(definition, state, pausingTask));
        return pausingTask;
      },
    };
    activeTaskControls.set(type, taskControl);

    const updateTask = (partial, workspaceState, eventPatch, options = {}) => {
      const nextStatus = currentTask.status === 'pausing' && partial.status === 'running'
        ? 'pausing'
        : partial.status || currentTask.status;
      currentTask = {
        ...currentTask,
        ...partial,
        status: nextStatus,
        pause_requested: partial.pause_requested === false ? false : taskControl.pauseRequested || partial.pause_requested,
        logs: partial.logs ? partial.logs : currentTask.logs,
        updated_at: now(),
      };
      activeTasks.set(type, currentTask);
      if (workspaceState) {
        let persistedState = workspaceState;
        if (taskField) {
          if (options.skipWorkspaceReload && definition.stateKey === 'technicalPlan') {
            technicalPlanStore.updateTechnicalPlanWithoutReload({ [taskField]: currentTask });
          } else {
            persistedState = updateWorkspaceState(definition, { [taskField]: currentTask });
          }
        }
        emit(currentTask, buildSnapshot(definition, persistedState, currentTask, eventPatch));
      }
      return currentTask;
    };

    const previousState = loadWorkspaceState(definition) || {};
    const state = updateWorkspaceState(definition, { ...initialPartial, [taskField]: currentTask });
    emit(currentTask, buildSnapshot(definition, state, currentTask));

    const runnerWorkspaceStore = definition.stateKey === 'technicalPlan'
      ? technicalPlanStore
      : definition.stateKey === 'rejectionCheck'
        ? rejectionCheckStore
        : duplicateCheckStore;
    const runnerAiService = aiService?.withQueueScope ? aiService.withQueueScope(queueScopeId) : aiService;
    const runnerAgentService = agentService.bindTaskContext(
      () => createAgentUserTaskContext(type, definition, payload, currentTask),
    );
    runner({ aiService: runnerAiService, agentService: runnerAgentService, workspaceStore: runnerWorkspaceStore, knowledgeBaseService, updateTask, payload, taskControl, previousState }).catch((error) => {
      const failedTask = updateTask({ status: 'error', error: error.message || '任务执行失败' });
      const nextState = updateWorkspaceState(definition, { [taskField]: failedTask });
      emit(failedTask, buildSnapshot(definition, nextState, failedTask));
    }).finally(() => {
      if (aiService?.resumeQueueScope) {
        aiService.resumeQueueScope(queueScopeId);
      }
      activeTasks.delete(type);
      activeTaskControls.delete(type);
    });

    return currentTask;
  }

  function recoverInterruptedContentGenerationTask() {
    // 始终清掉 activeTasks 残留（防止 zombie 任务对象让 startManagedTask 跳过新任务导致死锁）
    activeTasks.delete('content-generation');
    activeTaskControls.delete('content-generation');

    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const contentTask = technicalPlan.contentGenerationTask;
    if (!isActiveTaskStatus(contentTask?.status)) {
      return;
    }

    const { sections, outlineData, interruptedIds } = normalizeInterruptedContentSections(technicalPlan);
    const normalizedPlan = interruptedIds.size
      ? { ...technicalPlan, contentGenerationSections: sections, outlineData }
      : technicalPlan;
    const phase = inferContentGenerationPhase(normalizedPlan);
    const nextLogs = [
      ...(Array.isArray(contentTask.logs) ? contentTask.logs : []),
      '上次正文生成因应用关闭而暂停，可点击继续恢复。',
    ];
    const nextStats = {
      ...(contentTask.stats || {}),
      content: {
        ...(contentTask.stats?.content || {}),
        phase,
      },
    };
    const pausedTask = {
      ...contentTask,
      status: 'paused',
      pause_requested: false,
      logs: nextLogs,
      stats: nextStats,
      updated_at: now(),
    };
    const state = technicalPlanStore.updateTechnicalPlan({
      outlineData,
      contentGenerationSections: sections,
      contentGenerationTask: pausedTask,
      contentGenerationRuntime: {
        ...(normalizedPlan.contentGenerationRuntime || {}),
        phase,
        updated_at: now(),
      },
    });
    emit(pausedTask, buildSnapshot(getTaskDefinition('content-generation'), state, pausedTask));
  }

  function recoverInterruptedOutlineGenerationTask() {
    // 如果 runner 仍在内存中活跃执行，说明任务没有中断，不要 recover。
    // 此前无条件先 delete activeTasks 再读 DB，会导致普通模式运行时前端刷新调用
    // getActiveTasks 触发 recover，把正在正常推进的 running 任务误判为中断并标为 error。
    const existingTask = activeTasks.get('outline-generation');
    if (existingTask && isActiveTaskStatus(existingTask.status)) {
      return;
    }

    // 清掉 activeTasks 里的残留任务对象（包括 zombie 记录——runner 因异常中断时 finally 没跑，
    // activeTasks 留下 status=running 的脏数据，会让 startManagedTask 误以为有任务在跑、
    // 跳过新任务导致死锁）。之前的 has 检查直接 return 反而保留了这个 zombie，
    // 用户反馈：进度卡在 mainComplete (55%) 1 小时不动，根因就在这里。
    activeTasks.delete('outline-generation');
    activeTaskControls.delete('outline-generation');

    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const outlineTask = technicalPlan.outlineGenerationTask;
    if (!isActiveTaskStatus(outlineTask?.status)) {
      return;
    }

    // 二次保护：若 DB 里 running 任务 recently updated（runner 活跃但 activeTasks 刚好缺失），
    // 也不应标为 error。这能覆盖极端并发/异步边界。
    const ACTIVE_RUNNING_TASK_THRESHOLD_MS = 60_000;
    if (outlineTask.status === 'running' && outlineTask.updated_at) {
      const lastUpdated = new Date(outlineTask.updated_at).getTime();
      if (Number.isFinite(lastUpdated) && Date.now() - lastUpdated < ACTIVE_RUNNING_TASK_THRESHOLD_MS) {
        return;
      }
    }

    const wizard = technicalPlan.outlineWizard || {};
    const completedSteps = Array.isArray(wizard.completedSteps) ? wizard.completedSteps : [];

    if (completedSteps.length > 0 && wizard.active) {
      // 分步向导有已完成步骤：说明 task 实际推进到某步后被中断。
      // 不要标 error（会把整条向导标记为失败、要求用户手动重试），
      // 而是把 task 状态修正为“最后完成步骤”的 wizard-step-done，
      // 前端 autoAdvance 看到 wizard-step-done 会主动重启后续步骤，体验上“被中断后自动续上”。
      const stepProgress = {
        extract: OUTLINE_PROGRESS_VALUES.mainComplete,
        main: OUTLINE_PROGRESS_VALUES.mainComplete,
        knowledge: OUTLINE_PROGRESS_VALUES.knowledgeEnhancementEnd,
        review: OUTLINE_PROGRESS_VALUES.finalReviewEnd,
        audit: OUTLINE_PROGRESS_VALUES.complianceAuditEnd,
        word: OUTLINE_PROGRESS_VALUES.complete,
      };
      const lastStep = completedSteps[completedSteps.length - 1];
      const recoveredTask = {
        ...outlineTask,
        status: 'wizard-step-done',
        progress: stepProgress[lastStep] != null
          ? stepProgress[lastStep]
          : Math.max(0, Math.min(99, Number(outlineTask.progress || 0) || 0)),
        pause_requested: false,
        error: null,
        logs: [...(Array.isArray(outlineTask.logs) ? outlineTask.logs : []), `检测到上次分步生成被中断，已恢复到「${lastStep}」完成状态，前端将自动继续推进后续步骤。`],
        updated_at: now(),
      };
      const state = technicalPlanStore.updateTechnicalPlan({ outlineGenerationTask: recoveredTask });
      emit(recoveredTask, buildSnapshot(getTaskDefinition('outline-generation'), state, recoveredTask));
      return;
    }

    const message = '上次目录生成未完成，请重新生成目录；如旧方案目录提取已有进度，将自动继续。';
    const recoveredTask = {
      ...outlineTask,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(outlineTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(outlineTask.logs) ? outlineTask.logs : []), message],
      updated_at: now(),
    };
    const state = technicalPlanStore.updateTechnicalPlan({ outlineGenerationTask: recoveredTask });
    emit(recoveredTask, buildSnapshot(getTaskDefinition('outline-generation'), state, recoveredTask));
  }

  function recoverInterruptedBidAnalysisTask() {
    // 始终清掉 activeTasks 残留（防止 zombie 任务对象让 startManagedTask 跳过新任务导致死锁）
    activeTasks.delete('bid-analysis');
    activeTaskControls.delete('bid-analysis');

    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const bidAnalysisTask = technicalPlan.bidAnalysisTask;
    if (!isActiveTaskStatus(bidAnalysisTask?.status)) {
      return;
    }

    const message = '上次招标文件解析未完成，请重新解析';
    const nextBidAnalysisTasks = {};
    let hasInterruptedItem = false;
    for (const [itemId, item] of Object.entries(technicalPlan.bidAnalysisTasks || {})) {
      if (item?.status === 'running') {
        nextBidAnalysisTasks[itemId] = {
          ...item,
          status: 'error',
          error: message,
        };
        hasInterruptedItem = true;
      } else {
        nextBidAnalysisTasks[itemId] = item;
      }
    }

    const logs = Array.isArray(bidAnalysisTask.logs) ? bidAnalysisTask.logs : [];
    const recoveredTask = {
      ...bidAnalysisTask,
      status: 'error',
      progress: 100,
      pause_requested: false,
      error: message,
      logs: logs.includes(message) ? logs : [...logs, message],
      updated_at: now(),
    };
    const partial = hasInterruptedItem
      ? { bidAnalysisTask: recoveredTask, bidAnalysisTasks: nextBidAnalysisTasks }
      : { bidAnalysisTask: recoveredTask };
    const state = technicalPlanStore.updateTechnicalPlan(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-analysis'), state, recoveredTask));
  }

  function recoverInterruptedBidSectionExtractionTask() {
    // 始终清掉 activeTasks 残留（防止 zombie 任务对象让 startManagedTask 跳过新任务导致死锁）
    activeTasks.delete('bid-section-extraction');
    activeTaskControls.delete('bid-section-extraction');

    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const extractionTask = technicalPlan.bidSectionExtractionTask;
    if (!isActiveTaskStatus(extractionTask?.status)) {
      return;
    }

    const message = '上次多标段识别未完成，请重新识别';
    const recoveredTask = {
      ...extractionTask,
      status: 'error',
      progress: 100,
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(extractionTask.logs) ? extractionTask.logs : []), message],
      updated_at: now(),
    };
    const state = technicalPlanStore.updateTechnicalPlan({
      bidSectionExtractionTask: recoveredTask,
      bidSectionExtractionStatus: 'error',
      bidSectionExtractionError: message,
    });
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-section-extraction'), state, recoveredTask));
  }

  function recoverInterruptedGlobalFactsTask() {
    // 始终清掉 activeTasks 残留（防止 zombie 任务对象让 startManagedTask 跳过新任务导致死锁）
    activeTasks.delete('global-facts-generation');
    activeTaskControls.delete('global-facts-generation');

    const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
    const globalFactsTask = technicalPlan.globalFactsTask;
    if (!isActiveTaskStatus(globalFactsTask?.status)) {
      return;
    }

    const message = '上次全局事实设定未完成，请重新解析';
    const recoveredTask = {
      ...globalFactsTask,
      status: 'error',
      progress: 100,
      error: message,
      logs: [...(Array.isArray(globalFactsTask.logs) ? globalFactsTask.logs : []), message],
      updated_at: now(),
    };
    const state = technicalPlanStore.updateTechnicalPlan({ globalFactsTask: recoveredTask });
    emit(recoveredTask, buildSnapshot(getTaskDefinition('global-facts-generation'), state, recoveredTask));
  }

  function recoverInterruptedRejectionCheckTasks() {
    // 始终清掉 activeTasks 残留（防止 zombie 任务对象让 startManagedTask 跳过新任务导致死锁）
    activeTasks.delete('rejection-items-extraction');
    activeTaskControls.delete('rejection-items-extraction');
    activeTasks.delete('rejection-check-run');
    activeTaskControls.delete('rejection-check-run');

    const staleExtractionMessage = '上次解析未完成，请重新解析';
    const staleCheckMessage = '上次检查未完成，请重新检查';
    const state = rejectionCheckStore.loadRejectionCheck() || {};
    const partial = {};

    if (state.extractionTask?.status === 'running') {
      partial.invalidBidAndRejectionItems = state.invalidBidAndRejectionItems?.status === 'running'
        ? { ...state.invalidBidAndRejectionItems, status: 'error', error: staleExtractionMessage, updatedAt: now() }
        : state.invalidBidAndRejectionItems;
      partial.extractionTask = {
        ...state.extractionTask,
        status: 'error',
        progress: 100,
        error: staleExtractionMessage,
        logs: [staleExtractionMessage],
        updated_at: now(),
      };
    }

    if (state.checkTask?.status === 'running') {
      const markResult = (result) => result?.status === 'running'
        ? { ...result, status: 'error', error: staleCheckMessage, progressMessage: staleCheckMessage, updatedAt: now() }
        : result;
      partial.rejectionCheckResult = markResult(state.rejectionCheckResult);
      partial.typoCheckResult = markResult(state.typoCheckResult);
      partial.logicCheckResult = markResult(state.logicCheckResult);
      partial.checkTask = {
        ...state.checkTask,
        status: 'error',
        progress: 100,
        error: staleCheckMessage,
        logs: [staleCheckMessage],
        updated_at: now(),
      };
    }

    if (Object.keys(partial).length) {
      rejectionCheckStore.updateRejectionCheck(partial);
    }
  }

  function recoverInterruptedDuplicateCheckTask() {
    // 始终清掉 activeTasks 残留（防止 zombie 任务对象让 startManagedTask 跳过新任务导致死锁）
    activeTasks.delete('duplicate-analysis');
    activeTaskControls.delete('duplicate-analysis');

    const state = duplicateCheckStore.loadDuplicateCheck() || {};
    if (state.analysisTask?.status !== 'running') {
      return;
    }
    const message = '上次标书查重分析未完成，请重新分析';
    const markAnalysis = (analysis) => analysis?.status === 'running'
      ? { ...analysis, status: 'error', progress: 100, message, updated_at: now() }
      : analysis;
    const recoveredTask = {
      ...state.analysisTask,
      status: 'error',
      progress: 100,
      logs: [message],
      error: message,
      updated_at: now(),
    };
    const nextState = duplicateCheckStore.updateDuplicateCheck({
      analysisTask: recoveredTask,
      metadataAnalysis: markAnalysis(state.metadataAnalysis),
      outlineAnalysis: markAnalysis(state.outlineAnalysis),
      contentAnalysis: markAnalysis(state.contentAnalysis),
      imageAnalysis: markAnalysis(state.imageAnalysis),
    });
    emit(nextState.analysisTask || recoveredTask, { duplicateCheck: nextState });
  }

  return {
    subscribe,
    subscribeCallback,
    startBidSectionExtraction(payload) {
      return startManagedTask('bid-section-extraction', payload, runBidSectionExtractionTask, {
        bidSectionMode: 'multiple',
        bidSections: [],
        bidSectionExtractionStatus: 'running',
        bidSectionExtractionError: undefined,
        bidAnalysisTask: undefined,
        bidAnalysisTasks: {},
        bidAnalysisProgress: 0,
        projectOverview: '',
        techRequirements: '',
        outlineData: null,
        outlineWordControlSnapshot: undefined,
        outlineGenerationTask: undefined,
        referenceKnowledgeDocumentIds: [],
        globalFactsTask: undefined,
        globalFacts: [],
        contentGenerationTask: undefined,
        contentGenerationOptions: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentIllustrationPlan: undefined,
        contentGenerationRuntime: undefined,
      });
    },
    startBidAnalysis(payload) {
      return startManagedTask('bid-analysis', payload, runBidAnalysisTask);
    },
    startOutlineGeneration(payload) {
      const outlineMode = payload?.outline_mode === 'response-file' ? 'response-file' : 'aligned';
      const taskPayload = { ...payload, outline_mode: outlineMode };
      return startManagedTask('outline-generation', taskPayload, runOutlineGenerationTask, {
        outlineMode,
        outlineExpansionMode: payload?.outline_expansion_mode === 'original-only' ? 'original-only' : 'ai-complement',
        outlineWordControlOptions: payload?.word_control_options,
        referenceKnowledgeDocumentIds: Array.isArray(payload?.reference_knowledge_document_ids) ? payload.reference_knowledge_document_ids : [],
      });
    },
    startOutlineGenerationStep(payload) {
      const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
      return startManagedTask('outline-generation', payload, runOutlineWizardStep, {
        outlineMode: 'aligned',
        outlineExpansionMode: payload?.outline_expansion_mode === 'original-only' ? 'original-only' : 'ai-complement',
        outlineWordControlOptions: payload?.word_control_options,
        // 非第一步（如 knowledge/review）payload 不会带 reference_knowledge_document_ids，
        // 此时必须回退到已保存的 technicalPlan.referenceKnowledgeDocumentIds，
        // 否则 initialPartial 传空数组会覆盖数据库里的有效选择，
        // 导致用户点击「重试」后页面顶部显示「参考知识库：未选择」。
        referenceKnowledgeDocumentIds: Array.isArray(payload?.reference_knowledge_document_ids)
          ? payload.reference_knowledge_document_ids
          : (technicalPlan.referenceKnowledgeDocumentIds || []),
        outlineWizard: technicalPlan.outlineWizard || null,
      });
    },
    cancelOutlineGeneration() {
      const task = activeTasks.get('outline-generation');
      const control = activeTaskControls.get('outline-generation');
      if (task && isActiveTaskStatus(task.status) && control?.requestPause) {
        return control.requestPause();
      }
      const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
      const outlineTask = technicalPlan.outlineGenerationTask;
      if (outlineTask?.status === 'pausing' || outlineTask?.status === 'paused') {
        return outlineTask;
      }
      throw new Error('当前没有正在生成的目录任务。');
    },
    startGlobalFactsGeneration(payload) {
      return startManagedTask('global-facts-generation', payload, runGlobalFactsTask, {
        globalFacts: [],
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentIllustrationPlan: undefined,
        contentGenerationRuntime: undefined,
      });
    },
    startContentGeneration(payload) {
      const technicalPlan = technicalPlanStore.loadTechnicalPlan();
      if (!technicalPlan.outlineWordControlSnapshot) {
        throw new Error('当前目录没有字数控制生效快照，请重新生成目录');
      }
      return startManagedTask('content-generation', payload, runContentGenerationTask);
    },
    pauseContentGeneration() {
      const task = activeTasks.get('content-generation');
      const control = activeTaskControls.get('content-generation');
      if (task && isActiveTaskStatus(task.status) && control?.requestPause) {
        if (control.queueScopeId && aiService?.pauseQueueScope) {
          aiService.pauseQueueScope(control.queueScopeId);
        }
        return control.requestPause();
      }

      const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
      const contentTask = technicalPlan.contentGenerationTask;
      if (contentTask?.status === 'paused' || contentTask?.status === 'pausing') {
        return contentTask;
      }

      throw new Error('当前没有正在生成的正文任务。');
    },
    startRejectionItemsExtraction(payload) {
      return startManagedTask('rejection-items-extraction', payload, runRejectionItemsExtractionTask, payload?.workspaceState || {});
    },
    startRejectionCheck(payload) {
      return startManagedTask('rejection-check-run', payload, runRejectionCheckTask, payload?.workspaceState || {});
    },
    startDuplicateAnalysis(payload) {
      if (!duplicateCheckService?.runAnalysisTask) {
        throw new Error('标书查重任务服务尚未初始化');
      }
      return startManagedTask('duplicate-analysis', payload, duplicateCheckService.runAnalysisTask);
    },
    getActiveTasks() {
      recoverInterruptedBidSectionExtractionTask();
      recoverInterruptedBidAnalysisTask();
      recoverInterruptedOutlineGenerationTask();
      recoverInterruptedContentGenerationTask();
      recoverInterruptedGlobalFactsTask();
      recoverInterruptedRejectionCheckTasks();
      recoverInterruptedDuplicateCheckTask();
      return Array.from(activeTasks.values());
    },
  };
}

module.exports = { createTaskService };
