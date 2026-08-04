import * as Dialog from '@radix-ui/react-dialog';
import * as Switch from '@radix-ui/react-switch';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { useToast } from '../../../shared/ui';
import type { BackgroundTaskState, OutlineWizardState, OutlineWizardStep, SaveOutlineRequest, TechnicalPlanWorkflowKind } from '../types';
import type { KnowledgeBaseIndex, KnowledgeDocument } from '../../knowledge-base/types';
import type { OutlineData, OutlineExpansionMode, OutlineItem, OutlineMode, OutlineWordControlOptions } from '../../../shared/types';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';

const WIZARD_STEP_LABELS: Record<OutlineWizardStep, string> = {
  extract: '提取原方案目录',
  main: '生成主目录',
  knowledge: '知识库增强',
  review: '最终审核',
  word: '字数调整与二审',
};

const WIZARD_STEP_DESCRIPTIONS: Record<OutlineWizardStep, string> = {
  extract: '从现有技术方案中解析原目录结构，作为扩充基础。',
  main: '基于招标文件要求生成完整的一级、二级目录骨架。',
  knowledge: '结合参考知识库自动补充相关章节与要点。',
  review: '对目录完整性、相关性、逻辑性进行 AI 审核。',
  word: '根据字数要求进行扩写或精简，并做最终检查。',
};

function getWizardSteps(isExpansion: boolean, expansionMode: OutlineExpansionMode): OutlineWizardStep[] {
  if (!isExpansion) {
    return ['main', 'knowledge', 'review', 'word'];
  }
  return expansionMode === 'original-only' ? ['extract'] : ['extract', 'main', 'knowledge', 'review', 'word'];
}

interface OutlineEditPageProps {
  workflowKind: TechnicalPlanWorkflowKind;
  projectOverview: string;
  techRequirements: string;
  outlineMode: OutlineMode;
  outlineExpansionMode: OutlineExpansionMode;
  outlineWordControlOptions: OutlineWordControlOptions;
  outlineWordControlSnapshot?: OutlineWordControlOptions;
  referenceKnowledgeDocumentIds: string[];
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  contentTaskStatus?: BackgroundTaskState['status'];
  outlineWizard?: OutlineWizardState | null;
  onOutlineConfigChange: (config: { referenceKnowledgeDocumentIds: string[]; outlineMode: OutlineMode; outlineExpansionMode: OutlineExpansionMode; wordControlOptions: OutlineWordControlOptions }) => Promise<void>;
  onOutlineSaved: (request: SaveOutlineRequest) => Promise<void>;
  onSortGuardChange?: (guard: OutlineSortGuard | null) => void;
}

interface OutlineSortGuard {
  hasUnsavedSort: () => boolean;
  saveSort: () => Promise<void>;
  discardSort: () => void;
}

interface RenumberResult {
  outline: OutlineItem[];
  idMap: Record<string, string>;
}

interface OutlineLocation {
  parentId: string | null;
  level: number;
  index: number;
}

interface DropTargetState {
  itemId: string;
  position: 'before' | 'after';
  valid: boolean;
}

const emptyKnowledgeIndex: KnowledgeBaseIndex = { folders: [], documents: [] };
const outlineExpansionModeLabels: Record<OutlineExpansionMode, string> = {
  'original-only': '仅使用原方案目录',
  'ai-complement': 'AI基于原方案补充',
};
const outlineExpansionModeOptions: Array<{ value: OutlineExpansionMode; title: string; description: string }> = [
  {
    value: 'original-only',
    title: outlineExpansionModeLabels['original-only'],
    description: '提取并补漏原方案目录后直接作为新目录；知识库不参与目录补充，但会用于后续全局事实和正文生成。',
  },
  {
    value: 'ai-complement',
    title: outlineExpansionModeLabels['ai-complement'],
    description: '保留原方案一级目录，在其基础上补充招标评分项缺口，并可继续使用知识库增强。',
  },
];

const outlineModeLabels: Record<OutlineMode, string> = {
  aligned: '按技术评分项生成一级目录',
  'response-file': '按响应文件要求生成一级目录',
};

const WORD_COUNT_INPUT_UNIT = 10000;

function parseWordCountDraft(value: string) {
  if (!value) return 0;
  if (!/^\d*(?:\.\d{0,4})?$/.test(value)) return null;
  const number = Number(value);
  const words = Math.round(number * WORD_COUNT_INPUT_UNIT);
  return Number.isSafeInteger(words) && words >= 0 ? words : null;
}

function formatWordCountDraft(words: number) {
  return String(Math.max(0, Math.round(Number(words) || 0)) / WORD_COUNT_INPUT_UNIT);
}

function normalizeWordControlDraft(values: {
  minimumWords: string;
  maximumWords: string;
  sectionWords: string;
  strictSectionWords: boolean;
}) {
  const minimumWords = parseWordCountDraft(values.minimumWords);
  const maximumWords = parseWordCountDraft(values.maximumWords);
  const sectionWords = parseWordCountDraft(values.sectionWords);
  if (minimumWords === null || maximumWords === null || sectionWords === null) {
    throw new Error('字数设置只允许填写非负整数');
  }
  const options: OutlineWordControlOptions = {
    minimumWords,
    maximumWords,
    sectionWords,
    strictSectionWords: sectionWords > 0 && values.strictSectionWords,
  };
  if (minimumWords > 0 && maximumWords > 0 && maximumWords < minimumWords) {
    throw new Error('最多字数不能低于最少字数');
  }
  const effectiveSectionWords = sectionWords > 0 ? sectionWords : 3000;
  const minimumLeafCount = minimumWords > 0 ? Math.ceil(minimumWords / effectiveSectionWords) : null;
  const maximumLeafCount = maximumWords > 0 ? Math.floor(maximumWords / effectiveSectionWords) : null;
  if (maximumLeafCount !== null && maximumLeafCount < 1) {
    throw new Error('当前最多字数无法形成有效叶子节点范围，请调整最多字数或每小节字数');
  }
  if (minimumLeafCount !== null && maximumLeafCount !== null && minimumLeafCount > maximumLeafCount) {
    throw new Error('当前设置无法形成有效叶子节点范围，请调整最少字数、最多字数或每小节字数');
  }
  return options;
}

function getEstimatedPages(minimumWords: number, maximumWords: number) {
  const baseWords = minimumWords > 0 && maximumWords > 0
    ? (minimumWords + maximumWords) / 2
    : minimumWords || maximumWords;
  return baseWords > 0 ? Math.ceil(baseWords / 650) : null;
}

function areWordControlOptionsEqual(left?: OutlineWordControlOptions, right?: OutlineWordControlOptions) {
  return Boolean(left && right
    && left.minimumWords === right.minimumWords
    && left.maximumWords === right.maximumWords
    && left.sectionWords === right.sectionWords
    && left.strictSectionWords === right.strictSectionWords);
}

function collectOutlineIds(items: OutlineItem[], ids = new Set<string>()) {
  items.forEach((item) => {
    ids.add(item.id);
    if (item.children?.length) {
      collectOutlineIds(item.children, ids);
    }
  });
  return ids;
}

function collectRootIds(items: OutlineItem[]) {
  return new Set(items.map((item) => item.id));
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function renumberOutlineItemsWithIdMap(items: OutlineItem[], parentPrefix = ''): RenumberResult {
  const idMap: Record<string, string> = {};
  const outline = items.map((item, index) => {
    const id = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
    const childResult = item.children?.length ? renumberOutlineItemsWithIdMap(item.children, id) : null;
    idMap[item.id] = id;
    if (childResult) {
      Object.assign(idMap, childResult.idMap);
    }
    return {
      ...item,
      id,
      children: childResult?.outline,
    };
  });

  return { outline, idMap };
}

function createIdentityIdMap(items: OutlineItem[], idMap: Record<string, string> = {}) {
  items.forEach((item) => {
    idMap[item.id] = item.id;
    if (item.children?.length) {
      createIdentityIdMap(item.children, idMap);
    }
  });
  return idMap;
}

function composeIdMap(baseMap: Record<string, string>, stepMap: Record<string, string>) {
  return Object.fromEntries(Object.entries(baseMap).map(([oldId, currentId]) => [oldId, stepMap[currentId] || currentId]));
}

function findOutlineLocation(items: OutlineItem[], itemId: string, parentId: string | null = null, level = 0): OutlineLocation | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.id === itemId) {
      return { parentId, level, index };
    }
    if (item.children?.length) {
      const child = findOutlineLocation(item.children, itemId, item.id, level + 1);
      if (child) return child;
    }
  }
  return null;
}

function reorderSiblingItems(items: OutlineItem[], draggedId: string, targetId: string, position: 'before' | 'after') {
  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
    return items;
  }

  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  const adjustedTargetIndex = next.findIndex((item) => item.id === targetId);
  const insertIndex = position === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1;
  next.splice(insertIndex, 0, dragged);
  return next;
}

function reorderOutlineSiblings(items: OutlineItem[], parentId: string | null, draggedId: string, targetId: string, position: 'before' | 'after'): OutlineItem[] {
  if (parentId === null) {
    return reorderSiblingItems(items, draggedId, targetId, position);
  }

  return items.map((item) => {
    if (item.id === parentId) {
      return {
        ...item,
        children: reorderSiblingItems(item.children || [], draggedId, targetId, position),
      };
    }
    return item.children?.length
      ? { ...item, children: reorderOutlineSiblings(item.children, parentId, draggedId, targetId, position) }
      : item;
  });
}

function updateOutlineItem(items: OutlineItem[], itemId: string, updater: (item: OutlineItem) => OutlineItem): OutlineItem[] {
  return items.map((item) => {
    if (item.id === itemId) {
      return updater(item);
    }

    return {
      ...item,
      children: item.children ? updateOutlineItem(item.children, itemId, updater) : undefined,
    };
  });
}

function deleteOutlineItem(items: OutlineItem[], itemId: string): OutlineItem[] {
  return items.flatMap((item) => {
    if (item.id === itemId) {
      return [];
    }

    return [{
      ...item,
      children: item.children ? deleteOutlineItem(item.children, itemId) : undefined,
    }];
  });
}

function findOutlineItem(items: OutlineItem[], itemId: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === itemId) {
      return item;
    }
    const child = item.children ? findOutlineItem(item.children, itemId) : null;
    if (child) {
      return child;
    }
  }
  return null;
}

function getInitialExpandedKnowledgeFolders(index: KnowledgeBaseIndex) {
  const firstAvailableFolder = index.folders.find((folder) => (
    index.documents.some((document) => document.folder_id === folder.id && document.status === 'success')
  ));
  return new Set(firstAvailableFolder ? [firstAvailableFolder.id] : []);
}

function includesKeyword(value: string, keyword: string) {
  return value.toLowerCase().includes(keyword);
}

function OutlineEditPage({
  workflowKind,
  projectOverview,
  techRequirements,
  outlineMode,
  outlineExpansionMode,
  outlineWordControlOptions,
  outlineWordControlSnapshot,
  referenceKnowledgeDocumentIds,
  outlineData,
  outlineWizard,
  task,
  contentTaskStatus,
  onOutlineConfigChange,
  onOutlineSaved,
  onSortGuardChange,
}: OutlineEditPageProps) {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [startingOutline, setStartingOutline] = useState(false);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [draftOutlineMode, setDraftOutlineMode] = useState<OutlineMode>(outlineMode);
  const [draftOutlineExpansionMode, setDraftOutlineExpansionMode] = useState<OutlineExpansionMode>(outlineExpansionMode);
  const [draftKnowledgeDocumentIds, setDraftKnowledgeDocumentIds] = useState<string[]>(referenceKnowledgeDocumentIds);
  const [draftMinimumWords, setDraftMinimumWords] = useState(formatWordCountDraft(outlineWordControlOptions.minimumWords));
  const [draftMaximumWords, setDraftMaximumWords] = useState(formatWordCountDraft(outlineWordControlOptions.maximumWords));
  const [draftSectionWords, setDraftSectionWords] = useState(formatWordCountDraft(outlineWordControlOptions.sectionWords));
  const [draftStrictSectionWords, setDraftStrictSectionWords] = useState(outlineWordControlOptions.strictSectionWords);
  const [savingOutlineConfig, setSavingOutlineConfig] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [draftForceOutlineAgentRepair, setDraftForceOutlineAgentRepair] = useState(false);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [expandedKnowledgeFolderIds, setExpandedKnowledgeFolderIds] = useState<Set<string>>(new Set());
  const [knowledgeIndex, setKnowledgeIndex] = useState<KnowledgeBaseIndex>(emptyKnowledgeIndex);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [localStartAt, setLocalStartAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [sorting, setSorting] = useState(false);
  const [draftOutlineData, setDraftOutlineData] = useState<OutlineData | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [sortDirty, setSortDirty] = useState(false);
  const [savingSort, setSavingSort] = useState(false);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const logListRef = useRef<HTMLDivElement | null>(null);
  const sortIdMapRef = useRef<Record<string, string>>({});
  const { showToast } = useToast();
  const [wizardMode, setWizardMode] = useState(false);
  const activeOutlineData = sorting ? draftOutlineData : outlineData;
  const selectedItem = activeOutlineData && selectedItemId ? findOutlineItem(activeOutlineData.outline, selectedItemId) : null;
  const taskRunning = task?.status === 'running';
  const taskFailed = task?.status === 'error';
  const generating = startingOutline || taskRunning;
  const isExpansionWorkflow = workflowKind === 'existing-plan-expansion';
  const knowledgePickingDisabled = generating;
  const contentMutationLocked = contentTaskStatus === 'running' || contentTaskStatus === 'pausing' || contentTaskStatus === 'paused';
  const outlineMutationLocked = generating || contentMutationLocked || savingSort;
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1];
  const progress = generating
    ? Math.max(5, Math.min(99, task?.progress || 5))
    : taskFailed
      ? Math.max(0, Math.min(99, task?.progress || 0))
      : outlineData || task?.status === 'success'
        ? 100
        : 0;
  const statusText = generating ? '运行中' : taskFailed ? '失败' : outlineData ? '已完成' : '未开始';
  const aiStatusTitle = generating ? 'AI 正在工作' : taskFailed ? '生成失败' : outlineData ? '目录已生成' : '等待生成';
  const statusMessage = taskFailed ? task?.error || latestLog || '目录生成失败，请查看开发者日志。' : latestLog || '点击生成目录后，这里会显示目录生成、审核和修正过程。';
  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  const updatedAt = task?.updated_at ? Date.parse(task.updated_at) : NaN;
  const effectiveStartedAt = Number.isFinite(startedAt) ? startedAt : localStartAt;
  const elapsedText = generating && effectiveStartedAt ? `已运行 ${formatDuration(nowTick - effectiveStartedAt)}` : '';
  const staleText = generating && Number.isFinite(updatedAt) ? `最近更新 ${Math.floor(Math.max(0, nowTick - updatedAt) / 1000)} 秒前` : '';
  const parsedDraftMinimumWords = parseWordCountDraft(draftMinimumWords) ?? 0;
  const parsedDraftMaximumWords = parseWordCountDraft(draftMaximumWords) ?? 0;
  const parsedDraftSectionWords = parseWordCountDraft(draftSectionWords) ?? 0;
  const estimatedPages = getEstimatedPages(parsedDraftMinimumWords, parsedDraftMaximumWords);
  const normalizedDraftOptions: OutlineWordControlOptions = {
    minimumWords: parsedDraftMinimumWords,
    maximumWords: parsedDraftMaximumWords,
    sectionWords: parsedDraftSectionWords,
    strictSectionWords: parsedDraftSectionWords > 0 && draftStrictSectionWords,
  };
  const wordControlRequiresRegeneration = Boolean(outlineData && !areWordControlOptionsEqual(normalizedDraftOptions, outlineWordControlSnapshot));
  const outlineModeRequiresRegeneration = Boolean(outlineData && !isExpansionWorkflow && draftOutlineMode !== outlineMode);
  const configurationRequiresRegeneration = wordControlRequiresRegeneration || outlineModeRequiresRegeneration;

  const initializeWordControlDraft = () => {
    setDraftMinimumWords(formatWordCountDraft(outlineWordControlOptions.minimumWords));
    setDraftMaximumWords(formatWordCountDraft(outlineWordControlOptions.maximumWords));
    setDraftSectionWords(formatWordCountDraft(outlineWordControlOptions.sectionWords));
    setDraftStrictSectionWords(outlineWordControlOptions.strictSectionWords);
  };

  useEffect(() => {
    let cancelled = false;
    window.yibiao?.config.load().then((cfg) => {
      if (cancelled) return;
      setDeveloperMode(Boolean(cfg?.developer_mode));
      if (!cfg?.developer_mode) {
        setDraftForceOutlineAgentRepair(false);
      }
      if (cfg?.export_format) {
        setExportFormat(cfg.export_format);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (activeOutlineData?.outline?.length) {
      const validIds = collectOutlineIds(activeOutlineData.outline);
      setExpandedItems((prev) => {
        const next = new Set([...prev].filter((id) => validIds.has(id)));
        return next.size || sorting ? next : collectRootIds(activeOutlineData.outline);
      });
      setSelectedItemId((prev) => (prev && validIds.has(prev) ? prev : activeOutlineData.outline[0]?.id || null));
      return;
    }

    setExpandedItems(new Set());
    setSelectedItemId(null);
  }, [activeOutlineData]);

  useEffect(() => {
    if (task?.status) {
      setStartingOutline(false);
      if (task.status !== 'running') {
        setLocalStartAt(null);
      }
    }
  }, [task?.status]);

  useEffect(() => {
    if (!generating) {
      return;
    }

    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    if (logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [progressLogs.length]);

  useEffect(() => {
    if (!generationDialogOpen) {
      return;
    }

    setDraftOutlineMode(isExpansionWorkflow ? 'aligned' : outlineMode);
    setDraftOutlineExpansionMode(isExpansionWorkflow ? outlineExpansionMode : 'ai-complement');
    setDraftKnowledgeDocumentIds(referenceKnowledgeDocumentIds);
    initializeWordControlDraft();
    setDraftForceOutlineAgentRepair(false);
    setKnowledgeSearch('');
    void loadKnowledgeIndex();
  }, [generationDialogOpen, isExpansionWorkflow, outlineMode, outlineExpansionMode, outlineWordControlOptions, referenceKnowledgeDocumentIds]);

  const loadKnowledgeIndex = async () => {
    try {
      setLoadingKnowledge(true);
      const localData = (await window.yibiao?.knowledgeBase.list()) || emptyKnowledgeIndex;

      // 与服务器活跃文档取交集：本地库（knowledgeBase.list）会累积重传/删除后残留的
      // 历史孤儿文档，导致「参考知识库」弹窗的可用文档越堆越多。这里只保留服务器上
      // 仍存在（团队库 kb.sqlite + 个人库 master.sqlite）的文档，与服务器保持一致。
      let documents = localData.documents;
      try {
        const [teamRes, personalRes] = await Promise.allSettled([
          window.yibiao?.kbTeam.getTree?.() ?? Promise.resolve(null),
          window.yibiao?.kbPersonal.getTree?.() ?? Promise.resolve(null),
        ]);
        const serverIds = new Set<string>();
        for (const res of [teamRes, personalRes]) {
          if (res.status === 'fulfilled' && res.value?.success) {
            const docs = (res.value.data?.documents as Array<{ id?: string | number }>) || [];
            docs.forEach((d) => {
              if (d.id != null) serverIds.add(String(d.id));
            });
          }
        }
        // 仅当至少成功拉到一个库的活跃列表时才过滤，避免离线/未登录时清空可用文档
        if (serverIds.size > 0) {
          documents = localData.documents.filter((d) => serverIds.has(String(d.id)));
        }
      } catch {
        /* 服务器取交集失败则保留本地列表（离线兜底） */
      }

      const data: KnowledgeBaseIndex = { folders: localData.folders, documents };
      setKnowledgeIndex(data);
      setExpandedKnowledgeFolderIds(getInitialExpandedKnowledgeFolders(data));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
      setKnowledgeIndex(emptyKnowledgeIndex);
      setExpandedKnowledgeFolderIds(new Set());
    } finally {
      setLoadingKnowledge(false);
    }
  };

  const openGenerationDialog = () => {
    if (sorting) {
      showToast('请先保存当前目录排序', 'info');
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }
    if (!projectOverview || !techRequirements) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }

    setDraftOutlineMode(isExpansionWorkflow ? 'aligned' : outlineMode);
    setDraftOutlineExpansionMode(isExpansionWorkflow ? outlineExpansionMode : 'ai-complement');
    setDraftKnowledgeDocumentIds(referenceKnowledgeDocumentIds);
    initializeWordControlDraft();
    setKnowledgeSearch('');
    setGenerationDialogOpen(true);
  };

  const getNormalizedWordControlOptions = () => normalizeWordControlDraft({
    minimumWords: draftMinimumWords,
    maximumWords: draftMaximumWords,
    sectionWords: draftSectionWords,
    strictSectionWords: draftStrictSectionWords,
  });

  const applyNormalizedWordControlDraft = (options: OutlineWordControlOptions) => {
    setDraftMinimumWords(formatWordCountDraft(options.minimumWords));
    setDraftMaximumWords(formatWordCountDraft(options.maximumWords));
    setDraftSectionWords(formatWordCountDraft(options.sectionWords));
    setDraftStrictSectionWords(options.strictSectionWords);
  };

  const saveOutlineConfig = async () => {
    try {
      const wordControlOptions = getNormalizedWordControlOptions();
      setSavingOutlineConfig(true);
      await onOutlineConfigChange({
        referenceKnowledgeDocumentIds: draftKnowledgeDocumentIds,
        outlineMode: isExpansionWorkflow ? 'aligned' : draftOutlineMode,
        outlineExpansionMode: isExpansionWorkflow ? draftOutlineExpansionMode : 'ai-complement',
        wordControlOptions,
      });
      applyNormalizedWordControlDraft(wordControlOptions);
      setGenerationDialogOpen(false);
      showToast('目录生成配置已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存目录配置失败', 'error');
    } finally {
      setSavingOutlineConfig(false);
    }
  };

  const generateOutline = async () => {
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      throw new Error(lockMessage);
    }
    if (!projectOverview || !techRequirements) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }

    if (wizardMode) {
      await runWizardStep(effectiveWizardSteps[0], { restart: wizardActive });
      showToast('分步生成向导已启动', 'success');
      return;
    }

    try {
      const wordControlOptions = getNormalizedWordControlOptions();
      const startedNow = Date.now();
      setStartingOutline(true);
      setLocalStartAt(startedNow);
      setNowTick(startedNow);
      const nextOutlineMode = isExpansionWorkflow ? 'aligned' : draftOutlineMode;
      const nextOutlineExpansionMode = isExpansionWorkflow ? draftOutlineExpansionMode : 'ai-complement';
      await onOutlineConfigChange({
        referenceKnowledgeDocumentIds: draftKnowledgeDocumentIds,
        outlineMode: nextOutlineMode,
        outlineExpansionMode: nextOutlineExpansionMode,
        wordControlOptions,
      });
      setGenerationDialogOpen(false);
      await window.yibiao?.tasks.startOutlineGeneration({
        reference_knowledge_document_ids: draftKnowledgeDocumentIds,
        outline_mode: nextOutlineMode,
        outline_expansion_mode: nextOutlineExpansionMode,
        word_control_options: wordControlOptions,
        debug_force_outline_agent_repair: developerMode && draftForceOutlineAgentRepair,
      });
      trackConfigUsage({
        outline_mode: isExpansionWorkflow ? nextOutlineExpansionMode : nextOutlineMode,
        word_control_enabled: wordControlOptions.minimumWords > 0 || wordControlOptions.maximumWords > 0 || wordControlOptions.sectionWords > 0,
        minimum_words: wordControlOptions.minimumWords,
        maximum_words: wordControlOptions.maximumWords,
        section_words: wordControlOptions.sectionWords,
        strict_section_words: wordControlOptions.strictSectionWords,
      });
      showToast('目录生成任务已在后台启动', 'success');
    } catch (error) {
      setStartingOutline(false);
      setLocalStartAt(null);
      showToast(error instanceof Error ? error.message : '启动目录生成任务失败', 'error');
    }
  };

  const wizardActive = outlineWizard?.active === true;
  const effectiveWizardSteps = outlineWizard
    ? getWizardSteps(outlineWizard.workflowKind === 'existing-plan-expansion', outlineWizard.outlineExpansionMode)
    : getWizardSteps(isExpansionWorkflow, isExpansionWorkflow ? (draftOutlineExpansionMode || outlineExpansionMode) : 'ai-complement');
  const wizardCurrentIndex = outlineWizard ? outlineWizard.completedSteps.length : 0;
  const wizardDone = Boolean(outlineWizard) && !wizardActive && (outlineWizard?.completedSteps.length || 0) >= effectiveWizardSteps.length;
  const runningWizardStep = task?.status === 'running' && effectiveWizardSteps[wizardCurrentIndex] ? effectiveWizardSteps[wizardCurrentIndex] : null;
  const failedWizardStep = task?.status === 'error' && effectiveWizardSteps[wizardCurrentIndex] ? effectiveWizardSteps[wizardCurrentIndex] : null;
  const wizardStatusText = !outlineWizard
    ? '未开始'
    : wizardDone
      ? '已完成'
      : runningWizardStep
        ? '进行中'
        : failedWizardStep
          ? '失败，可重试'
          : wizardActive
            ? `待执行：${WIZARD_STEP_LABELS[effectiveWizardSteps[wizardCurrentIndex]]}`
            : '未开始';

  const runWizardStep = async (step: OutlineWizardStep, options: { restart?: boolean } = {}) => {
    if (!projectOverview || !techRequirements) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }
    const wordControlOptions = getNormalizedWordControlOptions();
    const nextOutlineExpansionMode = isExpansionWorkflow ? (draftOutlineExpansionMode || outlineExpansionMode) : 'ai-complement';
    const isFirst = effectiveWizardSteps[0] === step;
    try {
      setStartingOutline(true);
      await onOutlineConfigChange({
        referenceKnowledgeDocumentIds: draftKnowledgeDocumentIds,
        outlineMode: isExpansionWorkflow ? 'aligned' : draftOutlineMode,
        outlineExpansionMode: nextOutlineExpansionMode,
        wordControlOptions,
      });
      await window.yibiao?.tasks.startOutlineGenerationStep({
        wizardStep: step,
        wizardRestart: Boolean(options.restart),
        ...(isFirst ? {
          reference_knowledge_document_ids: draftKnowledgeDocumentIds,
          outline_expansion_mode: nextOutlineExpansionMode,
          word_control_options: wordControlOptions,
          debug_force_outline_agent_repair: developerMode && draftForceOutlineAgentRepair,
        } : {}),
      });
      showToast(`已开始「${WIZARD_STEP_LABELS[step]}」`, 'success');
    } catch (error) {
      setStartingOutline(false);
      showToast(error instanceof Error ? error.message : '启动分步生成失败', 'error');
    }
  };

  const toggleDraftKnowledgeDocument = (document: KnowledgeDocument) => {
    if (document.status !== 'success' || knowledgePickingDisabled) {
      return;
    }

    setDraftKnowledgeDocumentIds((prev) => (
      prev.includes(document.id)
        ? prev.filter((id) => id !== document.id)
        : [...prev, document.id]
    ));
  };

  const toggleKnowledgeFolder = (folderId: string) => {
    setExpandedKnowledgeFolderIds((prev) => (prev.has(folderId) ? new Set() : new Set([folderId])));
  };

  const selectFolderDocuments = (documents: KnowledgeDocument[]) => {
    if (knowledgePickingDisabled) {
      return;
    }
    const ids = documents.filter((document) => document.status === 'success').map((document) => document.id);
    setDraftKnowledgeDocumentIds((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  };

  const clearFolderDocuments = (documents: KnowledgeDocument[]) => {
    if (knowledgePickingDisabled) {
      return;
    }
    const ids = new Set(documents.map((document) => document.id));
    setDraftKnowledgeDocumentIds((prev) => prev.filter((id) => !ids.has(id)));
  };

  const removeDraftKnowledgeDocument = (documentId: string) => {
    if (knowledgePickingDisabled) {
      return;
    }
    setDraftKnowledgeDocumentIds((prev) => prev.filter((id) => id !== documentId));
  };

  const clearDraftKnowledgeDocuments = () => {
    if (knowledgePickingDisabled) {
      return;
    }
    setDraftKnowledgeDocumentIds([]);
  };

  const getMutationLockMessage = () => {
    if (generating) return '目录生成任务正在运行，当前目录暂不可编辑';
    if (contentMutationLocked) return '正文生成任务正在运行或暂停中，请结束后再调整目录';
    return '';
  };

  const saveOutlineChange = async (outline: OutlineItem[], reason: SaveOutlineRequest['reason'], affectedNodeIds: string[] = []) => {
    if (!outlineData) {
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }

    const renumbered = renumberOutlineItemsWithIdMap(outline);
    await onOutlineSaved({
      outlineData: { ...outlineData, outline: renumbered.outline },
      reason,
      idMap: renumbered.idMap,
      affectedNodeIds,
    });
  };

  const startEditing = (item: OutlineItem) => {
    if (sorting || outlineMutationLocked) {
      return;
    }
    setSelectedItemId(item.id);
    setEditingItemId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
  };

  const saveEditing = async () => {
    if (!outlineData || !editingItemId || sorting || outlineMutationLocked) {
      return;
    }

    try {
      await saveOutlineChange(updateOutlineItem(outlineData.outline, editingItemId, (item) => ({
        ...item,
        title: editTitle.trim() || item.title,
        description: editDescription.trim(),
      })), 'edit', [editingItemId]);
      setEditingItemId(null);
      showToast('目录项已更新，相关正文已清空', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存目录项失败', 'error');
    }
  };

  const addRootItem = async () => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }

    const newItem: OutlineItem = {
      id: `${outlineData.outline.length + 1}`,
      title: '新目录项',
      description: '请编辑描述',
    };
    try {
      await saveOutlineChange([...outlineData.outline, newItem], 'add-root');
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
      showToast('一级目录已添加', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加一级目录失败', 'error');
    }
  };

  const addChildItem = async (parentId: string) => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }

    const parent = findOutlineItem(outlineData.outline, parentId);
    const nextIndex = (parent?.children?.length || 0) + 1;
    const newItem: OutlineItem = {
      id: `${parentId}.${nextIndex}`,
      title: '新目录项',
      description: '请编辑描述',
    };

    try {
      await saveOutlineChange(updateOutlineItem(outlineData.outline, parentId, (item) => ({
        ...item,
        children: [...(item.children || []), newItem],
      })), 'add-child', [parentId]);
      setExpandedItems((prev) => new Set(prev).add(parentId));
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
      showToast('子目录已添加，父目录正文已清空', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加子目录失败', 'error');
    }
  };

  const removeItem = async (itemId: string) => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }
    try {
      const removedItem = findOutlineItem(outlineData.outline, itemId);
      const removedIds = removedItem ? [...collectOutlineIds([removedItem])] : [itemId];
      const nextOutline = deleteOutlineItem(outlineData.outline, itemId);
      if (!nextOutline.length) {
        showToast('至少保留一个目录项', 'info');
        return;
      }
      await saveOutlineChange(nextOutline, 'delete', removedIds);
      setSelectedItemId(null);
      showToast('目录项已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除目录项失败', 'error');
    }
  };

  const toggleExpanded = (itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const expandAllItems = () => {
    if (activeOutlineData?.outline?.length) {
      setExpandedItems(collectOutlineIds(activeOutlineData.outline));
    }
  };

  const collapseAllItems = () => {
    setExpandedItems(new Set());
  };

  const startSorting = () => {
    if (!outlineData?.outline?.length) {
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }

    setDraftOutlineData(outlineData);
    sortIdMapRef.current = createIdentityIdMap(outlineData.outline);
    setSorting(true);
    setSortDirty(false);
    setEditingItemId(null);
    setDraggingItemId(null);
    setDropTarget(null);
    showToast('仅支持同级目录排序；拖动只在前端调整，点击保存排序后才会写入数据库。', 'info');
  };

  const discardSorting = () => {
    setSorting(false);
    setDraftOutlineData(null);
    setSortDirty(false);
    setSavingSort(false);
    setDraggingItemId(null);
    setDropTarget(null);
    sortIdMapRef.current = {};
  };

  const saveSorting = async () => {
    if (!draftOutlineData?.outline?.length) {
      discardSorting();
      return;
    }
    if (!sortDirty) {
      discardSorting();
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      throw new Error(lockMessage);
    }

    setSavingSort(true);
    try {
      await onOutlineSaved({
        outlineData: draftOutlineData,
        reason: 'sort',
        idMap: sortIdMapRef.current,
      });
      discardSorting();
      showToast('目录排序已保存', 'success');
    } finally {
      setSavingSort(false);
    }
  };

  useEffect(() => {
    if (!onSortGuardChange) return;
    onSortGuardChange({
      hasUnsavedSort: () => sorting && sortDirty,
      saveSort: saveSorting,
      discardSort: discardSorting,
    });
    return () => onSortGuardChange(null);
  }, [onSortGuardChange, sorting, sortDirty, draftOutlineData]);

  const getDropPosition = (event: DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const canDropOnTarget = (draggedId: string, targetId: string) => {
    if (!activeOutlineData?.outline?.length || draggedId === targetId) return false;
    const dragged = findOutlineLocation(activeOutlineData.outline, draggedId);
    const target = findOutlineLocation(activeOutlineData.outline, targetId);
    return Boolean(dragged && target && dragged.parentId === target.parentId && dragged.level === target.level);
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    if (!sorting) {
      return;
    }
    setDraggingItemId(item.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    if (!sorting || !draggingItemId) {
      return;
    }
    event.preventDefault();
    const valid = canDropOnTarget(draggingItemId, item.id);
    event.dataTransfer.dropEffect = valid ? 'move' : 'none';
    setDropTarget({ itemId: item.id, position: getDropPosition(event), valid });
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    event.preventDefault();
    if (!sorting || !draftOutlineData?.outline?.length || !draggingItemId) {
      return;
    }

    const valid = canDropOnTarget(draggingItemId, item.id);
    if (!valid) {
      setDraggingItemId(null);
      setDropTarget(null);
      showToast('只能同级目录排序', 'info');
      return;
    }

    const sourceLocation = findOutlineLocation(draftOutlineData.outline, draggingItemId);
    if (!sourceLocation) {
      setDraggingItemId(null);
      setDropTarget(null);
      return;
    }

    const position = dropTarget?.itemId === item.id ? dropTarget.position : getDropPosition(event);
    const reordered = reorderOutlineSiblings(draftOutlineData.outline, sourceLocation.parentId, draggingItemId, item.id, position);
    const renumbered = renumberOutlineItemsWithIdMap(reordered);
    sortIdMapRef.current = composeIdMap(sortIdMapRef.current, renumbered.idMap);
    setDraftOutlineData({ ...draftOutlineData, outline: renumbered.outline });
    setExpandedItems((prev) => new Set([...prev].map((id) => renumbered.idMap[id] || id)));
    setSelectedItemId((prev) => (prev ? renumbered.idMap[prev] || prev : prev));
    setSortDirty(true);
    setDraggingItemId(null);
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    setDraggingItemId(null);
    setDropTarget(null);
  };

  const renderItem = (item: OutlineItem, level = 0) => {
    const hasChildren = Boolean(item.children?.length);
    const isExpanded = expandedItems.has(item.id);
    const isActive = selectedItemId === item.id;
    const isDragging = draggingItemId === item.id;
    const isDropTarget = dropTarget?.itemId === item.id;
    const dropClass = isDropTarget
      ? dropTarget.valid
        ? ` is-drop-${dropTarget.position}`
        : ' is-drop-invalid'
      : '';

    return (
      <div className="outline-tree-node" key={item.id} style={{ '--outline-level': level } as CSSProperties}>
        <div
          className={`outline-tree-item${isActive ? ' is-active' : ''}${sorting ? ' is-sorting' : ''}${isDragging ? ' is-dragging' : ''}${dropClass}`}
          draggable={sorting}
          onDragStart={(event) => handleDragStart(event, item)}
          onDragOver={(event) => handleDragOver(event, item)}
          onDrop={(event) => handleDrop(event, item)}
          onDragEnd={handleDragEnd}
        >
          {sorting && <span className="outline-tree-drag-handle" aria-hidden="true">⋮⋮</span>}
          <button
            type="button"
            className={`outline-tree-toggle${hasChildren ? '' : ' is-leaf'}${isExpanded ? ' is-expanded' : ''}`}
            onClick={() => hasChildren && toggleExpanded(item.id)}
            disabled={!hasChildren}
            aria-label={hasChildren ? `${isExpanded ? '折叠' : '展开'} ${item.title}` : `${item.title} 无子目录`}
          >
            {hasChildren ? '›' : '•'}
          </button>
          <button
            type="button"
            className="outline-tree-content"
            onClick={() => setSelectedItemId(item.id)}
            onDoubleClick={() => hasChildren && toggleExpanded(item.id)}
          >
            <strong>{formatOutlineTitle(item.id, item.title, exportFormat.headings[Math.min(item.id.split('.').length - 1, 5)])}</strong>
          </button>
        </div>
        {hasChildren && isExpanded && item.children?.map((child) => renderItem(child, level + 1))}
      </div>
    );
  };

  const renderOutlineExpansionModePicker = () => {
    if (!isExpansionWorkflow) {
      return null;
    }

    return (
      <section className="outline-generation-config-section outline-expansion-mode-section">
        <div className="outline-generation-config-head">
          <strong>原方案目录使用方式</strong>
          <span>{outlineExpansionModeLabels[draftOutlineExpansionMode]}</span>
        </div>
        <div className="outline-expansion-mode-switch">
          {outlineExpansionModeOptions.map((option) => {
            const selected = draftOutlineExpansionMode === option.value;
            return (
              <button
                type="button"
                className={`outline-expansion-mode-option${selected ? ' is-selected' : ''}`}
                key={option.value}
                onClick={() => setDraftOutlineExpansionMode(option.value)}
                disabled={generating}
                aria-pressed={selected}
              >
                <strong>{option.title}</strong>
                <span>{option.description}</span>
              </button>
            );
          })}
        </div>
      </section>
    );
  };

  const renderOutlineModePicker = () => {
    if (isExpansionWorkflow) {
      return null;
    }

    const useResponseFile = draftOutlineMode === 'response-file';
    return (
      <section className="outline-generation-config-section outline-mode-section">
        <div className="outline-generation-config-head">
          <strong>一级目录生成方式</strong>
          <span>{outlineModeLabels[draftOutlineMode]}</span>
        </div>
        <label className="content-generation-config-row outline-mode-option">
          <span>
            <strong>按响应文件要求生成一级目录</strong>
            <small>{useResponseFile ? '开启后读取 Step02 响应文件要求中的技术文件目录' : '默认关闭，保持现有评分项目录链路'}</small>
          </span>
          <Switch.Root
            className="content-generation-switch"
            checked={useResponseFile}
            onCheckedChange={(checked) => setDraftOutlineMode(checked ? 'response-file' : 'aligned')}
            disabled={generating}
            aria-label="按响应文件要求生成一级目录"
          >
            <Switch.Thumb className="content-generation-switch-thumb" />
          </Switch.Root>
        </label>
        <div className="outline-word-control-notice">
          开启前需先在招标文件解析中勾选并完成“响应文件要求”。
        </div>
      </section>
    );
  };

  const renderKnowledgePicker = () => {
    if (loadingKnowledge) {
      return <div className="outline-knowledge-empty">正在读取知识库...</div>;
    }

    const keyword = knowledgeSearch.trim().toLowerCase();
    const availableDocuments = knowledgeIndex.documents.filter((document) => document.status === 'success');
    const selectedDocuments = draftKnowledgeDocumentIds
      .map((documentId) => knowledgeIndex.documents.find((document) => document.id === documentId))
      .filter((document): document is KnowledgeDocument => Boolean(document));
    const visibleFolders = knowledgeIndex.folders.flatMap((folder) => {
      const folderDocuments = availableDocuments.filter((document) => document.folder_id === folder.id);
      const folderMatched = keyword ? includesKeyword(folder.name, keyword) : false;
      const documents = keyword
        ? folderDocuments.filter((document) => folderMatched || includesKeyword(document.file_name, keyword))
        : folderDocuments;

      return documents.length ? [{ folder, documents }] : [];
    });
    const visibleDocumentCount = visibleFolders.reduce((total, group) => total + group.documents.length, 0);

    if (!availableDocuments.length) {
      return <div className="outline-knowledge-empty">暂无已完成的知识库文档，可先到知识库上传并处理完成后再选择。</div>;
    }

    return (
      <div className="outline-knowledge-compact">
        <div className="outline-knowledge-search-row">
          <input
            className="outline-knowledge-search"
            value={knowledgeSearch}
            onChange={(event) => setKnowledgeSearch(event.target.value)}
            disabled={knowledgePickingDisabled}
            placeholder="搜索文件夹或文档"
          />
          <span>{keyword ? `匹配 ${visibleDocumentCount} 个文档` : `共 ${availableDocuments.length} 个可用文档`}</span>
        </div>
        <div className="outline-knowledge-grid">
          <div className="outline-knowledge-browser">
            <div className="outline-knowledge-pane-head">
              <strong>知识库</strong>
              <span>{visibleFolders.length} 个文件夹</span>
            </div>
            <div className="outline-knowledge-folder-list compact">
              {visibleFolders.length ? visibleFolders.map(({ folder, documents }) => {
                const expanded = keyword ? true : expandedKnowledgeFolderIds.has(folder.id);
                const selectedCount = documents.filter((document) => draftKnowledgeDocumentIds.includes(document.id)).length;

                return (
                  <section className="outline-knowledge-folder compact" key={folder.id}>
                    <div className="outline-knowledge-folder-head compact">
                      <button type="button" onClick={() => toggleKnowledgeFolder(folder.id)} disabled={Boolean(keyword)} aria-expanded={expanded}>
                        <span>{expanded ? '▾' : '▸'}</span>
                        <strong>{folder.name}</strong>
                      </button>
                      <small>{documents.length} 个 / 已选 {selectedCount}</small>
                      <div className="outline-knowledge-folder-actions">
                        <button type="button" onClick={() => selectFolderDocuments(documents)} disabled={knowledgePickingDisabled}>全选</button>
                        <button type="button" onClick={() => clearFolderDocuments(documents)} disabled={knowledgePickingDisabled || !selectedCount}>取消</button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="outline-knowledge-document-list compact">
                        {documents.map((document) => {
                          const selected = draftKnowledgeDocumentIds.includes(document.id);

                          return (
                            <label className={`outline-knowledge-document compact${selected ? ' is-selected' : ''}`} key={document.id}>
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={knowledgePickingDisabled}
                                onChange={() => toggleDraftKnowledgeDocument(document)}
                              />
                              <strong title={document.file_name}>{document.file_name}</strong>
                              <small>{document.item_count || 0} 条</small>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              }) : <div className="outline-knowledge-empty compact">没有匹配的知识库文档</div>}
            </div>
          </div>
          <aside className="outline-knowledge-selected-pane">
            <div className="outline-knowledge-pane-head">
              <strong>本次已选</strong>
              <button type="button" onClick={clearDraftKnowledgeDocuments} disabled={knowledgePickingDisabled || !draftKnowledgeDocumentIds.length}>清空</button>
            </div>
            {selectedDocuments.length ? (
              <div className="outline-knowledge-selected-list">
                {selectedDocuments.map((document) => (
                  <div className="outline-knowledge-selected-item" key={document.id}>
                    <strong title={document.file_name}>{document.file_name}</strong>
                    <button type="button" onClick={() => removeDraftKnowledgeDocument(document.id)} disabled={knowledgePickingDisabled}>移除</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="outline-knowledge-empty compact">未选择知识库文档</div>
            )}
          </aside>
        </div>
      </div>
    );
  };

  return (
    <div className="plan-step-body outline-generation-page">
      <section className="outline-command-bar">
        <div>
          <span className="section-kicker">STEP 03</span>
          <strong>目录生成</strong>
          <p>{isExpansionWorkflow ? `当前原方案目录使用方式：${outlineExpansionModeLabels[outlineExpansionMode]}；参考知识库：${referenceKnowledgeDocumentIds.length ? `已选择 ${referenceKnowledgeDocumentIds.length} 个文档` : '未选择'}。` : `当前一级目录生成方式：${outlineModeLabels[outlineMode]}；参考知识库：${referenceKnowledgeDocumentIds.length ? `已选择 ${referenceKnowledgeDocumentIds.length} 个文档` : '未选择'}。`}</p>
        </div>
        <div className="outline-command-actions">
          <label className={`outline-wizard-switch${wizardMode ? ' is-active' : ''}`} title="分步向导：将目录生成拆分为多步，逐步确认与重试">
            <input type="checkbox" checked={wizardMode} onChange={(event) => setWizardMode(event.target.checked)} />
            <span className="outline-wizard-switch-track" aria-hidden="true">
              <span className="outline-wizard-switch-thumb" />
            </span>
            <span className="outline-wizard-switch-label">分步向导</span>
          </label>
          <button
            type="button"
            className="outline-config-action"
            onClick={openGenerationDialog}
            disabled={generating || sorting || contentMutationLocked || !projectOverview || !techRequirements}
            aria-label="打开目录生成配置"
            title="目录生成配置"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
            </svg>
          </button>
          <button type="button" className="primary-action" onClick={openGenerationDialog} disabled={generating || sorting || contentMutationLocked || !projectOverview || !techRequirements}>
            {generating ? 'AI 正在生成目录' : outlineData ? '重新生成目录' : '生成目录'}
          </button>
        </div>
      </section>

      {wizardMode && (
        <section className="outline-wizard-panel">
          <div className="outline-wizard-header">
            <div className="outline-wizard-title">
              <div className="outline-wizard-icon">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm-1 15.93V6.09a.5.5 0 0 1 .76-.43l7.49 5.92a.5.5 0 0 1 0 .84l-7.49 5.92a.5.5 0 0 1-.76-.43Z" />
                </svg>
              </div>
              <div>
                <strong>分步生成向导</strong>
                <span>{wizardStatusText}</span>
              </div>
            </div>
            <div className="outline-wizard-actions-global">
              {wizardDone && (
                <button type="button" className="outline-wizard-btn outline-wizard-btn-secondary" disabled={generating} onClick={() => runWizardStep(effectiveWizardSteps[0], { restart: true })}>
                  重新分步生成
                </button>
              )}
              {wizardActive && !wizardDone && (
                <button type="button" className="outline-wizard-btn outline-wizard-btn-secondary" disabled={generating} onClick={() => runWizardStep(effectiveWizardSteps[0], { restart: true })}>
                  重新开始
                </button>
              )}
              <button type="button" className="outline-wizard-btn outline-wizard-btn-ghost" onClick={() => setWizardMode(false)}>
                退出向导
              </button>
            </div>
          </div>

          <ol className="outline-wizard-steps">
            {effectiveWizardSteps.map((step, index) => {
              const isDone = index < wizardCurrentIndex;
              const isCurrent = index === wizardCurrentIndex;
              const isRunning = runningWizardStep === step;
              const isFailed = failedWizardStep === step;
              const isPending = index > wizardCurrentIndex;
              const isCurrentExecutable = isCurrent && !runningWizardStep;
              const stepNumber = index + 1;
              return (
                <li
                  key={step}
                  className={`outline-wizard-step${isDone ? ' is-done' : ''}${isCurrent ? ' is-current' : ''}${isRunning ? ' is-running' : ''}${isFailed ? ' is-failed' : ''}${isPending ? ' is-pending' : ''}`}
                >
                  <div className="outline-wizard-step-main">
                    <div className="outline-wizard-step-indicator" aria-label={isDone ? '已完成' : isCurrent ? '当前' : '待执行'}>
                      {isDone ? (
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M20.29 6.71a1 1 0 0 0-1.42 0l-8.88 8.88-3.88-3.88a1 1 0 1 0-1.42 1.42l4.59 4.59a1 1 0 0 0 1.42 0l9.59-9.59a1 1 0 0 0 0-1.42Z" />
                        </svg>
                      ) : isRunning ? (
                        <span className="outline-wizard-spinner" aria-hidden="true" />
                      ) : (
                        <span>{stepNumber}</span>
                      )}
                    </div>
                    <div className="outline-wizard-step-body">
                      <div className="outline-wizard-step-head">
                        <strong>{WIZARD_STEP_LABELS[step]}</strong>
                        {isRunning && (
                          <span className="outline-wizard-step-progress">{Math.max(0, Math.min(99, task?.progress || 0))}%</span>
                        )}
                        {isDone && <span className="outline-wizard-step-badge">已完成</span>}
                        {isFailed && <span className="outline-wizard-step-badge is-failed">失败</span>}
                      </div>
                      <p>{WIZARD_STEP_DESCRIPTIONS[step]}</p>
                      {isCurrentExecutable && (
                        <div className="outline-wizard-step-action">
                          <button
                            type="button"
                            className="outline-wizard-btn outline-wizard-btn-primary"
                            disabled={generating || !projectOverview || !techRequirements}
                            onClick={() => runWizardStep(step, { restart: false })}
                          >
                            {isFailed ? '重试此步' : '执行此步'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section className="outline-generation-workspace">
        <aside className="outline-progress-panel">
          <div className="analysis-result-head">
            <strong>生成过程</strong>
            <span>{statusText}</span>
          </div>
          <div className={`content-outline-stats outline-progress-summary${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>生成进度</span>
              <strong>{progress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <div className="content-generation-progress-track" aria-label={`目录生成进度 ${progress}%`}>
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p>{statusMessage}</p>
                {(elapsedText || staleText) && (
                  <div className="outline-progress-meta">
                    {elapsedText && <span>{elapsedText}</span>}
                    {staleText && <span>{staleText}</span>}
                  </div>
                )}
                {taskFailed && <small>{task?.error || latestLog || '目录生成失败'}</small>}
              </div>
            )}
          </div>
          <div className="outline-progress-log" ref={logListRef}>
            {progressLogs.length ? progressLogs.map((item, index) => (
              <p className={index === progressLogs.length - 1 ? 'is-latest' : ''} key={`${item}-${index}`}>{item}</p>
            )) : <p>等待生成任务启动。</p>}
          </div>
        </aside>

        <section className="outline-tree-panel">
          <div className="analysis-result-head outline-tree-head">
            <div>
              <strong>目录结构</strong>
              <span>{activeOutlineData?.outline?.length || 0} 个一级目录{sorting ? ' · 排序中' : ''}</span>
            </div>
            <div className="outline-tree-tools">
              {sorting ? (
                <>
                  <button type="button" className="outline-save-sort-action" onClick={() => { void saveSorting().catch((error) => showToast(error instanceof Error ? error.message : '保存排序失败', 'error')); }} disabled={savingSort}>
                    {savingSort ? '正在保存...' : '保存排序'}
                  </button>
                  <button type="button" onClick={expandAllItems} disabled={!activeOutlineData?.outline?.length}>全部展开</button>
                  <button type="button" onClick={collapseAllItems} disabled={!activeOutlineData?.outline?.length}>全部折叠</button>
                </>
              ) : (
                <>
                {outlineData && (
                <button type="button" className="outline-add-root-action" onClick={() => { void addRootItem(); }} disabled={outlineMutationLocked}>
                  添加一级目录
                </button>
                )}
                {outlineData && (
                  <button type="button" onClick={startSorting} disabled={outlineMutationLocked || !outlineData?.outline?.length}>目录排序</button>
                )}
                <button type="button" onClick={expandAllItems} disabled={!activeOutlineData?.outline?.length}>全部展开</button>
                <button type="button" onClick={collapseAllItems} disabled={!activeOutlineData?.outline?.length}>全部折叠</button>
                </>
              )}
            </div>
          </div>
          {activeOutlineData?.outline?.length ? (
            <div className={`outline-tree-list${sorting ? ' is-sorting' : ''}`}>
              {activeOutlineData.outline.map((item) => renderItem(item))}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>尚未生成目录</strong>
              <p>先完成招标文件解析，再生成技术方案目录。</p>
            </div>
          )}
        </section>

        <aside className="outline-detail-panel">
          <div className="analysis-result-head">
            <div>
              <strong>目录项详情</strong>
              <span>{selectedItem ? selectedItem.id : '未选择'}</span>
            </div>
          </div>
          {selectedItem ? (
            <div className="outline-detail-body">
              {(generating || contentMutationLocked || sorting) && (
                <div className="outline-detail-lock">
                  {sorting
                    ? '目录排序中，当前目录暂不可编辑。'
                    : contentMutationLocked
                      ? '正文生成任务正在运行或暂停中，当前目录暂不可编辑。'
                      : '目录生成任务正在运行，当前目录暂不可编辑，避免覆盖后台生成结果。'}
                </div>
              )}
              {editingItemId === selectedItem.id ? (
                <>
                  <label>
                    <span>标题</span>
                    <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} disabled={outlineMutationLocked || sorting} />
                  </label>
                  <label>
                    <span>描述</span>
                    <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} disabled={outlineMutationLocked || sorting} />
                  </label>
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => { void saveEditing(); }} disabled={outlineMutationLocked || sorting}>保存</button>
                    <button type="button" className="secondary-action" onClick={() => setEditingItemId(null)}>取消</button>
                  </div>
                </>
              ) : (
                <>
                  <h3>{selectedItem.title}</h3>
                  <p>{selectedItem.description || '无描述'}</p>
                  {selectedItem.source_requirement_title && (
                    <small>{outlineMode === 'response-file' ? '来源响应文件目录' : '来源评分项'}：{selectedItem.source_requirement_title}</small>
                  )}
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => startEditing(selectedItem)} disabled={outlineMutationLocked || sorting}>编辑</button>
                    <button type="button" className="secondary-action" onClick={() => { void addChildItem(selectedItem.id); }} disabled={outlineMutationLocked || sorting}>添加子目录</button>
                    <button type="button" className="danger-action" onClick={() => { void removeItem(selectedItem.id); }} disabled={outlineMutationLocked || sorting}>删除</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>选择一个目录项</strong>
              <p>在左侧目录树中选择章节后，可查看并编辑标题和描述。</p>
            </div>
          )}
        </aside>
      </section>

      <Dialog.Root open={generationDialogOpen} onOpenChange={setGenerationDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="outline-generation-config-card">
            <Dialog.Title className="sr-only">{outlineData ? '重新生成目录' : '生成目录'}</Dialog.Title>
            <Dialog.Description className="sr-only">选择本次目录生成方式、字数控制和参考知识库。</Dialog.Description>

            <div className="outline-generation-config-body">
              {/* 左栏：所有配置项 */}
              <div className="outline-generation-config-left">
                {renderOutlineExpansionModePicker()}
                {developerMode && (
                  <section className="outline-generation-config-section outline-agent-debug-section">
                    <label className="outline-agent-debug-option">
                      <span>
                        <strong>强制 Agent 修复目录</strong>
                        <small>本次目录生成会在最终保存前强制进入智能体修复链路，用于验证 Agent workspace、结果 JSON 和程序校验。</small>
                      </span>
                      <span className="yb-switch-control">
                        <input
                          type="checkbox"
                          checked={draftForceOutlineAgentRepair}
                          onChange={(event) => setDraftForceOutlineAgentRepair(event.target.checked)}
                        />
                        <span className="yb-switch-track" aria-hidden="true">
                          <span className="yb-switch-thumb" />
                        </span>
                      </span>
                    </label>
                  </section>
                )}
                <section className="outline-generation-config-section outline-word-control-section">
                  <div className="content-generation-config-row">
                    <span>
                      <strong>全文字数/页数预设</strong>
                      <small>在目录生成阶段，就要预设好全文生成的字数，默认0表示不控制</small>
                    </span>
                  </div>
                  <div className="outline-word-control-options">
                    <div className="outline-word-control-grid">
                      <label>
                        <span>最少字数（万）</span>
                        <input inputMode="decimal" value={draftMinimumWords} onChange={(event) => /^\d*(?:\.\d{0,4})?$/.test(event.target.value) && setDraftMinimumWords(event.target.value)} onBlur={() => setDraftMinimumWords(formatWordCountDraft(parseWordCountDraft(draftMinimumWords) ?? 0))} />
                      </label>
                      <label>
                        <span>最多字数（万）</span>
                        <input inputMode="decimal" value={draftMaximumWords} onChange={(event) => /^\d*(?:\.\d{0,4})?$/.test(event.target.value) && setDraftMaximumWords(event.target.value)} onBlur={() => setDraftMaximumWords(formatWordCountDraft(parseWordCountDraft(draftMaximumWords) ?? 0))} />
                      </label>
                      <label>
                        <span>每小节字数（万）</span>
                        <input inputMode="decimal" value={draftSectionWords} onChange={(event) => {
                          if (!/^\d*(?:\.\d{0,4})?$/.test(event.target.value)) return;
                          setDraftSectionWords(event.target.value);
                        }} onBlur={() => {
                          const sectionWords = parseWordCountDraft(draftSectionWords) ?? 0;
                          setDraftSectionWords(formatWordCountDraft(sectionWords));
                          if (sectionWords === 0) setDraftStrictSectionWords(false);
                        }} />
                      </label>
                    </div>
                    <small className="outline-word-control-help">
                      <span>填2代表20000字，0.15代表1500字，默认0表示不控制，AI默认生成多少就是多少。</span>
                      <span>如果<strong className="outline-word-control-highlight">您使用的不是gpt-5.6-sol</strong>，推荐按照您模型的能力上限填写每小节字数，否则扩写过程会非常漫长。</span>
                    </small>
                    <div className="content-generation-config-row">
                      <span>
                        <strong>强控小节字数</strong>
                        <small>{draftStrictSectionWords ? '强制控制每小节字数必须是预设值的正负 20%' : '仅控制总字数'}</small>
                      </span>
                      <Switch.Root className="content-generation-switch" checked={draftStrictSectionWords} onCheckedChange={setDraftStrictSectionWords} disabled={parsedDraftSectionWords === 0} aria-label="强控小节字数，允许范围为预设值的正负 20%">
                        <Switch.Thumb className="content-generation-switch-thumb" />
                      </Switch.Root>
                    </div>
                    <div className="outline-word-control-estimate">
                        <div className="outline-word-control-estimate-label">预估页数</div>
                        <div className="outline-word-control-estimate-value">
                          {estimatedPages === null ? (
                            <span className="outline-word-control-estimate-empty">--</span>
                          ) : (
                            <>
                              <span className="outline-word-control-estimate-number">{estimatedPages}</span>
                              <span className="outline-word-control-estimate-unit">页</span>
                            </>
                          )}
                        </div>
                        <div className="outline-word-control-estimate-hint">
                          {estimatedPages === null ? '请先设置总字数范围' : '页数和排版有关，无法精确预估'}
                        </div>
                      </div>
                    </div>
                  {configurationRequiresRegeneration && (
                    <div className="outline-word-control-notice">
                      {outlineModeRequiresRegeneration
                        ? '生成目录后若修改了一级目录生成方式，需要重新生成目录才能生效！'
                        : outlineWordControlSnapshot ? '生成目录后若修改了字数设置，需要重新生成目录才能生效！' : '当前目录缺少字数控制生效配置，请重新生成目录。'}
                    </div>
                  )}
                </section>
                {renderOutlineModePicker()}
              </div>
              {/* 右栏：知识库选择器 */}
              <section className="outline-generation-config-section outline-knowledge-picker">
                <div className="outline-generation-config-head">
                  <strong>参考知识库</strong>
                  <span>已选择 {draftKnowledgeDocumentIds.length} 个文档</span>
                </div>
                {renderKnowledgePicker()}
              </section>
            </div>

            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="secondary-action" onClick={() => { void saveOutlineConfig(); }} disabled={generating || contentMutationLocked || savingOutlineConfig}>
                {savingOutlineConfig ? '正在保存...' : '保存配置'}
              </button>
              <button type="button" className="primary-action" onClick={generateOutline} disabled={generating || contentMutationLocked || savingOutlineConfig || !projectOverview || !techRequirements}>
                {outlineData ? '重新生成目录' : '开始生成'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default OutlineEditPage;
