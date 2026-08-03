import { Profiler, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent, type DragEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { trackPageView } from '../../../shared/analytics/analytics';
import {
  isLibreOfficeRequiredMessage,
  MarkdownFullscreenViewer,
  MarkdownRenderer,
  useConfirmDialog,
  useDocumentParseNotice,
  useToast,
} from '../../../shared/ui';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseIndex, KnowledgeDocument, KnowledgeDocumentStatus, KnowledgeFolder, KnowledgeItem } from '../types';
import type { KbAuthStatus, KbTeamDocument, KbTeamFolder, KbTrashFolder, KbTrashDocument } from '../../../shared/types/ipc';
import { useAuth } from '../../../shared/auth/AuthContext';

declare global {
  interface Window {
    __knowledgeRenderDebugLogs?: Array<Record<string, unknown>>;
  }
}

const emptyIndex: KnowledgeBaseIndex = { folders: [], documents: [] };
const emptyDocuments: KnowledgeDocument[] = [];
const documentRenderBatchSize = 80;

// 方案 D：服务器类型适配到本地 KnowledgeDocument
function adaptServerFolder(server: KbTeamFolder): KnowledgeFolder {
  return {
    id: String(server.id),
    name: server.name,
    parent_id: server.parent_id == null || server.parent_id === '' ? null : String(server.parent_id),
    created_at: server.created_at || '',
    updated_at: server.created_at || '',
    owner_id: server.owner_id,
  };
}

// 临时类型：getLocalStatus 返回的字段少于 KnowledgeDocument
type LocalDocPartial = Pick<KnowledgeDocument, 'id' | 'status' | 'progress' | 'message' | 'item_count' | 'block_count' | 'filtered_block_count' | 'candidate_item_count' | 'file_name'>;

async function getLocalStatusSafe(documentId: string | number): Promise<LocalDocPartial | null> {
  try {
    return await window.yibiao?.knowledgeBase.getLocalStatus(String(documentId)) ?? null;
  } catch (err) {
    // 本地尚未建立分析记录（老文档/未分析过）是正常情况，不要阻断列表加载
    console.warn(`[KB] getLocalStatus failed for ${documentId}:`, err);
    return null;
  }
}

function adaptServerDocument(
  server: KbTeamDocument,
  localStatus: LocalDocPartial | null,
): KnowledgeDocument {
  const srv = server as Record<string, unknown>;
  // 团队库列表 API 在分析进行中只返回 pending/0（状态以 kb_analysis 为准，而 kb_analysis
  // 完成前无记录）；本地 store + hydrateTeamAnalysis（走 getAnalysisStatus 查 worker）才是
  // 真实进度来源，故 localStatus 优先于 API 返回的 srv.status/progress。
  const effectiveStatus = (localStatus?.status as KnowledgeDocumentStatus) || (srv.status as KnowledgeDocumentStatus) || 'pending';
  return {
    id: String(server.id),
    folder_id: String(server.folder_id || ''),
    file_name: String(server.title || server.file_name || server.name || server.original_name || '未知文档'),
    status: effectiveStatus,
    progress: (localStatus?.progress as number) ?? (srv.progress as number) ?? 0,
    message: (localStatus?.message as string) || (srv.message as string) || '等待同步',
    item_count: (srv.item_count as number) ?? localStatus?.item_count ?? 0,
    block_count: (srv.block_count as number) ?? localStatus?.block_count ?? 0,
    filtered_block_count: (srv.filtered_block_count as number) ?? localStatus?.filtered_block_count ?? 0,
    candidate_item_count: (srv.candidate_item_count as number) ?? localStatus?.candidate_item_count ?? 0,
    created_at: server.created_at || '',
    updated_at: server.created_at || '',
    uploaded_by_name: server.uploaded_by_name,
    uploaded_by: server.uploaded_by,
  };
}

// 个人库文档适配：master.sqlite 保存元数据，分析状态以服务器为准，本地 store 作为离线缓存补充。
function adaptPersonalDocument(
  server: KbTeamDocument,
  localStatus: LocalDocPartial | null,
): KnowledgeDocument {
  const srv = server as Record<string, unknown>;
  return {
    id: String(server.id),
    folder_id: String(server.folder_id || ''),
    file_name: ((srv.title || server.name || server.original_name || '未知文档') as string),
    status: (srv.status as KnowledgeDocumentStatus) || localStatus?.status || ('pending' as KnowledgeDocumentStatus),
    progress: (srv.progress as number) || localStatus?.progress || 0,
    message: (srv.message as string) || localStatus?.message || '等待同步',
    item_count: (srv.item_count as number) ?? localStatus?.item_count ?? 0,
    block_count: (srv.block_count as number) ?? localStatus?.block_count ?? 0,
    filtered_block_count: (srv.filtered_block_count as number) ?? localStatus?.filtered_block_count ?? 0,
    candidate_item_count: (srv.candidate_item_count as number) ?? localStatus?.candidate_item_count ?? 0,
    created_at: server.created_at || '',
    updated_at: ((srv.updated_at || server.created_at || '') as string),
    uploaded_by_name: ((srv.owner_name || server.uploaded_by_name || srv.uploaded_by) as string | undefined),
    uploaded_by: (srv.owner_id as string | number | undefined),
  };
}

const statusLabels: Record<KnowledgeDocument['status'], string> = {
  pending: '等待处理',
  queued: '排队中',
  copying: '复制文件',
  converting: '转换 Markdown',
  extracting: '提取条目',
  ready_for_matching: '待匹配',
  matching: '匹配段落',
  recovering: '补漏中',
  analyzing: 'AI 整理中',
  saving: '保存结果',
  processing: '服务器分析中',
  success: '完成',
  error: '失败',
  unknown: '未知',
};

// 回收站 24h 倒计时显示
// 服务端 deleted_at 为无时区 ISO 字符串（服务器本地时间），用户与服务器同处东八区，
// 直接按本地时间解析即可；若服务端返回带 Z/时区偏移的 ISO 字符串，Date.parse 也能正确处理。
function formatTrashRemaining(deletedAt?: string): string {
  if (!deletedAt) return '';
  const deletedMs = Date.parse(deletedAt.replace(' ', 'T'));
  if (Number.isNaN(deletedMs)) return '';
  const elapsedMs = Date.now() - deletedMs;
  const remainMs = 24 * 3600 * 1000 - elapsedMs;
  if (remainMs <= 0) return '已过期';
  const totalMin = Math.floor(remainMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `剩余 ${h} 小时 ${m} 分`;
}

// 文档上传信息副标题：上传人 + 上传时间
function formatUploadSubtitle(uploadedByName?: string, createdAt?: string): string {
  const who = uploadedByName || '未知';
  let when = '';
  if (createdAt) {
    const ms = Date.parse(createdAt.replace(' ', 'T'));
    if (!Number.isNaN(ms)) {
      const d = new Date(ms);
      const yyyy = d.getFullYear();
      const MM = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      when = `${yyyy}-${MM}-${dd} ${hh}:${mm}`;
    }
  }
  return when ? `${who} ${when} 上传` : `${who} 上传`;
}

type RenderDebugKind = 'item-source' | 'document-markdown' | 'document-items';

interface RenderDebugTrace {
  id: string;
  kind: RenderDebugKind;
  startedAt: number;
  documentId: string;
  documentName: string;
  itemId?: string;
  itemTitle?: string;
  contentLength: number;
  contentMetrics: Record<string, number>;
  longTasks: Array<Record<string, number | string>>;
  longTaskObserver?: PerformanceObserver;
  finished?: boolean;
}

let renderDebugSeq = 0;

const contentMetricKeys = [
  'chars',
  'lines',
  'htmlTags',
  'htmlTables',
  'htmlRows',
  'htmlCells',
  'markdownImages',
  'htmlImages',
  'importedAssets',
  'bareUrls',
  'markdownLinks',
] as const;

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}

function countMatches(text: string, pattern: RegExp) {
  return (text.match(pattern) || []).length;
}

function collectContentMetrics(content: string) {
  const text = String(content || '');
  return {
    chars: text.length,
    lines: text ? text.split(/\r?\n/).length : 0,
    htmlTags: countMatches(text, /<[^>]+>/g),
    htmlTables: countMatches(text, /<table\b/gi),
    htmlRows: countMatches(text, /<tr\b/gi),
    htmlCells: countMatches(text, /<(?:td|th)\b/gi),
    markdownImages: countMatches(text, /!\[[^\]]*\]\([^)]*\)/g),
    htmlImages: countMatches(text, /<img\b/gi),
    importedAssets: countMatches(text, /yibiao-asset:\/\/imported-images/gi),
    bareUrls: countMatches(text, /\b(?:https?:\/\/|www\.)[^\s)）]+/gi),
    markdownLinks: countMatches(text, /\[[^\]]{0,200}\]\([^)]{1,500}\)/g),
  };
}

function collectItemsContentMetrics(items: KnowledgeItem[]) {
  const totals: Record<string, number> = Object.fromEntries(contentMetricKeys.map((key) => [key, 0]));
  let totalTitleChars = 0;
  let totalResumeChars = 0;
  let maxItemContentLength = 0;
  let maxItemId = '';
  let maxItemTitle = '';
  let itemsWithHtml = 0;
  let itemsWithTables = 0;
  let itemsWithImages = 0;
  let itemsWithImportedAssets = 0;
  let itemsWithBareUrls = 0;

  items.forEach((item) => {
    const content = String(item.content || '');
    const metrics = collectContentMetrics(content);
    contentMetricKeys.forEach((key) => {
      totals[key] += metrics[key];
    });
    totalTitleChars += String(item.title || '').length;
    totalResumeChars += String(item.resume || '').length;
    if (metrics.chars > maxItemContentLength) {
      maxItemContentLength = metrics.chars;
      maxItemId = item.id;
      maxItemTitle = item.title;
    }
    if (metrics.htmlTags) itemsWithHtml += 1;
    if (metrics.htmlTables) itemsWithTables += 1;
    if (metrics.markdownImages || metrics.htmlImages) itemsWithImages += 1;
    if (metrics.importedAssets) itemsWithImportedAssets += 1;
    if (metrics.bareUrls) itemsWithBareUrls += 1;
  });

  const metrics: Record<string, number> = {
    ...totals,
    itemCount: items.length,
    totalTitleChars,
    totalResumeChars,
    maxItemContentLength,
    itemsWithHtml,
    itemsWithTables,
    itemsWithImages,
    itemsWithImportedAssets,
    itemsWithBareUrls,
  };

  return {
    metrics,
    maxItemId,
    maxItemTitle,
  };
}

function collectDomMetrics(element: HTMLElement | null) {
  if (!element) return {};
  return {
    domNodes: element.querySelectorAll('*').length,
    tables: element.querySelectorAll('table').length,
    rows: element.querySelectorAll('tr').length,
    cells: element.querySelectorAll('td, th').length,
    images: element.querySelectorAll('img').length,
    links: element.querySelectorAll('a').length,
    textChars: element.textContent?.length || 0,
    htmlChars: element.innerHTML.length,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

function logRenderDebug(trace: RenderDebugTrace | null | undefined, event: string, payload: Record<string, unknown> = {}) {
  if (!trace || trace.finished) return;
  const entry = {
    traceId: trace.id,
    kind: trace.kind,
    event,
    elapsedMs: roundMs(nowMs() - trace.startedAt),
    documentId: trace.documentId,
    itemId: trace.itemId,
    ...payload,
  };
  if (typeof window !== 'undefined') {
    window.__knowledgeRenderDebugLogs = window.__knowledgeRenderDebugLogs || [];
    window.__knowledgeRenderDebugLogs.push(entry);
  }
  console.info('[knowledge-render-debug]', entry);
}

function startLongTaskObserver(trace: RenderDebugTrace) {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        const task = {
          startMs: roundMs(entry.startTime - trace.startedAt),
          durationMs: roundMs(entry.duration),
          name: entry.name || 'longtask',
        };
        trace.longTasks.push(task);
        logRenderDebug(trace, 'longtask', task);
      });
    });
    observer.observe({ entryTypes: ['longtask'] });
    trace.longTaskObserver = observer;
  } catch (error) {
    logRenderDebug(trace, 'longtask:observer-unavailable', { message: error instanceof Error ? error.message : String(error) });
  }
}

function createRenderDebugTrace(kind: RenderDebugKind, document: KnowledgeDocument, content: string, item?: KnowledgeItem) {
  const trace: RenderDebugTrace = {
    id: `${kind}-${Date.now()}-${++renderDebugSeq}`,
    kind,
    startedAt: nowMs(),
    documentId: document.id,
    documentName: document.file_name,
    itemId: item?.id,
    itemTitle: item?.title,
    contentLength: String(content || '').length,
    contentMetrics: collectContentMetrics(content),
    longTasks: [],
  };
  startLongTaskObserver(trace);
  logRenderDebug(trace, 'trace:start', {
    documentName: trace.documentName,
    itemTitle: trace.itemTitle,
    contentLength: trace.contentLength,
    metrics: trace.contentMetrics,
  });
  console.table([{ traceId: trace.id, ...trace.contentMetrics }]);
  return trace;
}

function updateTraceContentMetrics(trace: RenderDebugTrace | null | undefined, content: string) {
  if (!trace || trace.finished) return;
  const metrics = collectContentMetrics(content);
  trace.contentLength = String(content || '').length;
  trace.contentMetrics = metrics;
  logRenderDebug(trace, 'content:metrics', {
    contentLength: trace.contentLength,
    metrics,
  });
}

function updateTraceItemsMetrics(trace: RenderDebugTrace | null | undefined, items: KnowledgeItem[]) {
  if (!trace || trace.finished) return;
  const { metrics, maxItemId, maxItemTitle } = collectItemsContentMetrics(items);
  trace.contentLength = metrics.chars;
  trace.contentMetrics = metrics;
  logRenderDebug(trace, 'items:metrics', {
    itemCount: items.length,
    contentLength: trace.contentLength,
    metrics,
    maxItemId,
    maxItemTitle,
  });
}

function finishRenderDebugTrace(trace: RenderDebugTrace | null | undefined, reason: string, payload: Record<string, unknown> = {}) {
  if (!trace || trace.finished) return;
  logRenderDebug(trace, 'trace:finish', {
    reason,
    totalMs: roundMs(nowMs() - trace.startedAt),
    longTaskCount: trace.longTasks.length,
    ...payload,
  });
  if (trace.longTasks.length) {
    console.table(trace.longTasks.map((task) => ({ traceId: trace.id, ...task })));
  }
  trace.longTaskObserver?.disconnect();
  trace.finished = true;
}

function logProfilerRender(
  trace: RenderDebugTrace | null | undefined,
  profilerId: string,
  phase: string,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
) {
  logRenderDebug(trace, 'react-profiler', {
    profilerId,
    phase,
    actualDurationMs: roundMs(actualDuration),
    baseDurationMs: roundMs(baseDuration),
    profilerStartMs: roundMs(startTime - (trace?.startedAt || 0)),
    profilerCommitMs: roundMs(commitTime - (trace?.startedAt || 0)),
  });
}

type KnowledgeViewer = {
  document: KnowledgeDocument;
  mode: 'analysis' | 'items' | 'markdown';
};

// E3：树状态（当前 tab + 选中文件夹）记忆到 localStorage
const KB_TREE_STATE_KEY = 'yibiao.kb.treeState';
function readTreeState(): { kbTab?: 'team' | 'personal'; activeFolderId?: string } {
  try {
    const raw = localStorage.getItem(KB_TREE_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function writeTreeState(state: { kbTab: 'team' | 'personal'; activeFolderId: string }) {
  try {
    localStorage.setItem(KB_TREE_STATE_KEY, JSON.stringify(state));
  } catch {
    /* noop */
  }
}

function KnowledgeBasePage() {
  const initialTreeState = readTreeState();
  const [index, setIndex] = useState<KnowledgeBaseIndex>(emptyIndex);
  const [activeFolderId, setActiveFolderId] = useState(initialTreeState.activeFolderId || '');
  const [listLoading, setListLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [authStatus, setAuthStatus] = useState<KbAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [kbTab, setKbTab] = useState<'team' | 'personal'>(initialTreeState.kbTab || 'team');
  const [viewer, setViewer] = useState<KnowledgeViewer | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerTrace, setViewerTrace] = useState<RenderDebugTrace | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState('');
  const [itemsPreview, setItemsPreview] = useState<KnowledgeItem[]>([]);
  const [analysisSnapshot, setAnalysisSnapshot] = useState<KnowledgeAnalysisSnapshot | null>(null);
  const [startingMatching, setStartingMatching] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [createAsSubfolder, setCreateAsSubfolder] = useState(false);
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: KnowledgeFolder; x: number; y: number } | null>(null);
  const [showMoveFolder, setShowMoveFolder] = useState(false);
  const [moveFolderTarget, setMoveFolderTarget] = useState<KnowledgeFolder | null>(null);
  const [selectedMoveParentId, setSelectedMoveParentId] = useState<string>('');
  const [syncing, setSyncing] = useState(false);
  const [showSyncToTeam, setShowSyncToTeam] = useState(false);
  const [teamFolderOptions, setTeamFolderOptions] = useState<KnowledgeFolder[]>([]);
  const [syncTargetFolderId, setSyncTargetFolderId] = useState('');
  const [showNewTeamFolderInput, setShowNewTeamFolderInput] = useState(false);
  const [newTeamFolderName, setNewTeamFolderName] = useState('');
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(() => new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(() => new Set());
  // 文件夹树折叠状态
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const toggleCollapseFolder = (folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };
  const createFolderInputRef = useRef<HTMLInputElement>(null);
  const newTeamFolderInputRef = useRef<HTMLInputElement>(null);
  // 服务器侧分析轮询器：docId -> setInterval 句柄。卸载时统一清理，避免泄漏。
  const analysisPollersRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const pollers = analysisPollersRef.current;
    return () => {
      pollers.forEach((handle) => window.clearInterval(handle));
      pollers.clear();
    };
  }, []);
  // 当前激活的 tab 引用：供轮询器/列表刷新判断是否为本库，避免串库覆盖
  const kbTabRef = useRef<'team' | 'personal'>(kbTab);
  useEffect(() => { kbTabRef.current = kbTab; }, [kbTab]);
  // 正在被轮询的文档集合：docId -> {tab, folderId}
  // 切页时只暂停轮询器（不清除本集合），切回后可恢复，避免进度丢失
  const pollingDocsRef = useRef<Map<string, { tab: 'team' | 'personal'; folderId: string }>>(new Map());

  useEffect(() => {
    if (showCreateFolder && createFolderInputRef.current) {
      // 先把操作系统焦点拉回主窗口（中文输入法需要窗口级焦点，否则输不进字）
      void window.yibiao?.focusMainWindow?.();
      // 延迟到下一帧布局完成后再聚焦输入框，规避 rAF 抢焦点与重渲染丢焦点
      const timer = window.setTimeout(() => {
        try {
          createFolderInputRef.current?.focus();
          createFolderInputRef.current?.select?.();
        } catch {
          /* 忽略聚焦异常 */
        }
      }, 60);
      return () => window.clearTimeout(timer);
    }
  }, [showCreateFolder]);

  // 「同步到团队」弹窗中新建文件夹输入框的聚焦：Radix Dialog 打开后焦点管理
  // 可能把焦点留在 Dialog 本身，导致输入框 autoFocus 失效，需要主动拉回。
  useEffect(() => {
    if (showNewTeamFolderInput && newTeamFolderInputRef.current) {
      void window.yibiao?.focusMainWindow?.();
      const timer = window.setTimeout(() => {
        try {
          newTeamFolderInputRef.current?.focus();
          newTeamFolderInputRef.current?.select?.();
        } catch {
          /* 忽略聚焦异常 */
        }
      }, 60);
      return () => window.clearTimeout(timer);
    }
  }, [showNewTeamFolderInput]);
  // 父子关系映射（用于折叠判断与折叠箭头）
  const folderParentMap = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const f of index.folders) map.set(f.id, f.parent_id ?? null);
    return map;
  }, [index.folders]);
  const folderChildrenMap = useMemo(() => {
    const map = new Map<string, KnowledgeFolder[]>();
    for (const f of index.folders) {
      if (f.parent_id) {
        const arr = map.get(f.parent_id) || [];
        arr.push(f);
        map.set(f.parent_id, arr);
      }
    }
    return map;
  }, [index.folders]);
  const isFolderVisible = (folderId: string): boolean => {
    let pid = folderParentMap.get(folderId) || null;
    while (pid) {
      if (collapsedFolders.has(pid)) return false;
      pid = folderParentMap.get(pid) || null;
    }
    return true;
  };

  // 按树形顺序排列可见文件夹，保证子文件夹紧跟在父文件夹下方，不会跑到其它根文件夹上面
  const visibleFoldersInTreeOrder = useMemo(() => {
    const result: KnowledgeFolder[] = [];
    const visited = new Set<string>();
    const appendWithChildren = (folder: KnowledgeFolder) => {
      if (visited.has(folder.id)) return;
      visited.add(folder.id);
      // 如果父级被折叠，该文件夹不可见，跳过
      let pid = folderParentMap.get(folder.id) || null;
      while (pid) {
        if (collapsedFolders.has(pid)) return;
        pid = folderParentMap.get(pid) || null;
      }
      result.push(folder);
      for (const child of folderChildrenMap.get(folder.id) || []) {
        appendWithChildren(child);
      }
    };
    // 先按原始顺序处理所有根文件夹
    for (const folder of index.folders) {
      if (!folder.parent_id) {
        appendWithChildren(folder);
      }
    }
    // 兜底：任何未访问过的可见文件夹（孤儿或父级不在列表中）
    for (const folder of index.folders) {
      if (!visited.has(folder.id)) {
        appendWithChildren(folder);
      }
    }
    return result;
  }, [index.folders, folderParentMap, folderChildrenMap, collapsedFolders]);

  // C5 搜索（name / content 双模式）
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'name' | 'content'>('name');
  const [searchActive, setSearchActive] = useState(false);
  const [searchResults, setSearchResults] = useState<KnowledgeDocument[]>([]);
  const [searching, setSearching] = useState(false);
  // C1 重命名
  const [showRename, setShowRename] = useState(false);
  const [renameTarget, setRenameTarget] = useState<KnowledgeFolder | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (showRename && renameInputRef.current) {
      const id = requestAnimationFrame(() => renameInputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [showRename]);
  // C1 重命名文档
  const [showDocRename, setShowDocRename] = useState(false);
  const [docRenameTarget, setDocRenameTarget] = useState<KnowledgeDocument | null>(null);
  const [docRenameValue, setDocRenameValue] = useState('');
  const [docRenaming, setDocRenaming] = useState(false);
  const docRenameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (showDocRename && docRenameInputRef.current) {
      const id = requestAnimationFrame(() => docRenameInputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [showDocRename]);
  // C2 导出
  const [exporting, setExporting] = useState(false);
  // C3 回收站
  const [showTrash, setShowTrash] = useState(false);
  const [trashData, setTrashData] = useState<{ folders: KbTrashFolder[]; documents: KbTrashDocument[] }>({ folders: [], documents: [] });
  const [trashLoading, setTrashLoading] = useState(false);
  // E2 拖拽
  const [dragDocId, setDragDocId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  // E1 批量操作
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [showBatchMove, setShowBatchMove] = useState(false);
  const [batchMoveTargetId, setBatchMoveTargetId] = useState('');
  // C4 删除确认弹窗：用 Radix Dialog 替代原生 window.confirm，避免 Electron 子窗口闪烁
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: 'document' | 'folder' | 'batch';
    title: string;
    message: string;
    document?: KnowledgeDocument;
    folderId?: string;
    folderName?: string;
  } | null>(null);
  const [deleteConfirmBusy, setDeleteConfirmBusy] = useState(false);

  const toggleSelectFolder = (folderId: string) => {
    const isSelecting = !selectedFolderIds.has(folderId);
    // 递归收集该文件夹下的所有子文件夹与文档
    const subtreeFolderIds = new Set<string>();
    const collectFolderIds = (id: string) => {
      subtreeFolderIds.add(id);
      for (const child of folderChildrenMap.get(id) || []) {
        collectFolderIds(child.id);
      }
    };
    collectFolderIds(folderId);
    const subtreeDocumentIds = new Set<string>();
    for (const doc of index.documents) {
      let fid: string | null = doc.folder_id;
      while (fid) {
        if (subtreeFolderIds.has(fid)) {
          subtreeDocumentIds.add(doc.id);
          break;
        }
        fid = folderParentMap.get(fid) ?? null;
      }
    }
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (isSelecting) {
        subtreeFolderIds.forEach((id) => next.add(id));
      } else {
        subtreeFolderIds.forEach((id) => next.delete(id));
      }
      return next;
    });
    setSelectedDocumentIds((prev) => {
      const next = new Set(prev);
      if (isSelecting) {
        subtreeDocumentIds.forEach((id) => next.add(id));
      } else {
        subtreeDocumentIds.forEach((id) => next.delete(id));
      }
      return next;
    });
  };
  const [retryingDocumentIds, setRetryingDocumentIds] = useState<Set<string>>(() => new Set());
  const [visibleDocumentCount, setVisibleDocumentCount] = useState(documentRenderBatchSize);
  const autoMatchingIdsRef = useRef(new Set<string>());
  const documentParseNoticeIdsRef = useRef(new Set<string>());
  const viewerRequestIdRef = useRef(0);
  const viewerTraceRef = useRef<RenderDebugTrace | null>(null);
  const { showToast } = useToast();
  const { confirm } = useConfirmDialog();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const auth = useAuth();

  const activeFolder = index.folders.find((folder) => folder.id === activeFolderId) || index.folders[0];
  // 切换 activeFolder 时自动展开其所有祖先，避免被折叠的父级隐藏当前文件夹
  useEffect(() => {
    if (!activeFolder) return;
    const ancestors: string[] = [];
    let pid = folderParentMap.get(activeFolder.id) || null;
    while (pid) {
      ancestors.push(pid);
      pid = folderParentMap.get(pid) || null;
    }
    if (ancestors.length === 0) return;
    setCollapsedFolders((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ancestors) {
        if (next.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeFolder, folderParentMap]);
  const documentsByFolder = useMemo(() => {
    const grouped = new Map<string, KnowledgeDocument[]>();
    index.documents.forEach((document) => {
      const folderDocuments = grouped.get(document.folder_id);
      if (folderDocuments) {
        folderDocuments.push(document);
        return;
      }
      grouped.set(document.folder_id, [document]);
    });
    return grouped;
  }, [index.documents]);
  const documents = activeFolder ? documentsByFolder.get(activeFolder.id) || emptyDocuments : emptyDocuments;
  // C5：搜索激活时展示跨文件夹搜索结果，否则展示当前文件夹文档
  const displayedDocuments = searchActive ? searchResults : documents;
  const visibleDocuments = displayedDocuments.slice(0, Math.min(visibleDocumentCount, displayedDocuments.length));
  // 处理中文档（非 success/error）禁止转移/导出/同步；选中文件夹时递归检查其下文档
  const isProcessingDocument = (status: KnowledgeDocument['status']) => status !== 'success' && status !== 'error';
  const hasSelectedProcessing = useMemo(() => {
    const selectedFolderIdSet = selectedFolderIds;
    for (const document of index.documents) {
      if (selectedDocumentIds.has(document.id) && isProcessingDocument(document.status)) return true;
      let fid: string | null = document.folder_id;
      while (fid) {
        if (selectedFolderIdSet.has(fid) && isProcessingDocument(document.status)) return true;
        fid = folderParentMap.get(fid) ?? null;
      }
    }
    return false;
  }, [index.documents, selectedDocumentIds, selectedFolderIds, folderParentMap]);

  // A1/A3：当前用户与删除权限判断
  const currentUserId = authStatus?.employee?.id;
  const isAdmin = authStatus?.employee?.role === 'admin';
  const canDeleteDoc = (document: KnowledgeDocument) => {
    if (isAdmin) return true;
    // 无 uploaded_by 信息时（老数据）保守放行，交由服务端最终裁决
    if (document.uploaded_by == null) return true;
    return String(document.uploaded_by) === String(currentUserId);
  };
  const canManageFolder = (folder: KnowledgeFolder | undefined | null) => {
    if (!folder) return false;
    if (isAdmin) return true;
    if (folder.owner_id == null) return true;
    return String(folder.owner_id) === String(currentUserId);
  };

  useEffect(() => {
    trackPageView(viewer ? `knowledge-base/viewer/${viewer.mode}` : `knowledge-base/${kbTab === 'team' ? 'team' : 'personal'}`);
  }, [viewer?.mode, kbTab]);

  // 切换 tab 时重新加载数据，并恢复当前 tab 下被暂停的轮询
  useEffect(() => {
    if (authStatus?.loggedIn) {
      if (kbTab === 'team') {
        void loadTeamTree();
      } else {
        void loadPersonalTree();
      }
      // 切回本 tab 时，恢复之前因切页而暂停的轮询器
      pollingDocsRef.current.forEach((meta, docId) => {
        if (meta.tab === kbTab && !analysisPollersRef.current.has(docId)) {
          if (kbTab === 'team') {
            startTeamAnalysisPolling(docId, meta.folderId);
          } else {
            startPersonalAnalysisPolling(docId, meta.folderId);
          }
        }
      });
    }
  }, [kbTab]);

  // 方案 D：启动时检查登录状态
  useEffect(() => {
    void checkAuthAndLoad();
    window.addEventListener('focus', loadDeveloperMode);
    document.addEventListener('visibilitychange', loadDeveloperMode);
    const unsubscribe = window.yibiao?.knowledgeBase.onEvent((event) => {
      if (event?.type === 'toast' && event.message) {
        showToast(event.message, event.level || 'info');
        return;
      }
      const { document } = event || {};
      if (!document) return;
      const parseMessage = document.error || document.message;
      if (document.status === 'error'
        && isLibreOfficeRequiredMessage(parseMessage)
        && !documentParseNoticeIdsRef.current.has(document.id)) {
        documentParseNoticeIdsRef.current.add(document.id);
        showDocumentParseNotice(parseMessage);
      }
      // 分析进度事件：更新本地 index 中的文档状态
      setIndex((prev) => ({
        ...prev,
        documents: prev.documents.some((item) => item.id === document.id)
          ? prev.documents.map((item) => (item.id === document.id ? { ...item, status: document.status, progress: document.progress, message: document.message, item_count: document.item_count, block_count: document.block_count, filtered_block_count: document.filtered_block_count, candidate_item_count: document.candidate_item_count } : item))
          : prev.documents,
      }));
      setViewer((prev) => (prev?.document.id === document.id ? { ...prev, document: { ...prev.document, status: document.status, progress: document.progress, message: document.message, item_count: document.item_count } } : prev));
      setAnalysisSnapshot((prev) => (prev?.document.id === document.id ? { ...prev, document } : prev));
    });
    return () => {
      window.removeEventListener('focus', loadDeveloperMode);
      document.removeEventListener('visibilitychange', loadDeveloperMode);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    setVisibleDocumentCount(documentRenderBatchSize);
  }, [activeFolder?.id, displayedDocuments.length, searchActive]);

  // 切换文件夹或标签时清空已勾选的同步项，避免串库
  useEffect(() => {
    setSelectedDocumentIds(new Set());
    setSelectedFolderIds(new Set());
  }, [activeFolderId, kbTab]);

  // E3：记忆当前 tab + 选中文件夹到 localStorage
  useEffect(() => {
    writeTreeState({ kbTab, activeFolderId });
  }, [kbTab, activeFolderId]);

  // 切换 tab / 文件夹时退出搜索态，避免展示串库结果
  useEffect(() => {
    setSearchActive(false);
    setSearchResults([]);
    setSearchQuery('');
  }, [kbTab]);

  // 点击或滚动时关闭文件夹右键菜单
  useEffect(() => {
    if (!folderMenu) return undefined;
    const close = () => setFolderMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [folderMenu]);

  useEffect(() => {
    if (visibleDocumentCount >= displayedDocuments.length) return undefined;
    const timeoutId = window.setTimeout(() => {
      startTransition(() => {
        setVisibleDocumentCount((count) => Math.min(count + documentRenderBatchSize, displayedDocuments.length));
      });
    }, 24);
    return () => window.clearTimeout(timeoutId);
  }, [displayedDocuments.length, visibleDocumentCount]);

  useEffect(() => {
    if (developerMode) return;
    const pendingDocuments = index.documents.filter((document) => document.status === 'ready_for_matching' && !autoMatchingIdsRef.current.has(document.id));
    pendingDocuments.forEach((document) => {
      autoMatchingIdsRef.current.add(document.id);
      void startMatching(document, { silent: true });
    });
  }, [developerMode, index.documents]);

  useEffect(() => {
    if (!developerMode && viewer?.mode === 'analysis') {
      viewerRequestIdRef.current += 1;
      setViewer(null);
      setViewerLoading(false);
      setAnalysisSnapshot(null);
    }
  }, [developerMode, viewer?.mode]);

  useEffect(() => {
    if ((!activeFolderId || !index.folders.some((folder) => folder.id === activeFolderId)) && index.folders[0]) {
      setActiveFolderId(index.folders[0].id);
    }
  }, [activeFolderId, index.folders]);

  useEffect(() => {
    if (viewer?.mode === 'analysis') {
      void loadAnalysis(viewer.document.id, { silent: true });
    }
  }, [viewer?.document.id, viewer?.document.status, viewer?.mode]);

  // 方案 D：检查登录状态并加载数据
  const checkAuthAndLoad = async () => {
    try {
      setAuthLoading(true);
      const status = await window.yibiao?.kbAuth.getStatus();
      setAuthStatus(status);
      if (status?.loggedIn) {
        if (kbTab === 'team') {
          await loadTeamTree();
        } else {
          await loadPersonalTree();
        }
      }
    } catch (error) {
      console.warn('检查团队库登录状态失败', error);
    } finally {
      setAuthLoading(false);
    }
  };

  // 从服务器获取文件夹+文档列表，合并本地分析状态
  const loadTeamTree = async () => {
    try {
      setListLoading(true);
      const result = await window.yibiao?.kbTeam.getTree();
      if (!result?.success || !result.data) {
        if (result?.needLogin) {
          // 会话失效：统一交给全局登录门禁处理
          showToast('登录已过期，请重新登录', 'error');
          void auth.logout();
        } else if (result?.error) {
          showToast(result.error, 'error');
        }
        return;
      }
      const { folders: serverFolders, documents: serverDocuments } = result.data;
      // 为每个文档检查本地分析状态；团队库若本机无分析，尝试从服务器拉取共享分析结果水合到本地库
      const documents = await Promise.all(
        serverDocuments.map(async (doc) => {
          let localStatus = await getLocalStatusSafe(doc.id);
          // 团队库：本地未完成（或非 success）时尝试从服务器水合共享分析。
          // 真正的覆盖决策由主进程 hydrateTeamAnalysis 守护：若本地分析任务仍在活跃运行，
          // 它会直接返回本地状态，避免服务器尚无共享分析时返回 null 把进度覆盖回「等待处理」。
          if (kbTab === 'team' && (!localStatus || localStatus.status !== 'success')) {
            try {
              localStatus = (await window.yibiao?.knowledgeBase.hydrateTeamAnalysis(doc.id, doc.folder_id ?? '')) ?? null;
            } catch {
              localStatus = null;
            }
          }
          return adaptServerDocument(doc, localStatus);
        }),
      );
      const folders = serverFolders.map(adaptServerFolder);
      // 保留正在轮询文档的实时进度，避免被本地陈旧状态覆盖
      setIndex((prev) => ({
        folders,
        documents: documents.map((doc) => {
          if (pollingDocsRef.current.has(String(doc.id))) {
            const prevDoc = prev.documents.find((d) => d.id === doc.id);
            if (prevDoc && prevDoc.status !== 'success' && (prevDoc.progress || prevDoc.status)) {
              return { ...doc, status: prevDoc.status, progress: prevDoc.progress, message: prevDoc.message };
            }
          }
          return doc;
        }),
      }));
      setActiveFolderId((currentId) => (
        folders.some((folder) => folder.id === currentId) ? currentId : folders[0]?.id || ''
      ));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取团队库失败', 'error');
    } finally {
      setListLoading(false);
    }
  };

  // 从服务器获取个人库文件夹+文档列表（master.sqlite，已有分析状态）
  const loadPersonalTree = async () => {
    try {
      setListLoading(true);
      const result = await window.yibiao?.kbPersonal.getTree();
      if (!result?.success || !result.data) {
        if (result?.needLogin) {
          showToast('登录已过期，请重新登录', 'error');
          void auth.logout();
        } else if (result?.error) {
          showToast(result.error, 'error');
        }
        return;
      }
      const { folders: serverFolders, documents: serverDocuments } = result.data;
      const folders = serverFolders.map(adaptServerFolder);
      // 个人库文档分析在本地 store 完成，需合并本地状态；
      // 从团队库同步过来的文档本地可能尚无记录，需从服务器水合共享分析结果。
      const documents = await Promise.all(
        serverDocuments.map(async (doc) => {
          let localStatus = await getLocalStatusSafe(doc.id);
          // 团队库同步过来的文档 ID 为 team-<id>-<user>，其分析结果以服务器为准。
          // 本地记录若只有 success 状态但无条目（item_count=0），说明是脏/旧记录，
          // 需要重新从服务器水合，否则会出现「完成/未分析」且查看内容空白。
          const needsHydrate =
            !localStatus ||
            localStatus.status !== 'success' ||
            (String(doc.id).startsWith('team-') && (localStatus.item_count || 0) === 0);
          if (needsHydrate) {
            try {
              localStatus = (await window.yibiao?.knowledgeBase.hydratePersonalAnalysis(doc.id, doc.folder_id ?? '')) ?? null;
            } catch {
              localStatus = null;
            }
          }
          return adaptPersonalDocument(doc, localStatus);
        }),
      );
      // 保留正在轮询文档的实时进度，避免被本地陈旧状态覆盖
      setIndex((prev) => ({
        folders,
        documents: documents.map((doc) => {
          if (pollingDocsRef.current.has(String(doc.id))) {
            const prevDoc = prev.documents.find((d) => d.id === doc.id);
            if (prevDoc && prevDoc.status !== 'success' && (prevDoc.progress || prevDoc.status)) {
              return { ...doc, status: prevDoc.status, progress: prevDoc.progress, message: prevDoc.message };
            }
          }
          return doc;
        }),
      }));
      setActiveFolderId((currentId) => (
        folders.some((folder: KnowledgeFolder) => folder.id === currentId) ? currentId : folders[0]?.id || ''
      ));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取个人库失败', 'error');
    } finally {
      setListLoading(false);
    }
  };

  const loadDeveloperMode = async () => {
    try {
      const config = await window.yibiao?.config.load();
      setDeveloperMode(Boolean(config?.developer_mode));
    } catch (error) {
      console.warn('读取开发者模式失败', error);
      setDeveloperMode(false);
    }
  };

  const loadAnalysis = async (documentId: string, options?: { silent?: boolean }) => {
    try {
      const data = await window.yibiao?.knowledgeBase.readAnalysis(documentId);
      if (data) setAnalysisSnapshot(data);
    } catch (error) {
      if (!options?.silent) {
        showToast(error instanceof Error ? error.message : '读取分析结果失败', 'error');
      }
    }
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      showToast('请输入文件夹名称', 'info');
      return;
    }
    const parentId = newFolderParentId || (createAsSubfolder && activeFolder ? activeFolder.id : undefined);
    try {
      setCreatingFolder(true);
      const result = kbTab === 'team'
        ? await window.yibiao?.kbTeam.createFolder(name, parentId)
        : await window.yibiao?.kbPersonal.createFolder(name, parentId ?? null);
      if (!result?.success || !result.data) {
        throw new Error(result?.error || '创建文件夹失败');
      }
      const folder = adaptServerFolder(result.data as KbTeamFolder);
      setIndex((prev) => ({ ...prev, folders: [...prev.folders, folder] }));
      setActiveFolderId(folder.id);
      setNewFolderName('');
      setCreateAsSubfolder(false);
      setNewFolderParentId(null);
      setShowCreateFolder(false);
      showToast(parentId ? '子文件夹已创建' : '文件夹已创建', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '创建文件夹失败', 'error');
    } finally {
      setCreatingFolder(false);
    }
  };

  // 勾选/取消勾选单个文档（用于双向同步）
  const toggleSelect = (id: string) => {
    setSelectedDocumentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 全选/取消全选当前展示的文档（含搜索结果）
  const toggleSelectAll = (checked: boolean) => {
    setSelectedDocumentIds((prev) => {
      const next = new Set(prev);
      displayedDocuments.forEach((document) => {
        if (checked) next.add(document.id);
        else next.delete(document.id);
      });
      return next;
    });
  };

  // 拉取团队库文件夹列表（供「同步到团队」选择目标）
  const fetchTeamFolders = async () => {
    try {
      const result = await window.yibiao?.kbTeam.getTree();
      if (result?.success && result.data) {
        setTeamFolderOptions(result.data.folders.map(adaptServerFolder));
      }
    } catch (error) {
      console.warn('获取团队文件夹失败', error);
    }
  };

  // 打开「同步到团队」对话框（个人库 → 团队库）
  const openSyncToTeam = async () => {
    if (selectedDocumentIds.size === 0 && selectedFolderIds.size === 0) {
      showToast('请先勾选要同步到团队的文档或文件夹', 'info');
      return;
    }
    if (hasSelectedProcessing) {
      showToast('处理中文档不可同步到团队', 'info');
      return;
    }
    await fetchTeamFolders();
    setSyncTargetFolderId('');
    setShowSyncToTeam(true);
  };

  // 在「同步到团队」弹窗中新建团队库文件夹
  const handleCreateTeamFolder = async () => {
    const name = newTeamFolderName.trim();
    if (!name) { showToast('请输入文件夹名称', 'info'); return; }
    try {
      const res = await window.yibiao?.kbTeam.createFolder(name, undefined);
      if (res?.success && res.data) {
        showToast(`已创建团队文件夹「${name}」`, 'success');
        setNewTeamFolderName('');
        setShowNewTeamFolderInput(false);
        await fetchTeamFolders();
        // 选中新创建的文件夹
        if (res.data.id) setSyncTargetFolderId(String(res.data.id));
      } else {
        throw new Error(res?.error || '创建失败');
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '创建团队文件夹失败', 'error');
    }
  };

  // 确认将选中的个人文档同步到团队库（目标文件夹留空则自动创建）
  const confirmSyncToTeam = async () => {
    try {
      setSyncing(true);
      const ids = Array.from(selectedDocumentIds);
      const folderIds = Array.from(selectedFolderIds);
      const result = await window.yibiao?.kbPersonal.importToTeam(ids, syncTargetFolderId || '', folderIds);
      if (!result?.success) throw new Error(result?.error || '同步到团队失败');
      const created = result.data?.created?.length || 0;
      const failed = result.data?.failed?.length || 0;
      const autoName = result.data?.auto_folder ? result.data?.folder_name : null;
      const targetFolderId = result.data?.folder_id ? String(result.data.folder_id) : '';
      const tail = failed ? `，${failed} 个失败` : '';
      setSelectedDocumentIds(new Set());
      setSelectedFolderIds(new Set());
      setShowSyncToTeam(false);
      // 自动切到团队库并选中目标文件夹，让用户立即看到同步结果
      setKbTab('team');
      await loadTeamTree();
      if (targetFolderId) setActiveFolderId(targetFolderId);
      await loadTeamTree();
      // 服务器侧分析：同步到团队的文档若个人库已有分析结果则直接复制（不需要重跑 Worker），
      // 否则启动轮询器等待服务器 Worker 自动分析。
      const analyzeErrors: string[] = [];
      let syncedAnalysisCount = 0;
      if (targetFolderId) {
        for (const item of result.data?.created || []) {
          if (!item.remote_id) {
            analyzeErrors.push(`文档「${item.file_name || item.document_id}」缺少同步信息，跳过`);
            continue;
          }
          const itemSynced = (item as any)?.analysis_synced;
          if (itemSynced) {
            syncedAnalysisCount += 1;
            // 分析已同步，主动水合到本地库，避免 loadTeamTree 异步水合前显示「等待处理」
            try {
              await window.yibiao?.knowledgeBase.hydrateTeamAnalysis(String(item.remote_id), targetFolderId);
            } catch {
              /* 主动水合失败仍由 loadTeamTree 兜底 */
            }
          } else {
            startTeamAnalysisPolling(String(item.remote_id), targetFolderId);
          }
        }
      }
      const syncMsg = `已同步 ${created} 个文档到团队${autoName ? `（自动创建文件夹「${autoName}」）` : ''}${tail}`;
      showToast(syncMsg, 'success');
      if (syncedAnalysisCount) {
        showToast(`已同步 ${syncedAnalysisCount} 个文档的分析结果，无需重新分析`, 'success');
      }
      // 立即刷新，让新文档以「分析中」出现（后续状态由轮询器驱动刷新）
      window.setTimeout(() => { void loadTeamTree(); }, 2000);
      if (analyzeErrors.length) {
        showToast(`已同步 ${created} 个文档，但 ${analyzeErrors.length} 个缺少同步信息`, 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '同步到团队失败', 'error');
    } finally {
      setSyncing(false);
    }
  };

  // 将选中的团队文档同步到个人库（团队库 → 个人库）
  const syncFromTeam = async () => {
    if (selectedDocumentIds.size === 0 && selectedFolderIds.size === 0) {
      showToast('请先勾选要同步到个人的文档或文件夹', 'info');
      return;
    }
    if (hasSelectedProcessing) {
      showToast('处理中文档不可同步到个人', 'info');
      return;
    }
    const ok = await confirm({
      title: '同步到个人知识库',
      message: `确定将选中的 ${selectedDocumentIds.size} 个文档同步到个人知识库吗？`,
      variant: 'primary',
      confirmText: '同步',
    });
    if (!ok) return;
    try {
      setSyncing(true);
      const ids = Array.from(selectedDocumentIds);
      const folderIds = Array.from(selectedFolderIds);
      const result = await window.yibiao?.kbPersonal.importFromTeam(ids, folderIds);
      if (!result?.success) throw new Error(result?.error || '同步到个人失败');
      const syncedItems = (result.data?.synced || []).filter((item) => item.ok);
      const synced = syncedItems.length;
      const targetFolderId = syncedItems[0]?.folder_id || `team-import-${authStatus?.employee?.id ?? ''}`;

      if (synced === 0) {
        showToast('选中的文件夹内没有文档，未同步任何内容', 'info');
        if (kbTab === 'team') await loadTeamTree();
        return;
      }

      showToast(`已同步 ${synced} 个文档到个人知识库（位于“团队库导入”文件夹）`, 'success');

      // 同步后自动切到个人库并选中“团队库导入”文件夹，避免用户以为没同步
      setKbTab('personal');
      await loadPersonalTree();
      if (targetFolderId) setActiveFolderId(targetFolderId);
      await loadPersonalTree();

      // 分析走服务器：同步时服务端已把团队库现有分析结果复制到个人库；
      // 对每篇启动个人库轮询。注意：从团队库同步来的文档 ID 形如 team-<id>-<user>，
      // 其分析已随同步复制到个人库，个人库 Worker 不会再处理它，无需轮询（轮询会
      // 被服务端 status 接口直接判定为 success 并停止，这里干脆跳过以减少干扰）。
      for (const item of syncedItems) {
        const pid = item.personal_id ? String(item.personal_id) : '';
        if (pid && !pid.startsWith('team-')) {
          startPersonalAnalysisPolling(pid, String(item.folder_id || targetFolderId || ''));
        }
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '同步到个人失败', 'error');
    } finally {
      setSyncing(false);
    }
  };

  /**
   * 启动服务器侧团队库分析轮询：上传后由服务器 Worker 分析，客户端轮询 status，
   * 分析完成后从服务器水合共享结果到本地库并刷新树。
   * 不再依赖本地 LibreOffice/AI 分析管道。
   */
  const startTeamAnalysisPolling = (documentId: string, folderId: string) => {
    const docId = String(documentId);
    // 已有轮询器则不重复启动
    if (analysisPollersRef.current.has(docId)) return;
    pollingDocsRef.current.set(docId, { tab: 'team', folderId: String(folderId || '') });

    const POLL_INTERVAL = 3000;
    const MAX_ATTEMPTS = 200; // ~10 分钟兜底，防大文件冷启动挂死
    let attempts = 0;

    // 暂停：切页等非终态场景只清 interval，保留 pollingDocsRef 以便切回恢复
    const pause = () => {
      const handle = analysisPollersRef.current.get(docId);
      if (handle !== undefined) {
        window.clearInterval(handle);
        analysisPollersRef.current.delete(docId);
      }
    };

    // 停止：终态/出错/超时时彻底清理
    const stop = () => {
      pause();
      pollingDocsRef.current.delete(docId);
    };

    // 把服务器轮询到的实时状态/进度/统计写入 index，让进度条与统计实时可见（不整树刷新，避免闪烁）
    const applyLive = (
      status: KnowledgeDocument['status'],
      progress?: number,
      message?: string,
      stats?: { item_count?: number; candidate_item_count?: number; block_count?: number; filtered_block_count?: number },
    ) => {
      setIndex((prev) => ({
        ...prev,
        documents: prev.documents.map((item) =>
          item.id === docId
            ? {
                ...item,
                status,
                progress: progress ?? item.progress,
                message: message ?? item.message,
                item_count: stats?.item_count ?? item.item_count,
                candidate_item_count: stats?.candidate_item_count ?? item.candidate_item_count,
                block_count: stats?.block_count ?? item.block_count,
                filtered_block_count: stats?.filtered_block_count ?? item.filtered_block_count,
              }
            : item
        ),
      }));
    };

    const tick = async () => {
      attempts += 1;
      // 已切换到其他库：暂停本库轮询，避免串库写 index；保留 pollingDocsRef 切回恢复
      if (kbTabRef.current !== 'team') {
        pause();
        return;
      }
      try {
        const res = await window.yibiao?.kbTeam.getAnalysisStatus(docId);
        if (!res?.success) {
          // needLogin / 网络错误：停止轮询，交给列表刷新兜底
          if (res?.needLogin) stop();
          if (attempts >= MAX_ATTEMPTS) stop();
          return;
        }
        const status = (res.data?.status || 'idle') as KnowledgeDocument['status'];
        const progress = res.data?.progress;
        const message = res.data?.message;
        const stats = {
          item_count: res.data?.item_count,
          candidate_item_count: res.data?.candidate_item_count,
          block_count: res.data?.block_count,
          filtered_block_count: res.data?.filtered_block_count,
        };
        if (status === 'success') {
          applyLive('success', 100, message, stats);
          stop();
          // 从服务器水合共享分析到本地库，然后刷新树显示最终状态
          try {
            await window.yibiao?.knowledgeBase.hydrateTeamAnalysis(docId, folderId ?? '');
          } catch {
            /* 水合失败也刷新，loadTeamTree 内部会再次尝试 hydrate */
          }
          await loadTeamTree();
        } else if (status === 'error') {
          applyLive('error', progress, message, stats);
          stop();
          await loadTeamTree();
          showToast('服务器分析该文档失败，可在文档菜单重试', 'error');
        } else {
          // pending / processing：实时写入进度与统计（仅更新该文档，不整树刷新，避免闪烁）
          applyLive(status, progress, message, stats);
          if (attempts >= MAX_ATTEMPTS) {
            stop();
            await loadTeamTree();
          }
        }
      } catch {
        if (attempts >= MAX_ATTEMPTS) stop();
      }
    };

    const handle = window.setInterval(() => { void tick(); }, POLL_INTERVAL);
    analysisPollersRef.current.set(docId, handle);
    // 立即触发一次，缩短首屏等待
    void tick();
  };

  // 个人库分析轮询：镜像团队库逻辑，走个人库端点。
  // 个人库 status 端点不返 404，Worker 不可达时返回 'unknown'，落入 else 分支继续轮询直至兜底。
  const startPersonalAnalysisPolling = (documentId: string, folderId: string) => {
    const docId = String(documentId);
    if (analysisPollersRef.current.has(docId)) return;
    pollingDocsRef.current.set(docId, { tab: 'personal', folderId: String(folderId || '') });

    const POLL_INTERVAL = 3000;
    const MAX_ATTEMPTS = 200; // ~10 分钟兜底
    let attempts = 0;

    const pause = () => {
      const handle = analysisPollersRef.current.get(docId);
      if (handle !== undefined) {
        window.clearInterval(handle);
        analysisPollersRef.current.delete(docId);
      }
    };

    const stop = () => {
      pause();
      pollingDocsRef.current.delete(docId);
    };

    // 把服务器轮询到的实时状态/进度/统计写入 index，让进度条与统计实时可见（不整树刷新，避免闪烁）
    const applyLive = (
      status: KnowledgeDocument['status'],
      progress?: number,
      message?: string,
      stats?: { item_count?: number; candidate_item_count?: number; block_count?: number; filtered_block_count?: number },
    ) => {
      setIndex((prev) => ({
        ...prev,
        documents: prev.documents.map((item) =>
          item.id === docId
            ? {
                ...item,
                status,
                progress: progress ?? item.progress,
                message: message ?? item.message,
                item_count: stats?.item_count ?? item.item_count,
                candidate_item_count: stats?.candidate_item_count ?? item.candidate_item_count,
                block_count: stats?.block_count ?? item.block_count,
                filtered_block_count: stats?.filtered_block_count ?? item.filtered_block_count,
              }
            : item
        ),
      }));
    };

    const tick = async () => {
      attempts += 1;
      // 已切换到其他库：暂停本库轮询，避免串库写 index；保留 pollingDocsRef 切回恢复
      if (kbTabRef.current !== 'personal') {
        pause();
        return;
      }
      try {
        const res = await window.yibiao?.kbPersonal.getAnalysisStatus(docId);
        if (!res?.success) {
          if (res?.needLogin) stop();
          if (attempts >= MAX_ATTEMPTS) stop();
          return;
        }
        const status = (res.data?.status || 'idle') as KnowledgeDocument['status'];
        const progress = res.data?.progress;
        const message = res.data?.message;
        const stats = {
          item_count: res.data?.item_count,
          candidate_item_count: res.data?.candidate_item_count,
          block_count: res.data?.block_count,
          filtered_block_count: res.data?.filtered_block_count,
        };
        if (status === 'success') {
          applyLive('success', 100, message, stats);
          stop();
          try {
            await window.yibiao?.knowledgeBase.hydratePersonalAnalysis(docId, folderId ?? '');
          } catch {
            /* 水合失败也刷新 */
          }
          await loadPersonalTree();
        } else if (status === 'error') {
          applyLive('error', progress, message, stats);
          stop();
          await loadPersonalTree();
          showToast('服务器分析该文档失败，可在文档菜单重试', 'error');
        } else {
          // pending / processing / unknown：实时写入进度与统计（仅更新该文档，不整树刷新，避免闪烁）
          applyLive(status, progress, message, stats);
          if (attempts >= MAX_ATTEMPTS) {
            stop();
            await loadPersonalTree();
          }
        }
      } catch {
        if (attempts >= MAX_ATTEMPTS) stop();
      }
    };

    const handle = window.setInterval(() => { void tick(); }, POLL_INTERVAL);
    analysisPollersRef.current.set(docId, handle);
    void tick();
  };

  const uploadDocuments = async (targetFolder = activeFolder) => {
    if (!targetFolder) {
      showToast('请先创建文件夹', 'info');
      return;
    }
    try {
      setLoading(true);
      // 个人库：批量上传，服务器已自动触发 Worker 分析，客户端只轮询状态并水合结果。
      if (kbTab === 'personal') {
        const result = await window.yibiao?.kbPersonal.uploadDocument(targetFolder.id);
        if (!result?.success) {
          if (result?.data?.canceled) return;
          throw new Error(result?.error || '上传文档失败');
        }
        const uploaded = result.data?.uploaded || [];
        const uploadedCount = uploaded.length || 0;
        const failedCount = result.data?.failed?.length || 0;
        if (uploadedCount) {
          for (const entry of uploaded) {
            const doc = entry.doc;
            if (!doc?.id) continue;
            startPersonalAnalysisPolling(String(doc.id), String(targetFolder.id));
          }
          await loadPersonalTree();
          showToast(`已上传 ${uploadedCount} 个文档，服务器分析中${failedCount ? `，${failedCount} 个失败` : ''}`, 'success');
        } else if (failedCount) {
          showToast(`上传失败：${result.data?.failed?.map((entry) => entry.file).join('、')}`, 'error');
        }
        return;
      }
      const result = await window.yibiao?.kbTeam.uploadDocument(targetFolder.id);
      if (!result?.success) {
        if (result?.canceled) return;
        throw new Error(result?.error || '上传文档失败');
      }
      if (result.uploaded?.length) {
        // 服务器侧分析：上传后由服务器 Worker 自动分析，客户端只需轮询状态并水合结果。
        // 不再下载文件到本地做 LibreOffice/AI 分析。
        for (const doc of result.uploaded) {
          if (!doc?.id) continue;
          startTeamAnalysisPolling(String(doc.id), String(targetFolder.id));
        }
        // 先刷新一次列表让新文档以「分析中」状态出现
        await loadTeamTree();
        showToast(`已上传 ${result.uploaded.length} 个文档，服务器分析中${result.errors?.length ? `，${result.errors.length} 个失败` : ''}`, 'success');
      } else if (result.errors?.length) {
        showToast(`上传失败：${result.errors.map((e) => e.file).join('、')}`, 'error');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传文档失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const confirmDeleteFolder = (folderId: string, folderName: string) => {
    const count = documentsByFolder.get(folderId)?.length || 0;
    setDeleteConfirm({
      type: 'folder',
      title: '删除文件夹',
      message: `确定删除文件夹"${folderName}"吗？其中 ${count} 个文档也会一起删除。`,
      folderId,
      folderName,
    });
  };

  const doDeleteFolder = async (folderId: string, folderName: string) => {
    try {
      const result = kbTab === 'team'
        ? await window.yibiao?.kbTeam.deleteFolder(folderId)
        : await window.yibiao?.kbPersonal.deleteFolder(folderId);
      if (!result?.success) {
        throw new Error(result?.error || '删除文件夹失败');
      }
      // 团队库需清除该文件夹下文档的本地分析数据（包括子文件夹中的文档）
      if (kbTab === 'team') {
        const collectSubtreeIds = (rootId: string): string[] => {
          const ids = [rootId];
          for (const f of index.folders) {
            if (f.parent_id && ids.includes(f.parent_id)) {
              ids.push(f.id);
            }
          }
          return ids;
        };
        const subtreeIds = collectSubtreeIds(folderId);
        for (const doc of index.documents) {
          if (subtreeIds.includes(doc.folder_id)) {
            await window.yibiao?.knowledgeBase.deleteLocalAnalysis(doc.id);
          }
        }
      }
      // 服务端会级联软删子文件夹，前端必须重新加载树，否则子文件夹会残留为“删不掉”的幽灵项
      if (kbTab === 'team') {
        await loadTeamTree();
      } else {
        await loadPersonalTree();
      }
      showToast('文件夹已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除文件夹失败', 'error');
    }
  };

  const confirmDeleteDocument = (document: KnowledgeDocument) => {
    if (!canDeleteDoc(document)) {
      showToast('只能删除自己上传的文档', 'info');
      return;
    }
    setDeleteConfirm({
      type: 'document',
      title: '删除文档',
      message: `确定删除文档"${document.file_name}"吗？`,
      document,
    });
  };

  const doDeleteDocument = async (document: KnowledgeDocument) => {
    try {
      const result = kbTab === 'team'
        ? await window.yibiao?.kbTeam.deleteDocument(document.id)
        : await window.yibiao?.kbPersonal.deleteDocument(document.id);
      if (!result?.success) {
        throw new Error(result?.error || '删除文档失败');
      }
      // 团队库需清除本地分析数据；个人库跳过
      if (kbTab === 'team') {
        await window.yibiao?.knowledgeBase.deleteLocalAnalysis(document.id);
      }
      setIndex((prev) => ({ ...prev, documents: prev.documents.filter((item) => item.id !== document.id) }));
      setSelectedDocumentIds((prev) => {
        if (!prev.has(document.id)) return prev;
        const next = new Set(prev);
        next.delete(document.id);
        return next;
      });
      setViewer((prev) => (prev?.document.id === document.id ? null : prev));
      showToast('文档已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除文档失败', 'error');
    }
  };

  const handleDeleteConfirm = async () => {
    const target = deleteConfirm;
    setDeleteConfirm(null);
    if (!target) return;
    setDeleteConfirmBusy(true);
    try {
      if (target.type === 'document' && target.document) {
        await doDeleteDocument(target.document);
      } else if (target.type === 'folder' && target.folderId) {
        await doDeleteFolder(target.folderId, target.folderName || '');
      } else if (target.type === 'batch') {
        await doBatchDelete();
      }
    } finally {
      setDeleteConfirmBusy(false);
    }
  };

  const moveFolder = async (folderId: string, targetParentId: string) => {
    try {
      const result = kbTab === 'team'
        ? await window.yibiao?.kbTeam.moveFolder(folderId, targetParentId || null)
        : await window.yibiao?.kbPersonal.moveFolder(folderId, targetParentId || null);
      if (!result?.success) {
        throw new Error(result?.error || '移动文件夹失败');
      }
      if (kbTab === 'team') await loadTeamTree(); else await loadPersonalTree();
      showToast('文件夹已移动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '移动文件夹失败', 'error');
    }
  };

  // ---- C5 搜索（name / content 双模式，防抖）----
  const searchDebounceRef = useRef<number | undefined>(undefined);
  const onSearchInput = (value: string, mode: 'name' | 'content') => {
    setSearchQuery(value);
    setSearchMode(mode);
    window.clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = window.setTimeout(() => {
      void handleSearch(value, mode);
    }, 300);
  };

  const handleSearch = async (query: string, mode: 'name' | 'content') => {
    const q = query.trim();
    if (!q) {
      setSearchActive(false);
      setSearchResults([]);
      return;
    }
    try {
      setSearching(true);
      let results: KnowledgeDocument[] = [];
      if (kbTab === 'team') {
        const res = await window.yibiao?.kbTeam.search(q, mode);
        if (!res?.success) throw new Error(res?.error || '搜索失败');
        results = await Promise.all((res.data || []).map(async (doc) => {
          let localStatus = await getLocalStatusSafe(doc.id);
          // 与 loadTeamTree 保持一致：本地未完成时由主进程决定是否水合共享分析。
          if (!localStatus || localStatus.status !== 'success') {
            try {
              localStatus = (await window.yibiao?.knowledgeBase.hydrateTeamAnalysis(doc.id, doc.folder_id ?? '')) ?? null;
            } catch {
              localStatus = null;
            }
          }
          return adaptServerDocument(doc, localStatus);
        }));
      } else {
        const res = await window.yibiao?.kbPersonal.searchDocuments(q, mode);
        if (!res?.success) throw new Error(res?.error || '搜索失败');
        results = await Promise.all((res.data || []).map(async (doc) => {
          const localStatus = await getLocalStatusSafe(doc.id);
          return adaptPersonalDocument(doc, localStatus);
        }));
      }
      setSearchResults(results);
      setSearchActive(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '搜索失败', 'error');
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchActive(false);
    setSearchResults([]);
    setSearchQuery('');
    setSearchMode('name');
    window.clearTimeout(searchDebounceRef.current);
  };

  // ---- C1 重命名文件夹 ----
  const openRename = (folder: KnowledgeFolder) => {
    setRenameTarget(folder);
    setRenameValue(folder.name);
    setShowRename(true);
  };
  const handleRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) { showToast('请输入文件夹名称', 'info'); return; }
    try {
      setRenaming(true);
      const result = kbTab === 'team'
        ? await window.yibiao?.kbTeam.renameFolder(renameTarget.id, name)
        : await window.yibiao?.kbPersonal.renameFolder(renameTarget.id, name);
      if (!result?.success) throw new Error(result?.error || '重命名失败');
      setIndex((prev) => ({ ...prev, folders: prev.folders.map((f) => (f.id === renameTarget.id ? { ...f, name } : f)) }));
      setShowRename(false);
      setRenameTarget(null);
      showToast('已重命名', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重命名失败', 'error');
    } finally {
      setRenaming(false);
    }
  };

  // ---- C1 重命名文档 ----
  const openDocRename = (document: KnowledgeDocument) => {
    setDocRenameTarget(document);
    setDocRenameValue(document.file_name);
    setShowDocRename(true);
  };
  const handleDocRename = async () => {
    if (!docRenameTarget) return;
    const name = docRenameValue.trim();
    if (!name) { showToast('请输入文档名称', 'info'); return; }
    try {
      setDocRenaming(true);
      const result = kbTab === 'team'
        ? await window.yibiao?.kbTeam.renameDocument(docRenameTarget.id, name)
        : await window.yibiao?.kbPersonal.renameDocument(docRenameTarget.id, name);
      if (!result?.success) throw new Error(result?.error || '重命名失败');
      setIndex((prev) => ({
        ...prev,
        documents: prev.documents.map((d) => (d.id === docRenameTarget.id ? { ...d, file_name: name } : d)),
      }));
      setShowDocRename(false);
      setDocRenameTarget(null);
      showToast('已重命名', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重命名失败', 'error');
    } finally {
      setDocRenaming(false);
    }
  };

  // ---- C2 批量导出 zip ----
  const handleExport = async () => {
    if (selectedDocumentIds.size === 0) { showToast('请先勾选要导出的文档', 'info'); return; }
    if (hasSelectedProcessing) { showToast('处理中文档不可导出', 'info'); return; }
    try {
      setExporting(true);
      const ids = Array.from(selectedDocumentIds);
      const result = kbTab === 'team'
        ? await window.yibiao?.kbTeam.exportZip(ids)
        : await window.yibiao?.kbPersonal.exportZip(ids);
      if (!result?.success) {
        if (result?.canceled) return;
        throw new Error(result?.error || '导出失败');
      }
      showToast('已导出压缩包', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '导出失败', 'error');
    } finally {
      setExporting(false);
    }
  };

  // ---- C3 回收站 ----
  const openTrash = async () => {
    try {
      setTrashLoading(true);
      setShowTrash(true);
      const result = kbTab === 'team'
        ? await window.yibiao?.kbTeam.listTrash()
        : await window.yibiao?.kbPersonal.listTrash();
      if (!result?.success) throw new Error(result?.error || '获取回收站失败');
      setTrashData({
        folders: (result.data?.folders || []) as KbTrashFolder[],
        documents: (result.data?.documents || []) as KbTrashDocument[],
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取回收站失败', 'error');
    } finally {
      setTrashLoading(false);
    }
  };
  const handleRestore = async (type: 'folder' | 'document', id: string) => {
    try {
      const result = kbTab === 'team'
        ? await window.yibiao?.kbTeam.restoreFromTrash(type, id)
        : await window.yibiao?.kbPersonal.restoreFromTrash(type, id);
      if (!result?.success) throw new Error(result?.error || '恢复失败');
      showToast('已恢复', 'success');
      await openTrash();
      if (kbTab === 'team') await loadTeamTree(); else await loadPersonalTree();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '恢复失败', 'error');
    }
  };

  // ---- E1 批量操作 ----
  const confirmBatchDelete = () => {
    if (selectedDocumentIds.size === 0 && selectedFolderIds.size === 0) return;
    const docCount = selectedDocumentIds.size;
    const folderCount = selectedFolderIds.size;
    setDeleteConfirm({
      type: 'batch',
      title: '批量删除',
      message: `确定删除选中的 ${docCount} 个文档和 ${folderCount} 个文件夹吗？`,
    });
  };

  const doBatchDelete = async () => {
    try {
      setBatchProcessing(true);
      for (const id of Array.from(selectedDocumentIds)) {
        const doc = index.documents.find((d) => d.id === id);
        if (doc && !canDeleteDoc(doc)) {
          showToast(`文档「${doc.file_name}」非本人上传，已跳过`, 'info');
          continue;
        }
        const result = kbTab === 'team'
          ? await window.yibiao?.kbTeam.deleteDocument(id)
          : await window.yibiao?.kbPersonal.deleteDocument(id);
        if (!result?.success) throw new Error(result?.error || '删除文档失败');
        if (kbTab === 'team') await window.yibiao?.knowledgeBase.deleteLocalAnalysis(id);
      }
      for (const id of Array.from(selectedFolderIds)) {
        const folder = index.folders.find((f) => f.id === id);
        if (folder && !canManageFolder(folder)) {
          showToast(`文件夹「${folder.name}」非本人创建，已跳过`, 'info');
          continue;
        }
        const result = kbTab === 'team'
          ? await window.yibiao?.kbTeam.deleteFolder(id)
          : await window.yibiao?.kbPersonal.deleteFolder(id);
        if (!result?.success) throw new Error(result?.error || '删除文件夹失败');
      }
      setSelectedDocumentIds(new Set());
      setSelectedFolderIds(new Set());
      if (kbTab === 'team') await loadTeamTree(); else await loadPersonalTree();
      showToast('已批量删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '批量删除失败', 'error');
    } finally {
      setBatchProcessing(false);
    }
  };

  const handleBatchMove = async (targetFolderId: string) => {
    if (selectedDocumentIds.size === 0 && selectedFolderIds.size === 0) return;
    if (hasSelectedProcessing) {
      showToast('处理中文档不可移动', 'info');
      return;
    }
    // 文档必须归属某个文件夹，不支持移动到"根目录"
    if (selectedDocumentIds.size > 0 && !targetFolderId) {
      showToast('文档必须移动到文件夹，请选择目标文件夹', 'info');
      return;
    }
    try {
      setBatchProcessing(true);
      for (const id of Array.from(selectedDocumentIds)) {
        const result = kbTab === 'team'
          ? await window.yibiao?.kbTeam.moveDocument(id, targetFolderId)
          : await window.yibiao?.kbPersonal.moveDocument(id, targetFolderId);
        if (!result?.success) throw new Error(result?.error || '移动文档失败');
      }
      for (const id of Array.from(selectedFolderIds)) {
        if (id === targetFolderId) continue; // 不允许移动到自身
        const result = kbTab === 'team'
          ? await window.yibiao?.kbTeam.moveFolder(id, targetFolderId || null)
          : await window.yibiao?.kbPersonal.moveFolder(id, targetFolderId || null);
        if (!result?.success) throw new Error(result?.error || '移动文件夹失败');
      }
      setSelectedDocumentIds(new Set());
      setSelectedFolderIds(new Set());
      setShowBatchMove(false);
      if (kbTab === 'team') await loadTeamTree(); else await loadPersonalTree();
      showToast('已批量移动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '批量移动失败', 'error');
    } finally {
      setBatchProcessing(false);
    }
  };

  // ---- E2 拖拽移动 ----
  const handleDragStartDoc = (event: DragEvent<HTMLElement>, docId: string) => {
    event.dataTransfer.setData('application/x-yibiao-doc', docId);
    event.dataTransfer.setData('text/plain', `doc:${docId}`);
    event.dataTransfer.effectAllowed = 'move';
    setDragDocId(docId);
  };
  const handleDragStartFolder = (event: DragEvent<HTMLElement>, folderId: string) => {
    event.dataTransfer.setData('application/x-yibiao-folder', folderId);
    event.dataTransfer.setData('text/plain', `folder:${folderId}`);
    event.dataTransfer.effectAllowed = 'move';
  };
  const handleDropOnFolder = async (event: DragEvent<HTMLElement>, folder: KnowledgeFolder) => {
    event.preventDefault();
    setDragOverFolderId(null);
    const docId = event.dataTransfer.getData('application/x-yibiao-doc');
    const folderId = event.dataTransfer.getData('application/x-yibiao-folder');
    setDragDocId(null);
    if (docId && docId !== folder.id) {
      const document = index.documents.find((d) => d.id === docId);
      if (document && isProcessingDocument(document.status)) {
        showToast('处理中文档不可移动', 'info');
        return;
      }
      try {
        const result = kbTab === 'team'
          ? await window.yibiao?.kbTeam.moveDocument(docId, folder.id)
          : await window.yibiao?.kbPersonal.moveDocument(docId, folder.id);
        if (!result?.success) throw new Error(result?.error || '移动文档失败');
        if (kbTab === 'team') await loadTeamTree(); else await loadPersonalTree();
        showToast('文档已移动', 'success');
      } catch (error) {
        showToast(error instanceof Error ? error.message : '移动失败', 'error');
      }
    } else if (folderId && folderId !== folder.id) {
      const folderIdsInBranch = new Set<string>([folderId]);
      for (const f of index.folders) {
        if (f.parent_id && folderIdsInBranch.has(f.parent_id)) folderIdsInBranch.add(f.id);
      }
      if (index.documents.some((d) => folderIdsInBranch.has(d.folder_id) && isProcessingDocument(d.status))) {
        showToast('文件夹内包含处理中文档，不可移动', 'info');
        return;
      }
      try {
        const result = kbTab === 'team'
          ? await window.yibiao?.kbTeam.moveFolder(folderId, folder.id)
          : await window.yibiao?.kbPersonal.moveFolder(folderId, folder.id);
        if (!result?.success) throw new Error(result?.error || '移动文件夹失败');
        if (kbTab === 'team') await loadTeamTree(); else await loadPersonalTree();
        showToast('文件夹已移动', 'success');
      } catch (error) {
        showToast(error instanceof Error ? error.message : '移动失败', 'error');
      }
    }
  };

  const openFolderContextMenu = (event: MouseEvent<HTMLElement>, folder: KnowledgeFolder) => {
    event.preventDefault();
    setFolderMenu({ folder, x: event.clientX, y: event.clientY });
  };

  const closeFolderMenu = () => setFolderMenu(null);

  const retryDocument = async (document: KnowledgeDocument) => {
    setRetryingDocumentIds((prev) => new Set(prev).add(document.id));
    try {
      // 团队库：服务器侧重试。触发 Worker 重新分析并本地清旧记录，然后轮询状态。
      if (kbTab === 'team') {
        const result = await window.yibiao?.kbTeam.retryAnalysis(document.id);
        if (!result?.success) {
          throw new Error(result?.error || '重试分析失败');
        }
        // 清除本地旧分析缓存，让 hydrate 拉回新结果
        await window.yibiao?.knowledgeBase.deleteLocalAnalysis(document.id);
        startTeamAnalysisPolling(String(document.id), String(document.folder_id));
        await loadTeamTree();
        showToast('已重新触发服务器分析', 'success');
        return;
      }
      // 个人库：服务器侧重试。触发 Worker 重新分析并本地清旧记录，然后轮询状态。
      const retryResult = await window.yibiao?.kbPersonal.retryAnalysis(document.id);
      if (!retryResult?.success) {
        throw new Error(retryResult?.error || '重试分析失败');
      }
      // 清除本地旧分析缓存，让 hydrate 拉回新结果
      await window.yibiao?.knowledgeBase.deleteLocalAnalysis(document.id);
      startPersonalAnalysisPolling(String(document.id), String(document.folder_id));
      await loadPersonalTree();
      showToast('已重新触发服务器分析', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '重试失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setRetryingDocumentIds((prev) => {
        const next = new Set(prev);
        next.delete(document.id);
        return next;
      });
    }
  };

  const finishActiveViewerTrace = (reason: string, payload: Record<string, unknown> = {}) => {
    finishRenderDebugTrace(viewerTraceRef.current, reason, payload);
    viewerTraceRef.current = null;
    setViewerTrace(null);
  };

  const createViewerTrace = (document: KnowledgeDocument, mode: KnowledgeViewer['mode'], requestId: number) => {
    finishActiveViewerTrace('viewer-trace-replaced', { nextMode: mode, requestId });
    if (!developerMode || mode === 'analysis') {
      return null;
    }

    const kind: RenderDebugKind = mode === 'markdown' ? 'document-markdown' : 'document-items';
    const trace = createRenderDebugTrace(kind, document, '');
    viewerTraceRef.current = trace;
    setViewerTrace(trace);
    logRenderDebug(trace, 'click:open-document', {
      mode,
      requestId,
      status: document.status,
      itemCount: document.item_count || 0,
      blockCount: document.block_count || 0,
      filteredBlockCount: document.filtered_block_count || 0,
      candidateItemCount: document.candidate_item_count || 0,
    });
    return trace;
  };

  const openDocument = async (document: KnowledgeDocument, mode: KnowledgeViewer['mode']) => {
    if (mode === 'analysis' && !developerMode) {
      return;
    }
    const requestId = viewerRequestIdRef.current + 1;
    viewerRequestIdRef.current = requestId;
    const trace = createViewerTrace(document, mode, requestId);
    setViewerLoading(mode !== 'analysis');
    logRenderDebug(trace, 'state:loading-start', { loading: mode !== 'analysis' });
    startTransition(() => {
      setViewer({ document, mode });
      setMarkdownPreview('');
      setItemsPreview([]);
      if (mode === 'analysis') {
        setAnalysisSnapshot(null);
      }
    });
    logRenderDebug(trace, 'state:viewer-transition-scheduled', { mode });
    if (mode === 'analysis') {
      await loadAnalysis(document.id);
      return;
    }

    // 个人库中从团队库同步的文档（team-<id>-<user>），查看条目/Markdown 前先确保已水合。
    // 防止本地脏记录导致打开空白。
    if (kbTab === 'personal' && String(document.id).startsWith('team-') && document.status === 'success') {
      try {
        await window.yibiao?.knowledgeBase.hydratePersonalAnalysis(document.id, document.folder_id ?? '');
      } catch {
        /* 水合失败继续尝试读取 */
      }
    }

    try {
      if (mode === 'markdown') {
        const readStartedAt = nowMs();
        logRenderDebug(trace, 'ipc:read:start', { api: 'knowledgeBase.readMarkdown', requestId });
        const markdown = await window.yibiao?.knowledgeBase.readMarkdown(document.id);
        const content = markdown || '';
        logRenderDebug(trace, 'ipc:read:end', {
          api: 'knowledgeBase.readMarkdown',
          requestId,
          readMs: roundMs(nowMs() - readStartedAt),
          contentLength: content.length,
        });
        if (viewerRequestIdRef.current !== requestId) {
          finishRenderDebugTrace(trace, 'stale-read-result', { requestId, latestRequestId: viewerRequestIdRef.current });
          return;
        }
        updateTraceContentMetrics(trace, content);
        if (viewerRequestIdRef.current === requestId) {
          logRenderDebug(trace, 'state:set-markdown-preview', { contentLength: content.length });
          setMarkdownPreview(content);
        }
      } else {
        const readStartedAt = nowMs();
        logRenderDebug(trace, 'ipc:read:start', { api: 'knowledgeBase.readItems', requestId });
        const items = await window.yibiao?.knowledgeBase.readItems(document.id);
        const nextItems = items || [];
        logRenderDebug(trace, 'ipc:read:end', {
          api: 'knowledgeBase.readItems',
          requestId,
          readMs: roundMs(nowMs() - readStartedAt),
          itemCount: nextItems.length,
        });
        if (viewerRequestIdRef.current !== requestId) {
          finishRenderDebugTrace(trace, 'stale-read-result', { requestId, latestRequestId: viewerRequestIdRef.current });
          return;
        }
        updateTraceItemsMetrics(trace, nextItems);
        if (viewerRequestIdRef.current === requestId) {
          logRenderDebug(trace, 'state:set-items-preview', { itemCount: nextItems.length });
          setItemsPreview(nextItems);
        }
      }
    } catch (error) {
      if (viewerRequestIdRef.current === requestId) {
        logRenderDebug(trace, 'ipc:read:error', { message: error instanceof Error ? error.message : String(error) });
        finishRenderDebugTrace(trace, 'read-error');
        showToast(error instanceof Error ? error.message : '读取文档结果失败', 'error');
      }
    } finally {
      if (viewerRequestIdRef.current === requestId) {
        setViewerLoading(false);
        logRenderDebug(trace, 'state:loading-false');
      }
    }
  };

  const closeViewer = () => {
    viewerRequestIdRef.current += 1;
    finishActiveViewerTrace('viewer-closed');
    startTransition(() => {
      setViewer(null);
      setViewerLoading(false);
      setViewerTrace(null);
      setItemsPreview([]);
      setMarkdownPreview('');
      setAnalysisSnapshot(null);
    });
  };

  const startMatching = async (targetDocument = viewer?.document, options?: { silent?: boolean }) => {
    if (!targetDocument) return;
    try {
      setStartingMatching(true);
      const result = await window.yibiao?.knowledgeBase.startMatching(targetDocument.id);
      if (!options?.silent) {
        showToast(result?.message || '已提交匹配任务', result?.success ? 'success' : 'info');
      }
      if (developerMode) {
        await loadAnalysis(targetDocument.id, { silent: true });
      }
    } catch (error) {
      if (!options?.silent) {
        showToast(error instanceof Error ? error.message : '启动段落匹配失败', 'error');
      }
    } finally {
      setStartingMatching(false);
    }
  };

  // 登录态由全局 ClientLoginGate 统一管控；本页仅在已登录时渲染。
  // 会话失效时由全局门禁接管（见 AuthContext.onSessionExpired）。
  if (authLoading || !authStatus?.loggedIn) {
    return (
      <div className="page-stack knowledge-page">
        <div className="knowledge-empty-box large">
          <strong>正在加载知识库...</strong>
          <p>请稍候。</p>
        </div>
      </div>
    );
  }

  if (viewer) {
    return (
      <>
        <KnowledgeDocumentViewer
          document={viewer.document}
          mode={viewer.mode}
          itemsPreview={itemsPreview}
          markdownPreview={markdownPreview}
          analysisSnapshot={analysisSnapshot}
          viewerLoading={viewerLoading}
          viewerTrace={viewerTrace}
          startingMatching={startingMatching}
          developerMode={developerMode}
          onBack={closeViewer}
          onModeChange={(mode) => void openDocument(viewer.document, mode)}
          onStartMatching={() => void startMatching()}
          onRefreshAnalysis={() => void loadAnalysis(viewer.document.id)}
        />
      </>
    );
  }

  return (
    <>
      <div className="page-stack knowledge-page">
        <section className="knowledge-workspace-bar">
        <div className="knowledge-breadcrumb">
          <span>知识库</span>
          <strong>{activeFolder?.name || '未选择文件夹'}</strong>
          <small>{index.folders.length} 个文件夹 / {index.documents.length} 个文档</small>
        </div>
        <div className="knowledge-toolbar-tabs">
          <button type="button" className={`kb-tab ${kbTab === 'team' ? 'is-active' : ''}`} onClick={() => setKbTab('team')}>团队知识库</button>
          <button type="button" className={`kb-tab ${kbTab === 'personal' ? 'is-active' : ''}`} onClick={() => setKbTab('personal')}>个人知识库</button>
        </div>
        <div className="knowledge-toolbar-actions">
          <div className="knowledge-main-actions">
            <button type="button" className="secondary-action" onClick={() => { setNewFolderParentId(null); setCreateAsSubfolder(false); setShowCreateFolder((value) => !value); }} disabled={listLoading}>新建文件夹</button>
            <button type="button" className="primary-action" onClick={() => void uploadDocuments()} disabled={loading || !activeFolder}>
              {loading ? '处理中...' : '上传文档'}
            </button>
          </div>

          {(selectedDocumentIds.size + selectedFolderIds.size) > 0 && (
            <div className="knowledge-batch-group">
              <span className="knowledge-batch-count">{selectedDocumentIds.size + selectedFolderIds.size}</span>
              {kbTab === 'team' && (
                <button type="button" className="sync-action" onClick={() => void syncFromTeam()} disabled={syncing || hasSelectedProcessing}>
                  同步到个人
                </button>
              )}
              {kbTab === 'personal' && (
                <button type="button" className="sync-action" onClick={() => void openSyncToTeam()} disabled={syncing || hasSelectedProcessing}>
                  同步到团队
                </button>
              )}
              <button
                type="button"
                className="secondary-action"
                onClick={() => setShowBatchMove(true)}
                disabled={batchProcessing || syncing || hasSelectedProcessing}
              >
                移动
              </button>
              <button
                type="button"
                className="danger-action"
                onClick={() => void confirmBatchDelete()}
                disabled={batchProcessing || syncing}
              >
                {batchProcessing ? '处理中...' : '删除'}
              </button>
              <button
                type="button"
                className="secondary-action"
                onClick={() => void handleExport()}
                disabled={exporting || syncing || hasSelectedProcessing || selectedDocumentIds.size === 0}
              >
                {exporting ? '导出中...' : '导出'}
              </button>
              <button
                type="button"
                className="secondary-action is-ghost"
                onClick={() => { setSelectedDocumentIds(new Set()); setSelectedFolderIds(new Set()); }}
              >
                取消
              </button>
            </div>
          )}

          <button type="button" className="secondary-action is-ghost" onClick={() => void openTrash()}>回收站</button>
        </div>
      </section>

      <div className="knowledge-search-bar">
        <input
          className="knowledge-search-input"
          type="search"
          value={searchQuery}
          placeholder={kbTab === 'team' ? '搜索团队库文档（文件名 / 全文）' : '搜索个人库文档（文件名 / 全文）'}
          onChange={(event) => onSearchInput(event.target.value, searchMode)}
        />
        <div className="knowledge-search-modes">
          <button
            type="button"
            className={`kb-search-mode ${searchMode === 'name' ? 'is-active' : ''}`}
            onClick={() => onSearchInput(searchQuery, 'name')}
          >文件名</button>
          <button
            type="button"
            className={`kb-search-mode ${searchMode === 'content' ? 'is-active' : ''}`}
            onClick={() => onSearchInput(searchQuery, 'content')}
          >全文</button>
        </div>
        {searching && <span className="knowledge-search-status">搜索中…</span>}
        {searchActive && (
          <button type="button" className="secondary-action" onClick={clearSearch}>清除搜索</button>
        )}
      </div>

      {showCreateFolder && (
        <form
          className="knowledge-create-folder-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void createFolder();
          }}
        >
          <input
            autoFocus
            ref={createFolderInputRef}
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onClick={(event) => event.currentTarget.focus()}
            placeholder="输入文件夹名称"
          />
          {newFolderParentId ? (
            <span className="knowledge-subfolder-check">
              将在「{index.folders.find((f) => f.id === newFolderParentId)?.name || '选定文件夹'}」下创建子文件夹
            </span>
          ) : index.folders.length > 0 && (
            <label className="knowledge-subfolder-check" title={activeFolder ? `将创建为「${activeFolder.name}」的子文件夹` : ''}>
              <input
                type="checkbox"
                checked={createAsSubfolder}
                onChange={(event) => setCreateAsSubfolder(event.target.checked)}
                disabled={!activeFolder}
              />
              作为子文件夹
            </label>
          )}
          <button type="submit" className="primary-action" disabled={creatingFolder}>{creatingFolder ? '创建中...' : '创建'}</button>
          <button
            type="button"
            className="secondary-action"
            onClick={() => {
              setNewFolderName('');
              setCreateAsSubfolder(false);
              setNewFolderParentId(null);
              setShowCreateFolder(false);
            }}
          >
            取消
          </button>
        </form>
      )}

      <Dialog.Root open={showSyncToTeam} onOpenChange={(open) => !open && setShowSyncToTeam(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-sync-modal" />
          <Dialog.Content className="knowledge-sync-dialog-card" onCloseAutoFocus={(event) => event.preventDefault()}>
            <div className="knowledge-sync-head">
              <Dialog.Title className="knowledge-sync-title">同步到团队知识库</Dialog.Title>
              <Dialog.Description className="knowledge-sync-desc">
                选择目标团队文件夹（不选则自动创建同名文件夹），将选中的 {selectedDocumentIds.size + selectedFolderIds.size} 个文档/文件夹同步过去。
              </Dialog.Description>
            </div>
            <div className="knowledge-sync-folder-list">
              {teamFolderOptions.length ? (
                teamFolderOptions.map((folder) => (
                  <label key={folder.id} className={`knowledge-sync-folder ${syncTargetFolderId === folder.id ? 'is-active' : ''}`}>
                    <input
                      type="radio"
                      name="sync-team-folder"
                      value={folder.id}
                      checked={syncTargetFolderId === folder.id}
                      onChange={() => setSyncTargetFolderId(folder.id)}
                    />
                    <span>{folder.name}</span>
                  </label>
                ))
              ) : (
                <div className="knowledge-empty-box"><strong>团队库暂无文件夹</strong><p>不选文件夹将自动创建一个新文件夹。</p></div>
              )}
            </div>
            <div className="knowledge-sync-new-folder">
              {showNewTeamFolderInput ? (
                <div className="knowledge-sync-new-folder-form">
                  <input
                    ref={newTeamFolderInputRef}
                    className="knowledge-sync-new-folder-input"
                    value={newTeamFolderName}
                    onChange={(e) => setNewTeamFolderName(e.target.value)}
                    placeholder="输入新文件夹名称"
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateTeamFolder(); if (e.key === 'Escape') { setShowNewTeamFolderInput(false); setNewTeamFolderName(''); } }}
                  />
                  <div className="knowledge-sync-new-folder-actions">
                    <button type="button" className="secondary-action" onClick={() => { setShowNewTeamFolderInput(false); setNewTeamFolderName(''); }}>取消</button>
                    <button type="button" className="primary-action" onClick={() => void handleCreateTeamFolder()} disabled={!newTeamFolderName.trim()}>创建</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="knowledge-sync-new-folder-trigger" onClick={() => setShowNewTeamFolderInput(true)}>
                  <span>+</span> 新建文件夹
                </button>
              )}
            </div>
            <div className="knowledge-sync-actions">
              <button type="button" className="secondary-action" onClick={() => { setShowSyncToTeam(false); setShowNewTeamFolderInput(false); setNewTeamFolderName(''); }} disabled={syncing}>取消</button>
              <button type="button" className="primary-action" onClick={() => void confirmSyncToTeam()} disabled={syncing}>
                {syncing ? '同步中...' : '开始同步'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <section className="knowledge-layout">
        <aside className="knowledge-folder-panel">
          <div className="knowledge-panel-head">
            <strong>文件夹</strong>
            <span>{index.folders.length} 个</span>
          </div>
          {listLoading ? (
            <div className="knowledge-empty-box">
              <strong>正在读取团队库...</strong>
              <p>请稍候，正在加载文件夹和文档列表。</p>
            </div>
          ) : index.folders.length ? (
            <div className="knowledge-folder-list">
              {visibleFoldersInTreeOrder.map((folder) => {
                  const count = documentsByFolder.get(folder.id)?.length || 0;
                  const hasChildren = (folderChildrenMap.get(folder.id)?.length || 0) > 0;
                  const isCollapsed = collapsedFolders.has(folder.id);
                  return (
                    <article
                      key={folder.id}
                      className={`knowledge-folder-card ${folder.id === activeFolder?.id ? 'is-active' : ''} ${folder.parent_id ? 'is-child' : ''} ${dragOverFolderId === folder.id ? 'is-drop-target' : ''}`}
                      draggable
                      onDragStart={(event) => handleDragStartFolder(event, folder.id)}
                      onDragOver={(event) => { event.preventDefault(); setDragOverFolderId(folder.id); }}
                      onDragLeave={() => setDragOverFolderId((prev) => (prev === folder.id ? null : prev))}
                      onDrop={(event) => void handleDropOnFolder(event, folder)}
                      onContextMenu={(event) => openFolderContextMenu(event, folder)}
                    >
                      <div className="knowledge-folder-row">
                        <label className="knowledge-document-select" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedFolderIds.has(folder.id)}
                            onChange={() => toggleSelectFolder(folder.id)}
                          />
                        </label>
                        {hasChildren && (
                          <button
                            type="button"
                            className="knowledge-folder-collapse"
                            title={isCollapsed ? '展开子文件夹' : '折叠子文件夹'}
                            onClick={(event) => { event.stopPropagation(); toggleCollapseFolder(folder.id); }}
                            aria-label={isCollapsed ? '展开子文件夹' : '折叠子文件夹'}
                          >
                            {isCollapsed ? '▸' : '▾'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="knowledge-folder-main"
                          onMouseDown={() => { void window.yibiao?.focusMainWindow?.(); }}
                          onClick={() => { if (searchActive) clearSearch(); startTransition(() => setActiveFolderId(folder.id)); }}
                        >
                          <span aria-hidden="true">F</span>
                          <strong>{folder.name}</strong>
                          <small>{count} 个文档</small>
                        </button>
                      </div>
                      {kbTab === 'team' && (
                        <div className="knowledge-folder-actions">
                          <button
                            type="button"
                            className="is-danger"
                            disabled={!canManageFolder(folder)}
                            title={canManageFolder(folder) ? '' : '只能删除自己创建的文件夹'}
                            onClick={() => void confirmDeleteFolder(folder.id, folder.name)}
                          >删除</button>
                        </div>
                      )}
                    </article>
                  );
                })}
            </div>
          ) : (
            <div className="knowledge-empty-box">
              <strong>还没有文件夹</strong>
              <p>先创建一个文件夹，再上传文档。</p>
            </div>
          )}
        </aside>

        <main className="knowledge-document-panel">
          <div className="knowledge-panel-head">
            <strong>{searchActive ? `搜索结果（${displayedDocuments.length}）` : (activeFolder?.name || '未选择文件夹')}</strong>
            <span className="knowledge-panel-head-right">
              <label className="knowledge-select-all">
                <input
                  type="checkbox"
                  checked={displayedDocuments.length > 0 && displayedDocuments.every((document) => selectedDocumentIds.has(document.id))}
                  onChange={(event) => toggleSelectAll(event.target.checked)}
                />
                全选
              </label>
              <span>{displayedDocuments.length} 个文档</span>
            </span>
          </div>

          {listLoading ? (
            <div className="knowledge-empty-box large">
              <strong>正在读取团队库...</strong>
              <p>文档列表加载完成后会自动显示。</p>
            </div>
          ) : displayedDocuments.length ? (
            <div className="knowledge-document-list">
              {visibleDocuments.map((document) => {
                const retrying = retryingDocumentIds.has(document.id);
                return (
                  <article
                    className="knowledge-document-card"
                    key={document.id}
                    draggable={!isProcessingDocument(document.status)}
                    title={isProcessingDocument(document.status) ? '处理中，不可移动' : ''}
                    onDragStart={(event) => handleDragStartDoc(event, document.id)}
                    onDragEnd={() => setDragDocId(null)}
                  >
                    <div className="knowledge-document-title">
                      <div className="knowledge-document-title-left">
                        <label className="knowledge-document-select" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedDocumentIds.has(document.id)}
                            onChange={() => toggleSelect(document.id)}
                          />
                        </label>
                        <div className="knowledge-document-title-main">
                          <div className="knowledge-document-name">
                            <strong>{document.file_name}</strong>
                            {developerMode && <code className="knowledge-entity-id">文档ID：{document.id}</code>}
                          </div>
                          <small className="knowledge-document-subtitle">
                            {formatUploadSubtitle(document.uploaded_by_name, document.created_at)}
                          </small>
                        </div>
                      </div>
                      <span className={`knowledge-status is-${document.status}`}>{statusLabels[document.status]}</span>
                    </div>
                    <div className="knowledge-progress-track" aria-label={`处理进度 ${document.progress}%`}>
                      <span style={{ width: `${Math.max(0, Math.min(100, document.progress || 0))}%` }} />
                    </div>
                    <div className="knowledge-document-meta">
                      <span>{document.message}</span>
                      <span>{document.item_count || 0} 条知识</span>
                      <span>{document.candidate_item_count || 0} 个候选</span>
                      <span>{document.block_count || 0} 个 block</span>
                    </div>
                    <div className="knowledge-document-actions">
                      {developerMode && <button type="button" onClick={() => void openDocument(document, 'analysis')} disabled={!canOpenAnalysis(document)}>分析调试</button>}
                      <button type="button" onClick={() => void openDocument(document, 'items')} disabled={document.status !== 'success'}>查看条目</button>
                      <button type="button" onClick={() => void openDocument(document, 'markdown')} disabled={!canOpenMarkdown(document)}>查看 Markdown</button>
                      {kbTab === 'team' && document.status === 'error' && (
                        <button type="button" className="is-retry" onClick={() => void retryDocument(document)} disabled={retrying}>
                          {retrying ? '重试中...' : '重试'}
                        </button>
                      )}
                      {canDeleteDoc(document) ? (
                        <button type="button" onClick={() => void openDocRename(document)}>重命名</button>
                      ) : (
                        <button type="button" disabled title="只能重命名自己上传的文档">重命名</button>
                      )}
                      {canDeleteDoc(document) ? (
                        <button type="button" className="is-danger" onClick={() => void confirmDeleteDocument(document)}>删除</button>
                      ) : (
                        <button type="button" className="is-danger" disabled title="只能删除自己上传的文档">删除</button>
                      )}
                    </div>
                  </article>
                );
              })}
              {visibleDocuments.length < displayedDocuments.length && (
                <div className="knowledge-empty-box">
                  <strong>正在加载更多文档...</strong>
                  <p>已显示 {visibleDocuments.length} / {displayedDocuments.length} 个文档。</p>
                </div>
              )}
            </div>
          ) : searchActive ? (
            <div className="knowledge-empty-box large">
              <strong>未找到匹配的文档</strong>
              <p>换个关键词，或切换「文件名 / 全文」模式再试。</p>
            </div>
          ) : (
            <div className="knowledge-empty-box large">
              <strong>当前文件夹暂无文档</strong>
              <p>支持上传 .doc、.docx、.pdf、.md、.xls、.xlsx 文档。</p>
            </div>
          )}
        </main>
        </section>
      </div>

      {folderMenu && (
        <div
          className="knowledge-folder-context-menu"
          style={{ position: 'fixed', left: folderMenu.x, top: folderMenu.y, zIndex: 1000 }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              closeFolderMenu();
              setNewFolderParentId(folderMenu.folder.id);
              setCreateAsSubfolder(false);
              setShowCreateFolder(true);
            }}
          >
            新建子文件夹
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              closeFolderMenu();
              void uploadDocuments(folderMenu.folder);
            }}
          >
            上传文档
          </button>
          <button
            type="button"
            disabled={!canManageFolder(folderMenu.folder)}
            title={canManageFolder(folderMenu.folder) ? '' : '只能重命名自己创建的文件夹'}
            onClick={(event) => {
              event.stopPropagation();
              closeFolderMenu();
              openRename(folderMenu.folder);
            }}
          >
            重命名
          </button>
          <button
            type="button"
            disabled={!canManageFolder(folderMenu.folder)}
            title={canManageFolder(folderMenu.folder) ? '' : '只能移动自己创建的文件夹'}
            onClick={(event) => {
              event.stopPropagation();
              closeFolderMenu();
              setMoveFolderTarget(folderMenu.folder);
              setSelectedMoveParentId('');
              setShowMoveFolder(true);
            }}
          >
            移动到...
          </button>
          <button
            type="button"
            className="is-danger"
            disabled={!canManageFolder(folderMenu.folder)}
            title={canManageFolder(folderMenu.folder) ? '' : '只能删除自己创建的文件夹'}
            onClick={(event) => {
              event.stopPropagation();
              closeFolderMenu();
              void confirmDeleteFolder(folderMenu.folder.id, folderMenu.folder.name);
            }}
          >
            删除文件夹
          </button>
        </div>
      )}

      <Dialog.Root open={showMoveFolder} onOpenChange={(open) => !open && setShowMoveFolder(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-sync-modal" />
          <Dialog.Content className="knowledge-sync-dialog-card" onCloseAutoFocus={(event) => event.preventDefault()}>
            <div className="knowledge-sync-head">
              <Dialog.Title className="knowledge-sync-title">移动文件夹</Dialog.Title>
              <Dialog.Description className="knowledge-sync-desc">
                选择「{moveFolderTarget?.name}」的新位置，不选则移动到根目录。
              </Dialog.Description>
            </div>
            <div className="knowledge-sync-folder-list">
              <label className={`knowledge-sync-folder ${selectedMoveParentId === '' ? 'is-active' : ''}`}>
                <input
                  type="radio"
                  name="move-folder-parent"
                  value=""
                  checked={selectedMoveParentId === ''}
                  onChange={() => setSelectedMoveParentId('')}
                />
                <span>根目录</span>
              </label>
              {index.folders
                .filter((folder) => folder.id !== moveFolderTarget?.id)
                .map((folder) => (
                  <label key={folder.id} className={`knowledge-sync-folder ${selectedMoveParentId === folder.id ? 'is-active' : ''}`}>
                    <input
                      type="radio"
                      name="move-folder-parent"
                      value={folder.id}
                      checked={selectedMoveParentId === folder.id}
                      onChange={() => setSelectedMoveParentId(folder.id)}
                    />
                    <span>{folder.name}</span>
                  </label>
                ))}
            </div>
            <div className="knowledge-sync-actions">
              <button type="button" className="secondary-action" onClick={() => setShowMoveFolder(false)}>取消</button>
              <button
                type="button"
                className="primary-action"
                onClick={() => {
                  if (moveFolderTarget) {
                    void moveFolder(moveFolderTarget.id, selectedMoveParentId);
                  }
                  setShowMoveFolder(false);
                }}
              >
                移动
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={showRename} onOpenChange={(open) => !open && setShowRename(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-sync-modal" />
          <Dialog.Content className="knowledge-sync-dialog-card" onCloseAutoFocus={(event) => event.preventDefault()}>
            <div className="knowledge-sync-head">
              <Dialog.Title className="knowledge-sync-title">重命名文件夹</Dialog.Title>
              <Dialog.Description className="knowledge-sync-desc">修改「{renameTarget?.name}」的名称。</Dialog.Description>
            </div>
            <div className="knowledge-sync-folder-list">
              <input
                ref={renameInputRef}
                className="knowledge-search-input"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                placeholder="输入新文件夹名称"
                onKeyDown={(event) => { if (event.key === 'Enter') void handleRename(); }}
              />
            </div>
            <div className="knowledge-sync-actions">
              <button type="button" className="secondary-action" onClick={() => setShowRename(false)} disabled={renaming}>取消</button>
              <button type="button" className="primary-action" onClick={() => void handleRename()} disabled={renaming || !renameValue.trim()}>
                {renaming ? '保存中...' : '保存'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={showDocRename} onOpenChange={(open) => !open && setShowDocRename(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-sync-modal" />
          <Dialog.Content className="knowledge-sync-dialog-card" onCloseAutoFocus={(event) => event.preventDefault()}>
            <div className="knowledge-sync-head">
              <Dialog.Title className="knowledge-sync-title">重命名文档</Dialog.Title>
              <Dialog.Description className="knowledge-sync-desc">修改「{docRenameTarget?.file_name}」的显示名称。</Dialog.Description>
            </div>
            <div className="knowledge-sync-folder-list">
              <input
                ref={docRenameInputRef}
                className="knowledge-search-input"
                value={docRenameValue}
                onChange={(event) => setDocRenameValue(event.target.value)}
                placeholder="输入新文档名称"
                onKeyDown={(event) => { if (event.key === 'Enter') void handleDocRename(); }}
              />
            </div>
            <div className="knowledge-sync-actions">
              <button type="button" className="secondary-action" onClick={() => setShowDocRename(false)} disabled={docRenaming}>取消</button>
              <button type="button" className="primary-action" onClick={() => void handleDocRename()} disabled={docRenaming || !docRenameValue.trim()}>
                {docRenaming ? '保存中...' : '保存'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={showBatchMove} onOpenChange={(open) => !open && setShowBatchMove(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-sync-modal" />
          <Dialog.Content className="knowledge-sync-dialog-card" onCloseAutoFocus={(event) => event.preventDefault()}>
            <div className="knowledge-sync-head">
              <Dialog.Title className="knowledge-sync-title">批量移动到</Dialog.Title>
              <Dialog.Description className="knowledge-sync-desc">
                将选中的 {selectedDocumentIds.size + selectedFolderIds.size} 个文档/文件夹移动到目标文件夹。
              </Dialog.Description>
            </div>
            <div className="knowledge-sync-folder-list">
              {selectedDocumentIds.size === 0 && (
                <label className={`knowledge-sync-folder ${batchMoveTargetId === '' ? 'is-active' : ''}`}>
                  <input type="radio" name="batch-move-folder" value="" checked={batchMoveTargetId === ''} onChange={() => setBatchMoveTargetId('')} />
                  <span>根目录</span>
                </label>
              )}
              {index.folders.map((folder) => (
                <label key={folder.id} className={`knowledge-sync-folder ${batchMoveTargetId === folder.id ? 'is-active' : ''}`}>
                  <input
                    type="radio"
                    name="batch-move-folder"
                    value={folder.id}
                    checked={batchMoveTargetId === folder.id}
                    onChange={() => setBatchMoveTargetId(folder.id)}
                  />
                  <span>{folder.name}</span>
                </label>
              ))}
            </div>
            <div className="knowledge-sync-actions">
              <button type="button" className="secondary-action" onClick={() => setShowBatchMove(false)} disabled={batchProcessing}>取消</button>
              <button type="button" className="primary-action" onClick={() => void handleBatchMove(batchMoveTargetId)} disabled={batchProcessing || (selectedDocumentIds.size > 0 && !batchMoveTargetId)}>
                {batchProcessing ? '移动中...' : '移动'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(deleteConfirm)} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-sync-modal" />
          <Dialog.Content className="knowledge-sync-dialog-card" onCloseAutoFocus={(event) => event.preventDefault()}>
            <div className="knowledge-sync-head">
              <Dialog.Title className="knowledge-sync-title">{deleteConfirm?.title}</Dialog.Title>
              <Dialog.Description className="knowledge-sync-desc">{deleteConfirm?.message}</Dialog.Description>
            </div>
            <div className="knowledge-sync-actions">
              <button type="button" className="secondary-action" onClick={() => setDeleteConfirm(null)} disabled={deleteConfirmBusy || batchProcessing}>取消</button>
              <button type="button" className="danger-action" onClick={() => void handleDeleteConfirm()} disabled={deleteConfirmBusy || batchProcessing}>
                {deleteConfirmBusy || batchProcessing ? '删除中...' : '确认删除'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={showTrash} onOpenChange={(open) => !open && setShowTrash(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-sync-modal" />
          <Dialog.Content className="knowledge-sync-dialog-card" onCloseAutoFocus={(event) => event.preventDefault()}>
            <div className="knowledge-sync-head">
              <Dialog.Title className="knowledge-sync-title">回收站（24 小时内可恢复）</Dialog.Title>
              <Dialog.Description className="knowledge-sync-desc">删除的文件夹与文档会保留 24 小时，删除者本人或管理员可恢复。</Dialog.Description>
            </div>
            <div className="knowledge-trash-list">
              {trashLoading ? (
                <div className="knowledge-empty-box"><strong>加载中...</strong></div>
              ) : (trashData.folders.length === 0 && trashData.documents.length === 0) ? (
                <div className="knowledge-empty-box"><strong>回收站是空的</strong><p>暂无可恢复的文件夹或文档。</p></div>
              ) : (
                <>
                  {trashData.folders.map((item) => (
                    <div key={`f-${item.id}`} className="knowledge-trash-item">
                      <div className="knowledge-trash-info">
                        <strong>📁 {item.name}</strong>
                        <small>{formatTrashRemaining(item.deleted_at)}</small>
                      </div>
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={!(isAdmin || String(item.deleted_by) === String(currentUserId))}
                        onClick={() => void handleRestore('folder', String(item.id))}
                      >恢复</button>
                    </div>
                  ))}
                  {trashData.documents.map((item) => (
                    <div key={`d-${item.id}`} className="knowledge-trash-item">
                      <div className="knowledge-trash-info">
                        <strong>📄 {item.file_name || '文档'}</strong>
                        <small>{formatTrashRemaining(item.deleted_at)}</small>
                      </div>
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={!(isAdmin || String(item.deleted_by) === String(currentUserId))}
                        onClick={() => void handleRestore('document', String(item.id))}
                      >恢复</button>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="knowledge-sync-actions">
              <button type="button" className="secondary-action" onClick={() => setShowTrash(false)}>关闭</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

    </>
  );
}

interface KnowledgeDocumentViewerProps {
  document: KnowledgeDocument;
  mode: KnowledgeViewer['mode'];
  itemsPreview: KnowledgeItem[];
  markdownPreview: string;
  analysisSnapshot: KnowledgeAnalysisSnapshot | null;
  viewerLoading: boolean;
  viewerTrace: RenderDebugTrace | null;
  startingMatching: boolean;
  developerMode: boolean;
  onBack: () => void;
  onModeChange: (mode: KnowledgeViewer['mode']) => void;
  onStartMatching: () => void;
  onRefreshAnalysis: () => void;
}

function KnowledgeDocumentViewer({
  document,
  mode,
  itemsPreview,
  markdownPreview,
  analysisSnapshot,
  viewerLoading,
  viewerTrace,
  startingMatching,
  developerMode,
  onBack,
  onModeChange,
  onStartMatching,
  onRefreshAnalysis,
}: KnowledgeDocumentViewerProps) {
  const { showToast } = useToast();
  const [sourceItem, setSourceItem] = useState<KnowledgeItem | null>(null);
  const [sourceRendering, setSourceRendering] = useState(false);
  const [sourceTrace, setSourceTrace] = useState<RenderDebugTrace | null>(null);
  const renderRequestIdRef = useRef(0);
  const sourceTraceRef = useRef<RenderDebugTrace | null>(null);

  useEffect(() => {
    finishRenderDebugTrace(sourceTraceRef.current, 'viewer-reset');
    sourceTraceRef.current = null;
    setSourceItem(null);
    setSourceRendering(false);
    setSourceTrace(null);
    renderRequestIdRef.current += 1;
  }, [document.id, mode]);

  const openSourceItem = (item: KnowledgeItem) => {
    renderRequestIdRef.current += 1;
    const requestId = renderRequestIdRef.current;
    finishRenderDebugTrace(sourceTraceRef.current, 'source-trace-replaced');
    const trace = developerMode ? createRenderDebugTrace('item-source', document, item.content || '', item) : null;
    sourceTraceRef.current = trace;

    setSourceItem(item);
    setSourceRendering(true);
    setSourceTrace(trace);
    logRenderDebug(trace, 'click:open-source');
    window.requestAnimationFrame(() => {
      if (renderRequestIdRef.current === requestId) {
        logRenderDebug(trace, 'raf:release-markdown-render');
        setSourceRendering(false);
      }
    });
  };

  const closeSourceItem = () => {
    renderRequestIdRef.current += 1;
    finishRenderDebugTrace(sourceTraceRef.current, 'source-view-closed');
    sourceTraceRef.current = null;
    setSourceItem(null);
    setSourceRendering(false);
    setSourceTrace(null);
  };

  const copyDebugLogs = async () => {
    const logs = window.__knowledgeRenderDebugLogs || [];
    if (!logs.length) {
      showToast('暂无渲染调试日志', 'info');
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
      showToast(`渲染调试日志已复制（${logs.length} 条）`, 'success');
    } catch (error) {
      console.warn('复制渲染调试日志失败', error);
      showToast('复制调试日志失败', 'error');
    }
  };

  return (
    <div className="page-stack knowledge-viewer-page">
      <section className="knowledge-workspace-bar knowledge-viewer-bar">
        <div className="knowledge-breadcrumb">
          <span>知识库</span>
          <strong>{document.file_name}</strong>
          {developerMode && <code className="knowledge-entity-id">文档ID：{document.id}</code>}
          <small>{mode === 'analysis' ? '分析调试' : mode === 'items' ? `${document.item_count || 0} 条知识` : 'Markdown 原文'}</small>
        </div>
        <div className="knowledge-toolbar-actions">
          <button type="button" className="secondary-action" onClick={onBack}>返回知识库</button>
          {developerMode && <button type="button" className="secondary-action" onClick={() => void copyDebugLogs()}>复制调试日志</button>}
          {developerMode && <button type="button" className={`secondary-action ${mode === 'analysis' ? 'is-active' : ''}`} onClick={() => onModeChange('analysis')}>分析调试</button>}
          <button type="button" className={`secondary-action ${mode === 'items' ? 'is-active' : ''}`} onClick={() => onModeChange('items')} disabled={document.status !== 'success'}>知识条目</button>
          <button type="button" className={`secondary-action ${mode === 'markdown' ? 'is-active' : ''}`} onClick={() => onModeChange('markdown')} disabled={!canOpenMarkdown(document)}>Markdown</button>
        </div>
      </section>

      <section className="knowledge-viewer-panel">
        {mode === 'analysis' && developerMode ? (
          <KnowledgeAnalysisView
            document={document}
            snapshot={analysisSnapshot}
            startingMatching={startingMatching}
            onStartMatching={onStartMatching}
            onRefresh={onRefreshAnalysis}
          />
        ) : mode === 'items' ? (
          viewerLoading ? (
            <div className="knowledge-empty-box">
              <strong>正在读取知识条目...</strong>
              <p>条目较多时需要稍等片刻。</p>
            </div>
          ) : (
            <DebuggableMarkdownContent
              className="knowledge-item-list knowledge-viewer-item-list"
              debugTrace={mode === 'items' ? viewerTrace : null}
              developerMode={developerMode}
              profilerId="knowledge-items-list"
            >
              {itemsPreview.length ? itemsPreview.map((item) => (
                <KnowledgeItemCard
                  key={item.id}
                  item={item}
                  developerMode={developerMode}
                  onOpenSource={() => openSourceItem(item)}
                />
              )) : <div className="knowledge-empty-box"><strong>暂无知识条目</strong><p>文档完成整理后会显示结果。</p></div>}
            </DebuggableMarkdownContent>
          )
        ) : (
          <MarkdownFullscreenViewer
            className="markdown-viewer knowledge-viewer-markdown"
            title={`${document.file_name}全屏查看`}
            fullscreenChildren={viewerLoading ? (
              <div className="knowledge-empty-box large">
                <strong>正在读取 Markdown...</strong>
                <p>原文内容较大时需要稍等片刻。</p>
              </div>
            ) : (
              <MarkdownRenderer>{markdownPreview || '暂无 Markdown 内容'}</MarkdownRenderer>
            )}
          >
            {viewerLoading ? (
              <div className="knowledge-empty-box large">
                <strong>正在读取 Markdown...</strong>
                <p>原文内容较大时需要稍等片刻。</p>
              </div>
            ) : (
              <DebuggableMarkdownContent
                className="knowledge-markdown-debug-content"
                debugTrace={mode === 'markdown' ? viewerTrace : null}
                developerMode={developerMode}
                profilerId="knowledge-document-markdown"
              >
                <MarkdownRenderer>{markdownPreview || '暂无 Markdown 内容'}</MarkdownRenderer>
              </DebuggableMarkdownContent>
            )}
          </MarkdownFullscreenViewer>
        )}
      </section>

      <Dialog.Root open={Boolean(sourceItem)} onOpenChange={(open) => !open && closeSourceItem()}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-source-modal" />
          {sourceItem && (
            <KnowledgeItemSourceDialog
              item={sourceItem}
              developerMode={developerMode}
              rendering={sourceRendering}
              debugTrace={sourceTrace}
              onClose={closeSourceItem}
            />
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

interface KnowledgeItemCardProps {
  item: KnowledgeItem;
  developerMode: boolean;
  onOpenSource: () => void;
}

function KnowledgeItemCard({ item, developerMode, onOpenSource }: KnowledgeItemCardProps) {
  return (
    <article className="knowledge-item-card">
      {developerMode && <code className="knowledge-entity-id">条目ID：{item.id}</code>}
      <strong>{item.title}</strong>
      <p>{item.resume}</p>
      <button type="button" className="knowledge-item-source-action" onClick={onOpenSource}>查看原文</button>
    </article>
  );
}

interface KnowledgeItemSourceViewerProps {
  item: KnowledgeItem;
  developerMode: boolean;
  rendering: boolean;
  debugTrace: RenderDebugTrace | null;
  onClose: () => void;
}

function KnowledgeItemSourceDialog({ item, developerMode, rendering, debugTrace, onClose }: KnowledgeItemSourceViewerProps) {
  useLayoutEffect(() => {
    if (!developerMode || !debugTrace || !rendering) return;
    logRenderDebug(debugTrace, 'loading:commit');
  }, [debugTrace, developerMode, rendering]);

  useEffect(() => {
    if (!developerMode || !debugTrace || !rendering) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      logRenderDebug(debugTrace, 'loading:next-frame-visible');
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [debugTrace, developerMode, rendering]);

  return (
    <Dialog.Content className="knowledge-source-dialog-card knowledge-source-viewer" onCloseAutoFocus={(event) => event.preventDefault()}>
      <div className="knowledge-source-head">
        <div>
          <span>知识条目原文</span>
          <Dialog.Title>{item.title}</Dialog.Title>
          <Dialog.Description>查看该知识条目对应的原始 Markdown 片段。</Dialog.Description>
          {developerMode && <code className="knowledge-entity-id">条目ID：{item.id}</code>}
        </div>
        <button type="button" className="secondary-action" onClick={onClose}>关闭</button>
      </div>
      {rendering ? (
        <div className="knowledge-empty-box large knowledge-source-loading">
          <span className="inline-spinner" aria-hidden="true" />
          <strong>正在渲染原文...</strong>
          <p>内容较大时需要稍等片刻。</p>
        </div>
      ) : (
        <MarkdownFullscreenViewer
          className="markdown-viewer knowledge-source-content"
          title={`${item.title}原文全屏查看`}
          fullscreenChildren={(
            <MarkdownRenderer enableGfm={false} linkMode="text" linkTextClassName="knowledge-item-link-text" imageMode="lazy">
              {item.content || '暂无原文内容'}
            </MarkdownRenderer>
          )}
        >
          <DebuggableMarkdownContent
            className="knowledge-source-debug-content"
            debugTrace={debugTrace}
            developerMode={developerMode}
            profilerId="knowledge-item-source"
          >
            <MarkdownRenderer enableGfm={false} linkMode="text" linkTextClassName="knowledge-item-link-text" imageMode="lazy">
              {item.content || '暂无原文内容'}
            </MarkdownRenderer>
          </DebuggableMarkdownContent>
        </MarkdownFullscreenViewer>
      )}
    </Dialog.Content>
  );
}

interface DebuggableMarkdownContentProps {
  children: ReactNode;
  className: string;
  debugTrace: RenderDebugTrace | null;
  developerMode: boolean;
  profilerId: string;
}

function DebuggableMarkdownContent({ children, className, debugTrace, developerMode, profilerId }: DebuggableMarkdownContentProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!developerMode || !debugTrace) return;
    logRenderDebug(debugTrace, 'dom:commit', collectDomMetrics(contentRef.current));
  });

  useEffect(() => {
    if (!developerMode || !debugTrace) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      logRenderDebug(debugTrace, 'dom:next-frame-visible', collectDomMetrics(contentRef.current));
      finishRenderDebugTrace(debugTrace, 'next-frame-visible');
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [debugTrace, developerMode]);

  const content = <div ref={contentRef} className={className}>{children}</div>;
  if (!developerMode || !debugTrace) return content;

  return (
    <Profiler
      id={profilerId}
      onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) => {
        logProfilerRender(debugTrace, id, phase, actualDuration, baseDuration, startTime, commitTime);
      }}
    >
      {content}
    </Profiler>
  );
}

interface KnowledgeAnalysisViewProps {
  document: KnowledgeDocument;
  snapshot: KnowledgeAnalysisSnapshot | null;
  startingMatching: boolean;
  onStartMatching: () => void;
  onRefresh: () => void;
}

function KnowledgeAnalysisView({ document, snapshot, startingMatching, onStartMatching, onRefresh }: KnowledgeAnalysisViewProps) {
  const report = snapshot?.report;
  const canStart = ['ready_for_matching', 'success', 'error'].includes(document.status) && Boolean(snapshot?.candidate_items.length);

  return (
    <div className="knowledge-analysis-view">
      <div className="knowledge-analysis-command">
        <div>
          <strong>自动分段段落匹配</strong>
          <p>按模型上下文长度自动分段匹配段落，并在匹配后执行遗漏补漏。</p>
        </div>
        <button type="button" className="primary-action" onClick={onStartMatching} disabled={!canStart || startingMatching}>
          {startingMatching ? '提交中...' : document.status === 'success' ? '重新匹配' : '开始匹配'}
        </button>
        <button type="button" className="secondary-action" onClick={onRefresh}>刷新</button>
      </div>

      <div className="knowledge-analysis-stats">
        <StatCard label="有效 block" value={snapshot?.block_count ?? document.block_count ?? 0} />
        <StatCard label="筛除 block" value={snapshot?.filtered_blocks_count ?? document.filtered_block_count ?? 0} />
        <StatCard label="候选条目" value={snapshot?.candidate_items.length ?? document.candidate_item_count ?? 0} />
        <StatCard label="最终条目" value={report?.final_items_count ?? document.item_count ?? 0} />
        <StatCard label="覆盖率" value={report ? `${Math.round(report.coverage_rate * 100)}%` : '-'} />
        <StatCard label="补漏新增" value={report?.new_items_from_recovery_count ?? 0} />
        <StatCard label="Markdown 字符" value={formatInteger(snapshot?.markdown_chars)} />
        <StatCard label="保留 block 字符" value={formatInteger(snapshot?.kept_block_chars)} />
        <StatCard label="条目覆盖字符" value={formatInteger(snapshot?.covered_unique_content_chars)} />
        <StatCard label="原文真实覆盖率" value={formatPercent(snapshot?.coverage_rate_vs_markdown)} />
      </div>

      {report && (
        <div className="knowledge-analysis-report">
          <strong>处理报告</strong>
          <span>已匹配 {report.matched_blocks_count} 个 block</span>
          <span>AI 舍弃 {report.discarded_blocks_count} 个 block</span>
          <span>重试后系统舍弃 {report.system_discarded_after_retry_count} 个 block</span>
          <span>补漏轮次 {report.recovery_attempt_count}</span>
          <span>block 段数 {report.batch_size}</span>
        </div>
      )}

      {snapshot?.debug_log_path && (
        <div className="knowledge-analysis-debug-log">
          <strong>开发者日志</strong>
          <code>{snapshot.debug_log_path}</code>
        </div>
      )}

      <div className="knowledge-analysis-grid">
        <section className="knowledge-analysis-section">
          <div className="knowledge-panel-head">
            <strong>候选知识条目</strong>
            <span>{snapshot?.candidate_items.length || 0} 条</span>
          </div>
          <div className="knowledge-candidate-list">
            {snapshot?.candidate_items.length ? snapshot.candidate_items.map((item) => (
              <article className="knowledge-candidate-card" key={item.id}>
                <small>{item.id}</small>
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
              </article>
            )) : <div className="knowledge-empty-box"><strong>暂无候选条目</strong><p>上传处理完成后会显示 AI 提取出的知识条目。</p></div>}
          </div>
        </section>

        <section className="knowledge-analysis-section">
          <div className="knowledge-panel-head">
            <strong>舍弃记录</strong>
            <span>{(snapshot?.discarded.length || 0) + (snapshot?.system_discarded_after_retry.length || 0)} 组</span>
          </div>
          <div className="knowledge-candidate-list">
            {snapshot && (snapshot.discarded.length || snapshot.system_discarded_after_retry.length) ? (
              [...snapshot.discarded, ...snapshot.system_discarded_after_retry].map((item, index) => (
                <article className="knowledge-candidate-card" key={`${item.reason}-${index}`}>
                  <small>{item.block_ids.length} 个 block</small>
                  <strong>{item.reason}</strong>
                  <p>{item.block_ids.join('、')}</p>
                </article>
              ))
            ) : <div className="knowledge-empty-box"><strong>暂无舍弃记录</strong><p>完成段落匹配和补漏后会显示。</p></div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function formatInteger(value?: number) {
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : '-';
}

function formatPercent(value?: number) {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '-';
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="knowledge-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function canOpenAnalysis(document: KnowledgeDocument) {
  return !['pending', 'copying', 'converting', 'extracting'].includes(document.status);
}

function canOpenMarkdown(document: KnowledgeDocument) {
  return !['pending', 'copying'].includes(document.status);
}

function mergeDocuments(prev: KnowledgeDocument[], next: KnowledgeDocument[]) {
  const byId = new Map(prev.map((document) => [document.id, document]));
  next.forEach((document) => byId.set(document.id, document));
  return Array.from(byId.values());
}

export default KnowledgeBasePage;
