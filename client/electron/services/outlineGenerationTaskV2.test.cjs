const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runOutlineGenerationTaskV2,
  isMissingTechnicalScoreItems,
  createInitialPrompt,
  createNoTechnicalScoreChildrenPrompt,
  createNoTechnicalScoreReviewPrompt,
  createScorePlanningPrompt,
  createChildrenPrompt,
  enforceMinimumLeafTarget,
} = require('./outlineGenerationTaskV2.cjs');

test('无评分任务首次生成和恢复时均遵守原方案来源限制，补充模式仍可使用其他资料', async () => {
  for (const originalOnly of [true, false]) {
    for (const restoring of [false, true]) {
      const root = { id: '1', title: '实施方案', description: '原方案章节', attr: '技术', content_mode: 'ai-generate' };
      const result = { output_content: JSON.stringify({ outline: [root] }) };
      let task = { task_id: 'test-outline', stats: {} };
      let knowledgeReads = 0;
      const checkMaterials = (files) => {
        const paths = files.map((file) => file.path);
        assert.ok(paths.includes('原方案.md'));
        assert.equal(paths.includes('项目概述.md'), !originalOnly);
        assert.equal(paths.includes('响应文件要求.md'), !originalOnly);
        assert.equal(paths.includes('参考知识库/参考资料-1.md'), !originalOnly);
      };
      await runOutlineGenerationTaskV2({
        aiService: { isDeveloperMode: () => false },
        agentService: {
          updatePersistentTask() {},
          async runTask(options) {
            checkMaterials(options.files);
            if (options.initial_stage === 'initial-outline') {
              if (originalOnly) assert.match(options.prompt, /目录来源仅限原方案.md/);
              assert.equal(options.max_retries, 1);
              return { ...result, validation_result: options.validateOutput(result) };
            }
            assert.equal(options.initial_stage, 'children_generation');
            assert.equal(options.max_retries, 0);
            assert.equal(options.validateOutput, undefined);
            if (originalOnly) assert.match(options.prompt, /目录来源仅限原方案.md/);
            const meta = { workflow_stage: 'children_generation', user_question_answers: [], writeFiles: async () => {}, readFile: async () => JSON.stringify({ status: 'passed', issues: [], summary: '通过', user_feedback: '' }) };
            const adjustment = await options.continueTask(result, meta);
            assert.equal(adjustment.stage, 'leaf_adjustment');
            if (originalOnly) assert.match(adjustment.prompt, /不得为凑字数或小节数量新增、拆分章节/);
            const review = await options.continueTask(result, { ...meta, workflow_stage: 'leaf_adjustment', user_question_answers: [{ workflow_stage: 'leaf_adjustment', selected_option: '接受当前结果' }] });
            assert.equal(review.stage, 'outline_review');
            if (originalOnly) {
              assert.match(review.prompt, /目录来源仅限原方案.md/);
              assert.doesNotMatch(review.prompt, /专业经验只能补充通用目录结构/);
            }
            await options.continueTask(result, { ...meta, workflow_stage: 'outline_review' });
            return result;
          },
        },
        workspaceStore: {
          loadTechnicalPlan: () => ({
            outlineMode: 'aligned', originalPlanFile: {},
            outlineExpansionMode: originalOnly ? 'original-only' : 'ai-complement',
            projectOverview: '项目背景', referenceKnowledgeDocumentIds: ['reference'],
            bidAnalysisTasks: { techRequirements: { status: 'success', content: '未提取到' }, responseFileRequirements: { content: '响应要求' } },
          }),
          readOriginalPlanMarkdown: () => '# 实施方案',
          hasBidTemplate: () => false,
        },
        knowledgeBaseService: { readReferences: () => { knowledgeReads += 1; return [{ markdown: '知识库内容' }]; } },
        updateTask: (patch) => { task = { ...task, ...patch }; return task; },
        checkpointTask: (patch) => { task = { ...task, ...patch }; return { task }; },
        taskControl: { signal: new AbortController().signal, waitForOutlineSelection: async () => ({ items: [root], selectedIds: ['1'] }) },
        payload: { no_technical_score_mode: true, word_control_options: { minimumWords: 3000, sectionWords: 3000 }, ...(restoring ? { agent_resume: { phase: 'outline-selection' } } : {}) },
      });
      assert.equal(task.status, 'success');
      assert.equal(knowledgeReads, originalOnly ? 0 : 1);
    }
  }
});

test('首次一级目录在修复回调中拒绝空内容、损坏 JSON 和错误结构，通过后返回解析结果', async () => {
  const finished = new Error('校验检查完成');
  let task = { task_id: 'test-initial-outline-validation', stats: {} };
  await assert.rejects(runOutlineGenerationTaskV2({
    agentService: {
      updatePersistentTask() {},
      async runTask(options) {
        assert.equal(options.initial_stage, 'initial-outline');
        assert.equal(options.max_retries, 1);
        const validate = (output_content) => options.validateOutput({ output_content });
        for (const content of [undefined, '', ' \n\t']) {
          assert.throws(() => validate(content), /outline\.json 未生成或内容为空/);
        }
        assert.throws(() => validate('{"outline":['), /outline\.json不是合法 JSON/);
        for (const value of [null, {}, { outline: [] }, { outline: [{ id: '1', title: '实施方案' }] }]) {
          assert.throws(() => validate(JSON.stringify(value)), /outline\.json 不符合目录结构要求/);
        }
        const valid = { outline: [{ id: '1', title: '实施方案', description: '实施安排', attr: '技术', content_mode: 'ai-generate' }] };
        assert.deepEqual(validate(JSON.stringify(valid)), valid);
        throw finished;
      },
    },
    workspaceStore: {
      loadTechnicalPlan: () => ({
        bidAnalysisTasks: { techRequirements: { status: 'success', content: '未提取到' } },
      }),
    },
    updateTask: (patch) => { task = { ...task, ...patch }; return task; },
    checkpointTask: (patch) => { task = { ...task, ...patch }; return { task }; },
    taskControl: {
      signal: new AbortController().signal,
      waitForOutlineSelection: async () => assert.fail('校验通过前不得进入一级目录确认'),
    },
    payload: { no_technical_score_mode: true },
  }), (error) => error === finished);
});

test('前后端均识别仅缺少技术评分项，且不误判局部字段缺失', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../../src/features/technical-plan/services/bidAnalysisWorkflow.ts'), 'utf8');
  const renderer = { exports: {}, require: () => ({}) };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, renderer);
  const cases = [
    ['未提取到', true],
    ['## 技术评分项\n\n没有提及\n\n## 技术评分要求\n偏离扣分规则：每项扣一分。', true],
    ['## 技术评分项\r\n\r\n没有提及\r\n\r\n## 技术评分要求\r\n符合性要求', true],
    ['## 技术评分要求\n符合性要求\n\n## 技术评分项\n没有提及', true],
    ['## 技术评分项\n【评分项名称】：实施方案\n【权重/分值】：没有提及\n\n## 技术评分要求\n没有提及', false],
    ['## 技术评分项\n\n## 技术评分要求\n没有提及', false],
    ['## 技术评分要求\n没有提及', false],
    ['', false],
    [undefined, false],
  ];
  for (const [content, expected] of cases) {
    assert.equal(isMissingTechnicalScoreItems(content), expected, `Main: ${content}`);
    assert.equal(renderer.exports.isMissingTechnicalScoreItems(content), expected, `Renderer: ${content}`);
  }
});

test('无技术评分项模式使用独立的生成与审核规则', () => {
  const initialPrompt = createInitialPrompt('按已有资料生成目录。', {
    standaloneTechnical: true,
    noTechnicalScoreMode: true,
  });
  const childrenPrompt = createNoTechnicalScoreChildrenPrompt({ targetLeafCount: 12, standaloneTechnical: true });
  const reviewPrompt = createNoTechnicalScoreReviewPrompt({ targetLeafCount: 12, actualLeafCount: 12 });

  assert.match(initialPrompt, /专业经验补充通用、合理的技术方案主题/);
  assert.doesNotMatch(initialPrompt, /一级目录必须直接对应技术评分大项/);
  assert.match(childrenPrompt, /不要判断是否存在评分项/);
  assert.match(childrenPrompt, /不得编造具体项目事实、参数、业绩或承诺/);
  assert.doesNotMatch(childrenPrompt, /technical-score-groups|score-directory-plan|report-failure/);
  assert.match(reviewPrompt, /不要判断、补造或检查评分项/);
  assert.doesNotMatch(reviewPrompt, /评分覆盖|score-directory-plan/);
});

test('独立成册模式直接以技术评分大项作为一级目录', () => {
  const prompt = createInitialPrompt('按响应文件要求生成。', { standaloneTechnical: true });

  assert.match(prompt, /一级目录必须直接对应技术评分大项/);
  assert.match(prompt, /不得创建“技术方案”“项目管理方案”“监理大纲”“监理大纲（暗标）”“施工组织设计”“技术标”/);
  assert.match(prompt, /不得加入商务、资信、投标函、授权委托书/);
});

test('独立成册评分规划把根节点固定为评分项层级', () => {
  const prompt = createScorePlanningPrompt({ standaloneTechnical: true });

  assert.match(prompt, /程序已确认本任务存在技术评分项/);
  assert.doesNotMatch(prompt, /如果技术评分信息中没有任何/);
  assert.match(prompt, /score_item_level 固定为 1/);
  assert.match(prompt, /target_title 必须与 root_title 完全一致/);
  assert.match(prompt, /不得再创建“技术方案”“项目管理方案”“监理大纲”“监理大纲（暗标）”“施工组织设计”“技术标”/);
});

test('独立成册生成子目录时不重复评分项根标题', () => {
  const prompt = createChildrenPrompt({
    hasOriginalPlan: false,
    originalOnly: false,
    targetLeafCount: 10,
    allowRootChanges: false,
    standaloneTechnical: true,
  });

  assert.match(prompt, /现有一级根节点本身就是评分项映射节点/);
  assert.match(prompt, /不得在根节点下面再次生成同名评分项/);
  assert.doesNotMatch(prompt, /"title":"技术方案"/);
});

test('独立成册末级小节目标至少覆盖每个技术分支', () => {
  assert.equal(enforceMinimumLeafTarget(10, 0, 6), 10);
  assert.equal(enforceMinimumLeafTarget(14, 0, 6), 14);
  assert.equal(enforceMinimumLeafTarget(4, 0, 6), 6);
  assert.equal(enforceMinimumLeafTarget(10, 2, 5), 10);
  assert.equal(enforceMinimumLeafTarget(null, 0, 6), null);
  assert.equal(enforceMinimumLeafTarget(2, 0, 1, {
    maximumWords: 4000,
    sectionWords: 3000,
    strictSectionWords: true,
  }), 1);
  assert.throws(
    () => enforceMinimumLeafTarget(4, 0, 6, {
      maximumWords: 4000,
      sectionWords: 1000,
      strictSectionWords: true,
    }),
    /最多容纳 5 个 AI 生成小节，但独立成册目录至少需要 6 个/,
  );
});
