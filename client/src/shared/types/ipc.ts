import type { AiHttpErrorPayload, ChatCompletionRequest, JsonCompletionRequest } from './ai';
import type { DuplicateCheckWorkspacePatch, DuplicateCheckWorkspaceState, FileSelectionResult } from './bid';
import type { ClientConfig, ConfigSaveResult, ImageModelTestResult, ModelInfoResult, ModelListResult, TextModelTestResult, UpdateChannel } from './config';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseEvent, KnowledgeBaseIndex, KnowledgeBaseIndexMutationResult, KnowledgeBaseMutationResult, KnowledgeBaseRetryDocumentResult, KnowledgeBaseStartMatchingResult, KnowledgeBaseUploadResult, KnowledgeDocument, KnowledgeFolder, KnowledgeItem } from '../../features/knowledge-base/types';
import type { RejectionCheckWorkspacePatch, RejectionCheckWorkspaceState, RejectionDocumentRole } from '../../features/rejection-check/types';
import type { BidAnalysisMode, BidAnalysisTaskState, BidSectionMode, ContentGenerationOptions, ContentGenerationPlanState, ContentGenerationProgressDetail, ContentGenerationRuntimeState, ContentGenerationSectionState, DetectedBidSection, GlobalFactGroupState, GlobalFactsMode, SaveOutlineRequest, SaveOutlineSelectionRequest, TechnicalPlanState, TechnicalPlanStep, TechnicalPlanWorkflowKind } from '../../features/technical-plan/types';
import type { FeasibilityProjectInfo, FeasibilityReportState, FeasibilityReportStep, FeasibilitySaveOutlineRequest, FeasibilitySourceFile } from '../../features/feasibility-report/types';
import type { ExportFormatConfig, ExportTemplateRecord } from './exportFormat';
import type { OutlineData, OutlineExpansionMode, OutlineMode, OutlineWordControlOptions } from './outline';

export interface TaskEventTask {
  task_id: string;
  type: string;
  status: string;
  progress: number;
  progress_detail?: ContentGenerationProgressDetail;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
  stats?: unknown;
}

export interface TaskEvent<TState = unknown, TRejectionCheckState = unknown, TDuplicateCheckState = unknown> {
  task: TaskEventTask;
  technicalPlan?: TState;
  technicalPlanPatch?: Partial<TechnicalPlanState>;
  bidItem?: BidAnalysisTaskState;
  outlineData?: OutlineData | null;
  contentSection?: ContentGenerationSectionState;
  contentPlan?: { nodeId: string; value: ContentGenerationPlanState | null };
  contentRuntime?: ContentGenerationRuntimeState;
  rejectionCheck?: TRejectionCheckState;
  rejectionCheckPatch?: RejectionCheckWorkspacePatch;
  duplicateCheck?: TDuplicateCheckState;
  duplicateCheckPatch?: DuplicateCheckWorkspacePatch;
  feasibilityReportPatch?: Partial<FeasibilityReportState>;
}

export interface WordExportProgressEvent {
  requestId?: string;
  phase: 'running' | 'success' | 'error' | 'canceled';
  progress: number;
  message: string;
  warnings?: string[];
}

export interface WordExportResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  message?: string;
  warnings?: string[];
}

export interface RequiredOnlineServiceStatus {
  id: string;
  label: string;
  domain: string;
  available: boolean;
  checked: boolean;
}

export interface RequiredOnlineServicesStatus {
  checked: boolean;
  services: RequiredOnlineServiceStatus[];
  unavailableServices: RequiredOnlineServiceStatus[];
}

export interface DeveloperTextTokenStats {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_ratio: number;
}

export interface DeveloperExpansionReplaceTestPayload {
  sectionId: string;
  sectionTitle: string;
  sectionDescription?: string;
  content: string;
  selectedText: string;
}

export interface DeveloperExpansionReplacePatch {
  operation: string;
  anchor?: string;
  target_text?: string;
  content: string;
}

export type DeveloperExpansionReplaceTestStatus = 'replace-success' | 'blocked';

export interface DeveloperExpansionReplaceTestDiagnostics {
  status: DeveloperExpansionReplaceTestStatus;
  matchStrategy: string;
  matchStart: number;
  matchEnd: number;
  matchedText: string;
  targetTextMatched: boolean;
  targetTextKey: string;
  candidateCount: number;
  contentOccurrencesBefore: number;
  contentOccurrencesAfter: number;
  charsBefore: number;
  charsAfter: number;
  deltaChars: number;
  error: string;
}

export interface DeveloperExpansionReplaceTestResult {
  success: boolean;
  status: DeveloperExpansionReplaceTestStatus;
  sectionId: string;
  sectionTitle: string;
  rawPatch: DeveloperExpansionReplacePatch;
  appliedPatch: DeveloperExpansionReplacePatch;
  diagnostics: DeveloperExpansionReplaceTestDiagnostics;
  applyError?: string;
  originalContent: string;
  selectedText: string;
  nextContent: string;
}

export interface LatestReleaseInfo {
  version: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
  download_url?: string;
  channel?: UpdateChannel;
}

export interface UpdateCheckResult {
  enabled: boolean;
  updateAvailable: boolean;
  version?: string;
  downloaded?: boolean;
  failed?: boolean;
  message?: string;
  channel?: UpdateChannel;
}

export interface UpdateInstallResult {
  success: boolean;
  message?: string;
}

export interface PluginUpdateInfo {
  id: string;
  name: string;
  installedVersion: string;
  version: string;
}

export interface PluginUpdateResult extends PluginUpdateInfo {
  success: boolean;
  message?: string;
}

export interface PluginUpdateAllResult {
  updates: PluginUpdateInfo[];
  results: PluginUpdateResult[];
}

export interface GpuHardwareAccelerationStatus {
  configured: boolean;
  enabled: boolean;
  currentEnabled: boolean;
  trial: boolean;
  forcedDisabled: boolean;
}

export type WorkspaceDatabasePhase = 'checking' | 'repairing' | 'backing-up' | 'upgrading' | 'cleaning' | 'ready' | 'error';

export interface WorkspaceDatabaseStatus {
  phase: WorkspaceDatabasePhase;
  ready: boolean;
  message: string;
  updatedAt?: string;
  currentVersion?: number;
  targetVersion?: number;
  migrationVersion?: number;
  migrationDescription?: string;
}

export type AgentSelfCheckStepStatus = 'pending' | 'running' | 'success' | 'warning' | 'error' | 'skipped';
export type AgentSelfCheckStatus = 'normal' | 'error' | 'busy';

export type AgentRuntimePhase = 'stopped' | 'starting' | 'idle' | 'running' | 'aborting' | 'unhealthy' | 'restarting' | 'closing';

export interface AgentRuntimeDescriptor {
  id: string;
  display_name: string;
  description: string;
  is_default: boolean;
}

export interface AgentRuntimeActiveTask {
  task_id: string;
  title: string;
  stage: string;
  progress_text: string;
  started_at: string;
  last_activity_at: string;
  last_progress_at?: string;
  elapsed_seconds: number;
  idle_seconds: number;
  waiting_for_user?: boolean;
}

export interface AgentQuestionOption {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
  custom: boolean;
}

export interface AgentQuestion {
  question_id: string;
  task_id: string;
  task_title: string;
  question: string;
  options: AgentQuestionOption[];
  asked_at: string;
  auto_answer_at?: string;
}

export interface AutoConfirmationState {
  enabled: boolean;
}

export interface AgentQuestionAnswerPayload {
  question_id: string;
  option_id: string;
  custom_answer?: string;
}

export interface AgentQuestionAnswerResult {
  success: boolean;
}

export type LicenseStatusValue = 'missing' | 'active' | 'expired' | 'invalid' | 'invalidated' | 'machine_mismatch' | 'refresh_failed' | 'debug_disabled';

export interface LicenseRuntimeStatus {
  status: LicenseStatusValue | string;
  plan: 'free' | 'personal_premium' | 'enterprise_premium' | string;
  expiresAt: string;
  licenseExpiresAt: string;
  licenseStatus: string;
  activationMode: 'online' | 'offline' | 'debug_disabled' | string;
  sourceTrusted: boolean;
  sourceTrustedText: string;
  untrustedReason: string;
  machineFingerprintHash: string;
  fingerprintVersion: string;
  buildTrusted: boolean;
  buildChanged: boolean;
  buildId: string;
  keyId: string;
  lastCheckedAt: string;
  refreshError?: string;
  config: {
    freeLicenseDays: number;
    expirePopupEnabled: boolean;
    expirePopupDismissible: boolean;
  };
}

export interface LicenseOfflineActivationResult {
  success: boolean;
  canceled?: boolean;
  message: string;
  status: LicenseRuntimeStatus;
}

export interface AgentRuntimeStatus {
  runtime_id: string;
  runtime_name: string;
  selected_runtime_id?: string;
  active_runtime_id?: string;
  phase: AgentRuntimePhase;
  healthy: boolean;
  message: string;
  updated_at: string;
  last_health_at?: string;
  last_health_error?: string;
  restart_pending?: boolean;
  restart_pending_reason?: string;
  active_task?: AgentRuntimeActiveTask | null;
  queued_count?: number;
  queued_tasks?: Array<{
    task_id: string;
    title: string;
    queued_at: string;
    position: number;
    runtime_id: string;
  }>;
  proxy?: {
    active: number;
    queued: number;
    limit: number;
  };
  runtime_details?: Record<string, unknown>;
}

export interface AgentRunFile {
  path: string;
  content: string;
}

export interface AgentRunPayload {
  task_id?: string;
  title?: string;
  task?: string;
  prompt?: string;
  output_file?: string;
  files?: AgentRunFile[];
  timeout_ms?: number;
  max_retries?: number;
  agent?: string;
}

export interface AgentRetryAttempt {
  attempt: number;
  at: string;
  error: string;
  output_chars: number;
}

export interface AgentRunResult {
  success: boolean;
  runtime_id: string;
  status?: 'busy' | string;
  skipped?: boolean;
  message?: string;
  task_id?: string;
  title?: string;
  workspace_dir?: string;
  runtime_workspace_dir?: string;
  runtime_root?: string;
  output_file?: string;
  output_content?: string;
  assistant_text?: string;
  diff?: unknown[];
  session_id?: string;
  retry_count?: number;
  retry_attempts?: AgentRetryAttempt[];
  validation_result?: unknown;
  active_task?: AgentRuntimeActiveTask | null;
  diagnostics?: Record<string, unknown>;
}

export type AgentMonitorEventType =
  | 'task_start'
  | 'task_input'
  | 'task_output'
  | 'assistant_delta'
  | 'assistant_end'
  | 'tool_start'
  | 'tool_update'
  | 'tool_end'
  | 'agent_start'
  | 'agent_end'
  | 'agent_settled'
  | 'turn_start'
  | 'turn_end'
  | 'compaction_start'
  | 'compaction_end'
  | 'auto_retry_start'
  | 'auto_retry_end'
  | 'retry'
  | 'task_end'
  | 'task_error';

export interface AgentMonitorEvent {
  sequence: number;
  at: string;
  type: AgentMonitorEventType;
  task_id: string;
  title?: string;
  workspace_dir?: string;
  stage_index?: number;
  workflow_stage?: string;
  prompt?: string;
  output_file?: string;
  files?: AgentRunFile[];
  delta?: string;
  text?: string;
  tool_call_id?: string;
  tool_name?: string;
  args?: unknown;
  partial_result?: unknown;
  result?: unknown;
  is_error?: boolean;
  attempt?: number;
  maximum?: number;
  delay_ms?: number;
  success?: boolean;
  final_error?: string;
  message?: string;
  output_content?: string;
  assistant_text?: string;
  retry_count?: number;
}

export interface AgentMonitorSnapshot {
  attached_at: string;
  active_task?: AgentRuntimeActiveTask | null;
  workspace_dir?: string;
}

export interface AgentSelfCheckStep {
  id: string;
  label: string;
  status: AgentSelfCheckStepStatus;
  message?: string;
  updated_at?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface AgentDiagnosticSection {
  id: string;
  title: string;
  status: AgentSelfCheckStepStatus | 'warning';
  summary?: string;
  details?: Array<{
    label: string;
    value: string;
  }>;
  items?: Array<{
    id: string;
    label: string;
    status: AgentSelfCheckStepStatus | 'warning';
    message?: string;
    detail?: string;
  }>;
}

export interface AgentSelfCheckResult {
  report_version?: number;
  check_id?: string;
  success: boolean;
  repaired?: boolean;
  runtime_id: string;
  runtime_name: string;
  status: AgentSelfCheckStatus;
  message: string;
  checked_at: string;
  duration_ms: number;
  log_dir: string;
  log_file: string;
  runtime_root: string;
  workspace_dir: string;
  output_file: string;
  output_path: string;
  output_content?: string;
  conclusion?: string;
  steps: AgentSelfCheckStep[];
  sections: AgentDiagnosticSection[];
  diagnostics?: Record<string, unknown>;
  error?: Record<string, unknown>;
  model_config?: Record<string, unknown>;
  model_check?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  loopback_check?: Record<string, unknown>;
  tool_check?: Record<string, unknown>;
  agent_check?: Record<string, unknown>;
  session_snapshot?: Record<string, unknown>;
  diagnosis?: Record<string, unknown>;
  repair?: Record<string, unknown>;
  detail_text: string;
  runtime_status?: AgentRuntimeStatus;
}

export interface AgentSelfCheckReportExportResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  message: string;
}

export interface AuditLogEntry {
  id: number;
  account_id: string | number | null;
  account_name: string | null;
  account_type: string;
  role: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: string;
  ip: string;
  created_at: string;
}

export interface KbAuthEmployee {
  id: string | number;
  username: string;
  display_name?: string;
  role: 'admin' | 'employee';
  status?: string;
  [key: string]: unknown;
}

export interface KbAuthStatus {
  loggedIn: boolean;
  serverUrl: string;
  employee: KbAuthEmployee | null;
}

export interface KbPermissionDef {
  key: string;
  label: string;
  description?: string;
}

export interface KbPermissionGroup {
  id: string | number;
  name: string;
  description?: string | null;
  permissions: string[];
  members: Array<{ id: string | number; display_name?: string; username?: string }>;
}

export interface KbAuthLoginPayload {
  username: string;
  password: string;
  serverUrl?: string;
}

export interface KbTeamFolder {
  id: string | number;
  name: string;
  parent_id?: string | number | null;
  owner_id?: string | number;
  owner_name?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface KbTeamDocument {
  id: string | number;
  name: string;
  original_name?: string;
  folder_id?: string | number | null;
  file_size?: number;
  uploaded_by?: string | number;
  uploaded_by_name?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface KbTeamTree {
  folders: KbTeamFolder[];
  documents: KbTeamDocument[];
}

export interface KbQaDocument {
  id: string | number;
  title: string;
  file_name?: string;
  mime_type?: string;
  folder_id?: string | number | null;
  created_at?: string;
  content_text: string;
  /** RAG 语义检索附加字段：相似度得分 */
  score?: number;
  /** RAG 语义检索附加字段：来源库（team/personal） */
  qa_source?: 'team' | 'personal';
}

/** RAG 语义检索选项 */
export interface KbQaRetrieveOptions {
  sources?: Array<'team' | 'personal'>;
  topK?: number;
  maxDocs?: number;
}

/* ---------- 知识库问答会话（服务器持久化，按账号隔离）---------- */

export type KbQaLibraryType = 'team' | 'personal';
export type KbQaSessionStatus = 'idle' | 'running' | 'error';
export type KbQaMessageStatus = 'pending' | 'done' | 'error';

/** 回答引用的知识库来源 */
export interface KbQaMessageSource {
  id?: string | number;
  title?: string;
  qa_source?: KbQaLibraryType;
}

export interface KbQaSession {
  id: number;
  employee_id: number;
  title: string;
  library_type: KbQaLibraryType;
  status: KbQaSessionStatus;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  /** 列表接口附加：消息条数 */
  message_count?: number;
  /** 列表接口附加：最后一条消息摘要 */
  preview?: string;
  /** 列表接口附加：最后一条消息状态，用于列表上标「生成中」 */
  last_status?: KbQaMessageStatus;
}

export interface KbQaStoredMessage {
  id: number;
  session_id: number;
  role: 'user' | 'assistant';
  content: string;
  status: KbQaMessageStatus;
  sources: KbQaMessageSource[];
  created_at: string;
  updated_at: string;
}

export interface KbQaAddMessagePayload {
  role: 'user' | 'assistant';
  content?: string;
  status?: KbQaMessageStatus;
  sources?: KbQaMessageSource[] | null;
}

export interface KbQaUpdateMessagePayload {
  content?: string;
  status?: KbQaMessageStatus;
  sources?: KbQaMessageSource[] | null;
}

export interface KbQaSessionResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface KbTrashFolder {
  id: string | number;
  name: string;
  parent_id?: string | number | null;
  owner_id?: string | number;
  created_at?: string;
  deleted_at?: string;
  deleted_by?: string | number;
  [key: string]: unknown;
}

export interface KbTrashDocument {
  id: string | number;
  document_id?: string | number;
  folder_id?: string | number | null;
  owner_id?: string | number;
  file_name?: string;
  created_at?: string;
  deleted_at?: string;
  deleted_by?: string | number;
  [key: string]: unknown;
}

export interface KbTrash {
  folders: KbTrashFolder[];
  documents: KbTrashDocument[];
}

export interface KbTeamUploadResult {
  success: boolean;
  uploaded?: KbTeamDocument[];
  errors?: Array<{ file: string; error: string }>;
  canceled?: boolean;
  error?: string;
  needLogin?: boolean;
}

export interface KbTeamResult {
  success: boolean;
  data?: unknown;
  error?: string;
  needLogin?: boolean;
}

export interface YibiaoBridge {
  appName: string;
  platform: string;
  getVersion: () => Promise<string>;
  // 把操作系统焦点拉回主窗口（中文输入法需要窗口级焦点才能输入）
  focusMainWindow: () => Promise<void>;
  getGpuHardwareAccelerationStatus: () => Promise<GpuHardwareAccelerationStatus>;
  saveGpuHardwareAccelerationPreference: (enabled: boolean) => Promise<ConfigSaveResult & { enabled: boolean; configured: boolean; restartRequired: boolean }>;
  startGpuHardwareAccelerationTrial: () => Promise<{ success: boolean }>;
  relaunchWithGpuHardwareAccelerationDisabled: () => Promise<{ success: boolean }>;
  requiredOnlineServices: {
    getStatus: () => Promise<RequiredOnlineServicesStatus>;
  };
  getLatestVersion: () => Promise<LatestReleaseInfo>;
  getUpdateDownloadUrl: () => Promise<string>;
  openExternal: (url: string) => Promise<{ success: boolean; message?: string }>;
  checkUpdate: () => Promise<UpdateCheckResult>;
  startUpdate: () => Promise<UpdateCheckResult>;
  quitAndInstall: () => Promise<UpdateInstallResult>;
  onUpdateProgress: (callback: (event: { percent: number }) => void) => () => void;
  onUpdateDownloaded: (callback: (event: { version: string }) => void) => () => void;
  onUpdateError: (callback: (event: { message: string }) => void) => () => void;
  onPluginUpdatesAvailable: (callback: (updates: PluginUpdateInfo[]) => void) => () => void;
  database: {
    getStatus: () => Promise<WorkspaceDatabaseStatus>;
    onStatus: (callback: (status: WorkspaceDatabaseStatus) => void) => () => void;
  };
  ui: {
    setCurrentView: (view: { section: string; step?: string | null }) => Promise<{ success: boolean }>;
  };
  config: {
    load: () => Promise<ClientConfig>;
    save: (config: ClientConfig) => Promise<ConfigSaveResult>;
    listModels: (config?: ClientConfig) => Promise<ModelListResult>;
    getModelInfo: (modelName: string) => Promise<ModelInfoResult>;
    openConfigFolder: () => Promise<{ success: boolean; path: string }>;
    // 全局模型配置（服务端托管，管理员设置，全员生效）
    loadGlobal: () => Promise<{
      success?: boolean;
      status?: number;
      error?: string;
      data?: {
        base_url?: string;
        analysis_model?: string;
        qa_model?: string;
        embedding_model?: string;
        file_parser_provider?: string;
        pdf_image_parser_provider?: string;
        analysis_concurrency?: number;
        has_mineru_token?: boolean;
        has_api_key?: boolean;
        updated_at?: string | null;
      };
    }>;
    saveGlobal: (cfg: { base_url?: string; api_key?: string; analysis_model?: string; qa_model?: string; embedding_model?: string | null; file_parser_provider?: string; pdf_image_parser_provider?: string; mineru_token?: string; analysis_concurrency?: number }) => Promise<{ success?: boolean; status?: number; error?: string; [key: string]: unknown }>;
    testMineruParse: (payload: { provider: string; mineru_token: string }) => Promise<{ success?: boolean; status?: number; error?: string; message?: string; markdown?: string; char_count?: number; provider?: string; canceled?: boolean }>;
    listModelsGlobal: () => Promise<{ success: boolean; models: string[]; error?: string; message?: string }>;
  };
  license: {
    getStatus: () => Promise<LicenseRuntimeStatus>;
    refresh: () => Promise<LicenseRuntimeStatus>;
    importOfflineFile: () => Promise<LicenseOfflineActivationResult>;
    activateOfflineCode: (code: string) => Promise<LicenseOfflineActivationResult>;
  };
  ai: {
    chat: (request: ChatCompletionRequest) => Promise<string>;
    requestJson: <TResult = unknown>(request: JsonCompletionRequest) => Promise<TResult>;
    testTextModel: (config: ClientConfig) => Promise<TextModelTestResult>;
    testImageModel: (config: ClientConfig) => Promise<ImageModelTestResult>;
    testEmbeddingModel: (config: ClientConfig) => Promise<TextModelTestResult>;
    onHttpError: (callback: (event: AiHttpErrorPayload) => void) => () => void;
  };
  autoConfirmation: {
    getState: () => Promise<AutoConfirmationState>;
    setEnabled: (enabled: boolean) => Promise<ConfigSaveResult & AutoConfirmationState>;
    onChanged: (callback: (state: AutoConfirmationState) => void) => () => void;
  };
  agent: {
    listRuntimes: () => Promise<AgentRuntimeDescriptor[]>;
    run: (payload: AgentRunPayload, runtimeId?: string) => Promise<AgentRunResult>;
    selfCheck: (runtimeId?: string) => Promise<AgentSelfCheckResult>;
    exportSelfCheckReport: (payload: AgentSelfCheckResult) => Promise<AgentSelfCheckReportExportResult>;
    getStatus: (runtimeId?: string) => Promise<AgentRuntimeStatus>;
    restart: (reason?: string, runtimeId?: string) => Promise<AgentRuntimeStatus>;
    getPendingQuestion: () => Promise<AgentQuestion | null>;
    answerQuestion: (payload: AgentQuestionAnswerPayload) => Promise<AgentQuestionAnswerResult>;
    suppressQuestionAutoAnswer: (payload: { question_id: string }) => Promise<{ success: boolean }>;
    onStatus: (callback: (status: AgentRuntimeStatus) => void) => () => void;
    onQuestion: (callback: (question: AgentQuestion | null) => void) => () => void;
  };
  developerTokenStats: {
    openWindow: () => Promise<{ success: boolean }>;
    get: () => Promise<DeveloperTextTokenStats>;
    reset: () => Promise<DeveloperTextTokenStats>;
    onChanged: (callback: (stats: DeveloperTextTokenStats) => void) => () => void;
  };
  developerAgentMonitor: {
    openWindow: () => Promise<{ success: boolean }>;
    openWorkspace: (workspaceDir: string) => Promise<{ success: boolean; path: string }>;
    attach: () => Promise<AgentMonitorSnapshot>;
    detach: () => Promise<{ success: boolean }>;
    onEvent: (callback: (event: AgentMonitorEvent) => void) => () => void;
  };
  developerExpansionReplaceTest: {
    run: (payload: DeveloperExpansionReplaceTestPayload) => Promise<DeveloperExpansionReplaceTestResult>;
  };
  file: {
    selectDuplicateCheckFiles: (options?: { multiple?: boolean; filePaths?: string[] }) => Promise<FileSelectionResult>;
    /** 把拖拽进来的 File 对象换成本地绝对路径，供各上传区拖拽导入使用 */
    getPathForFile: (file: File) => string;
  };
  knowledgeBase: {
    list: () => Promise<KnowledgeBaseIndex>;
    createFolder: (name: string) => Promise<KnowledgeFolder>;
    renameFolder: (folderId: string, name: string) => Promise<KnowledgeFolder>;
    reorderFolder: (draggedFolderId: string, targetFolderId: string, position: 'before' | 'after') => Promise<KnowledgeBaseIndexMutationResult>;
    deleteFolder: (folderId: string) => Promise<KnowledgeBaseMutationResult>;
    deleteDocument: (documentId: string) => Promise<KnowledgeBaseMutationResult>;
    moveDocument: (documentId: string, targetFolderId: string, targetDocumentId?: string | null, position?: 'before' | 'after') => Promise<KnowledgeBaseIndexMutationResult>;
    uploadDocuments: (folderId: string) => Promise<KnowledgeBaseUploadResult>;
    retryDocument: (documentId: string) => Promise<KnowledgeBaseRetryDocumentResult>;
    startMatching: (documentId: string, batchSize?: number) => Promise<KnowledgeBaseStartMatchingResult>;
    readMarkdown: (documentId: string) => Promise<string>;
    readItems: (documentId: string) => Promise<KnowledgeItem[]>;
    readAnalysis: (documentId: string) => Promise<KnowledgeAnalysisSnapshot>;
    analyzeExternalFile: (documentId: string | number, filePath: string, fileName: string, folderId: string | number, libraryType?: 'team' | 'personal') => Promise<KnowledgeDocument>;
    hydrateTeamAnalysis: (documentId: string | number, folderId: string | number) => Promise<{
      id: string; status: KnowledgeDocument['status']; progress: number; message: string;
      item_count: number; block_count: number; filtered_block_count: number;
      candidate_item_count: number; file_name: string;
    } | null>;
    hydratePersonalAnalysis: (documentId: string | number, folderId: string | number) => Promise<{
      id: string; status: KnowledgeDocument['status']; progress: number; message: string;
      item_count: number; block_count: number; filtered_block_count: number;
      candidate_item_count: number; file_name: string;
    } | null>;
    getLocalStatus: (documentId: string | number) => Promise<{
      id: string; status: KnowledgeDocument['status']; progress: number; message: string;
      item_count: number; block_count: number; filtered_block_count: number;
      candidate_item_count: number; file_name: string;
    } | null>;
    deleteLocalAnalysis: (documentId: string | number) => Promise<{ success: boolean; message: string }>;
    onEvent: (callback: (event: KnowledgeBaseEvent) => void) => () => void;
  };
  technicalPlan: {
    loadState: () => Promise<TechnicalPlanState>;
    importTenderDocument: (filePaths?: string[]) => Promise<{
      success: boolean;
      message?: string;
      markdown?: string;
      fileName?: string;
      parserLabel?: string | null;
    }>;
    removeTenderDocument: (sourceId: string) => Promise<{
      success: boolean;
      message?: string;
      markdown?: string;
    }>;
    importOriginalPlanDocument: (filePaths?: string[]) => Promise<{
      success: boolean;
      message?: string;
      markdown?: string;
    }>;
    checkBidSections: () => Promise<{ hasMultiple: boolean; totalDeclared?: number | null }>;
    selectBidSection: (selectedSection: DetectedBidSection) => Promise<{ success: boolean; message?: string; markdown: string }>;
    readTenderMarkdown: () => Promise<string>;
    readTenderSourceMarkdown: (sourceId: string) => Promise<string>;
    readOriginalPlanMarkdown: () => Promise<string>;
    updateStep: (step: TechnicalPlanStep) => Promise<void>;
    setWorkflowKind: (workflowKind: TechnicalPlanWorkflowKind) => Promise<void>;
    switchWorkflowKind: (workflowKind: TechnicalPlanWorkflowKind) => Promise<void>;
    saveBidAnalysisConfig: (payload: { mode: BidAnalysisMode; selectedTaskIds: string[]; bidSectionMode?: BidSectionMode }) => Promise<void>;
    saveOutlineConfig: (payload: { referenceKnowledgeDocumentIds: string[]; outlineMode?: OutlineMode; outlineExpansionMode?: OutlineExpansionMode; wordControlOptions: OutlineWordControlOptions }) => Promise<void>;
    saveOutlineSelection: (payload: SaveOutlineSelectionRequest) => Promise<{ success: boolean }>;
    saveOutline: (payload: SaveOutlineRequest) => Promise<Partial<TechnicalPlanState>>;
    saveGlobalFactsConfig: (payload: { globalFactsMode: GlobalFactsMode }) => Promise<Partial<TechnicalPlanState>>;
    saveGlobalFacts: (globalFacts: GlobalFactGroupState[]) => Promise<Partial<TechnicalPlanState>>;
    saveContentGenerationOptions: (options: ContentGenerationOptions) => Promise<Partial<TechnicalPlanState>>;
    saveChapterContent: (payload: { nodeId: string; content: string }) => Promise<Partial<TechnicalPlanState>>;
    clear: () => Promise<{ success: boolean; message?: string }>;
  };
  feasibilityReport: {
    loadState: () => Promise<FeasibilityReportState>;
    importSourceDocuments: (filePaths?: string[]) => Promise<{ success: boolean; message?: string; sourceFiles?: FeasibilitySourceFile[] }>;
    removeSourceDocument: (sourceId: string) => Promise<{ success: boolean; message?: string; sourceFiles?: FeasibilitySourceFile[] }>;
    readSourceMarkdown: (sourceId: string) => Promise<string>;
    readCombinedSourceMarkdown: () => Promise<string>;
    updateStep: (step: FeasibilityReportStep) => Promise<void>;
    saveProjectInfo: (projectInfo: FeasibilityProjectInfo) => Promise<FeasibilityReportState>;
    saveAnalysis: (markdown: string) => Promise<FeasibilityReportState>;
    saveOutlineConfig: (payload: { outlineTemplate?: string; targetWords?: number; referenceDocumentIds?: string[] }) => Promise<FeasibilityReportState>;
    saveOutline: (payload: FeasibilitySaveOutlineRequest) => Promise<Partial<FeasibilityReportState>>;
    saveKeyParameters: (markdown: string) => Promise<FeasibilityReportState>;
    saveChapterContent: (payload: { nodeId: string; content: string }) => Promise<Partial<FeasibilityReportState>>;
    clear: () => Promise<{ success: boolean; message?: string }>;
  };
  duplicateCheck: {
    loadState: () => Promise<DuplicateCheckWorkspaceState>;
    saveFiles: (payload: Pick<DuplicateCheckWorkspaceState, 'tenderFile' | 'tenderFiles' | 'bidFiles'> & Partial<Pick<DuplicateCheckWorkspaceState, 'step' | 'activeAnalysisTab'>>) => Promise<void>;
    saveUiState: (payload: Partial<Pick<DuplicateCheckWorkspaceState, 'step' | 'activeAnalysisTab'>>) => Promise<void>;
    updateState: (partial: DuplicateCheckWorkspacePatch) => Promise<void>;
    clear: () => Promise<{ success: boolean; message?: string }>;
  };
  rejectionCheck: {
    loadState: () => Promise<RejectionCheckWorkspaceState>;
    importDocument: (role: RejectionDocumentRole, filePaths?: string[]) => Promise<{ success: boolean; message?: string }>;
    importTenderFromTechnicalPlan: () => Promise<{ success: boolean; message?: string }>;
    removeDocument: (role: RejectionDocumentRole, documentId?: string) => Promise<void>;
    saveUiState: (payload: Partial<Pick<RejectionCheckWorkspaceState, 'step' | 'activeDocumentTab' | 'activeResultTab' | 'activeCheckResultTab' | 'customCheckItems' | 'checkOptions'>>) => Promise<void>;
    updateState: (partial: RejectionCheckWorkspacePatch) => Promise<void>;
    clear: () => Promise<{ success: boolean; message?: string }>;
  };
  templates: {
    list: () => Promise<ExportTemplateRecord[]>;
    get: (templateId: string) => Promise<ExportTemplateRecord | null>;
    create: (config: ExportFormatConfig) => Promise<ExportTemplateRecord>;
    update: (templateId: string, config: ExportFormatConfig) => Promise<ExportTemplateRecord>;
    delete: (templateId: string) => Promise<{ success: boolean; message: string }>;
  };
  tasks: {
    startBidSectionExtraction: (payload?: unknown) => Promise<unknown>;
    startBidAnalysis: (payload: unknown) => Promise<unknown>;
    startOutlineGeneration: (payload: unknown) => Promise<unknown>;
    startOutlineGenerationStep: (payload: unknown) => Promise<unknown>;
    cancelOutlineGeneration: () => Promise<unknown>;
    suppressOutlineSelectionAutoConfirmation: (payload: { taskId: string }) => Promise<{ success: boolean }>;
    startGlobalFactsGeneration: (payload: unknown) => Promise<unknown>;
    startContentGeneration: (payload: unknown) => Promise<unknown>;
    pauseContentGeneration: () => Promise<unknown>;
    startRejectionItemsExtraction: (payload: unknown) => Promise<unknown>;
    startRejectionCheck: (payload: unknown) => Promise<unknown>;
    startDuplicateAnalysis: (payload: unknown) => Promise<unknown>;
    startFeasibilityAnalysis: (payload?: unknown) => Promise<unknown>;
    startFeasibilityOutline: (payload?: unknown) => Promise<unknown>;
    startFeasibilityParameters: (payload?: unknown) => Promise<unknown>;
    startFeasibilityContent: (payload?: unknown) => Promise<unknown>;
    pauseFeasibilityContent: () => Promise<unknown>;
    startFeasibilityHumanWriting: (payload?: unknown) => Promise<unknown>;
    getActiveTasks: () => Promise<TaskEventTask[]>;
    onTaskEvent: <TState = unknown, TRejectionCheckState = unknown, TDuplicateCheckState = unknown>(callback: (event: TaskEvent<TState, TRejectionCheckState, TDuplicateCheckState>) => void) => () => void;
  };
  export: {
    exportWord: (payload: unknown) => Promise<WordExportResult>;
    openFile: (filePath: string) => Promise<{ success: boolean }>;
    onWordExportProgress: (callback: (event: WordExportProgressEvent) => void) => () => void;
  };
  systemFonts: {
    list: () => Promise<string[]>;
  };
  kbAuth: {
    login: (payload: KbAuthLoginPayload) => Promise<{ success: boolean; employee?: KbAuthEmployee | null; error?: string }>;
    logout: () => Promise<{ success: boolean }>;
    getStatus: () => Promise<KbAuthStatus>;
    me: () => Promise<KbAuthEmployee | null>;
    setServer: (serverUrl: string) => Promise<{ success: boolean; serverUrl: string }>;
    register: (payload: { username: string; password: string; display_name?: string; department?: string; serverUrl?: string }) => Promise<{ success: boolean; error?: string }>;
    onSessionExpired: (callback: (payload: unknown) => void) => () => void;
    listEmployees: () => Promise<{ success: boolean; data?: KbAuthEmployee[]; error?: string }>;
    listPending: () => Promise<{ success: boolean; data?: KbAuthEmployee[]; error?: string }>;
    review: (payload: { user_id: string | number; action: 'approve' | 'reject'; reject_reason?: string }) => Promise<{ success: boolean; error?: string; message?: string }>;
    resetPassword: (payload: { user_id: string | number; new_password: string }) => Promise<{ success: boolean; error?: string; message?: string }>;
    verifyAdminPassword: (payload: { password: string }) => Promise<{ success: boolean; error?: string; message?: string }>;
    setStatus: (payload: { user_id: string | number; status: string }) => Promise<{ success: boolean; error?: string; message?: string }>;
    deleteEmployee: (payload: { user_id: string | number }) => Promise<{ success: boolean; error?: string; message?: string }>;
    updateEmployee: (payload: { user_id: string | number; fields: { display_name?: string; department?: string | null; role?: string; status?: string; group_ids?: Array<string | number> } }) => Promise<{ success: boolean; error?: string; message?: string }>;
    listPermissions: () => Promise<{ success: boolean; data?: KbPermissionDef[]; error?: string }>;
    listGroups: () => Promise<{ success: boolean; data?: KbPermissionGroup[]; error?: string }>;
    createGroup: (payload: { name: string; description?: string }) => Promise<{ success: boolean; data?: KbPermissionGroup; error?: string }>;
    deleteGroup: (payload: { group_id: string | number }) => Promise<{ success: boolean; error?: string }>;
    setGroupPermissions: (payload: { group_id: string | number; permissions: string[] }) => Promise<{ success: boolean; error?: string }>;
    addGroupMember: (payload: { group_id: string | number; employee_id: string | number }) => Promise<{ success: boolean; error?: string }>;
    removeGroupMember: (payload: { group_id: string | number; employee_id: string | number }) => Promise<{ success: boolean; error?: string }>;
    adminCreateEmployee: (payload: { username: string; password: string; display_name: string; department?: string; role?: string; status?: string }) => Promise<{ success: boolean; error?: string; message?: string }>;
    listAudit: (payload?: { limit?: number }) => Promise<{ success: boolean; data?: AuditLogEntry[]; error?: string }>;
  };
  kbTeam: {
    getTree: () => Promise<{ success: boolean; data?: KbTeamTree; error?: string; needLogin?: boolean }>;
    createFolder: (name: string, parentId?: string | number) => Promise<{ success: boolean; data?: KbTeamFolder; error?: string; needLogin?: boolean }>;
    deleteFolder: (folderId: string | number) => Promise<KbTeamResult>;
    deleteDocument: (documentId: string | number) => Promise<KbTeamResult>;
    uploadDocument: (folderId?: string | number, onProgress?: (percent: number) => void) => Promise<KbTeamUploadResult>;
    downloadDocument: (documentId: string | number, originalName?: string) => Promise<{ success: boolean; data?: { localPath: string }; error?: string; needLogin?: boolean }>;
    searchDocuments: (query: string) => Promise<{ success: boolean; data?: KbTeamDocument[]; error?: string }>;
    getDocumentVersions: (documentId: string | number) => Promise<{ success: boolean; data?: Array<{ version: number; created_at: string; note: string }>; error?: string }>;
    listDocuments: (folderId?: string | number, searchQuery?: string) => Promise<{ success: boolean; data?: KbTeamDocument[]; error?: string }>;
    renameFolder: (folderId: string | number, name: string) => Promise<KbTeamResult>;
    moveFolder: (folderId: string | number, parentId?: string | number | null) => Promise<KbTeamResult>;
    renameDocument: (documentId: string | number, name: string) => Promise<KbTeamResult>;
    moveDocument: (documentId: string | number, folderId: string | number) => Promise<KbTeamResult>;
    search: (query: string, mode?: 'name' | 'content') => Promise<{ success: boolean; data?: KbTeamDocument[]; error?: string; needLogin?: boolean }>;
    qaRetrieve: (query: string, limit?: number) => Promise<{ success: boolean; data?: KbQaDocument[]; error?: string; needLogin?: boolean }>;
    listTrash: () => Promise<{ success: boolean; data?: KbTrash; error?: string; needLogin?: boolean }>;
    restoreFromTrash: (type: 'folder' | 'document', id: string | number) => Promise<KbTeamResult>;
    exportZip: (ids: Array<string | number>) => Promise<{ success: boolean; data?: { localPath: string }; error?: string; canceled?: boolean; needLogin?: boolean }>;
    getAnalysisStatus: (documentId: string | number) => Promise<{ success: boolean; data?: { status: string; progress: number; message: string; item_count?: number; candidate_item_count?: number; block_count?: number; filtered_block_count?: number }; error?: string; needLogin?: boolean }>;
    retryAnalysis: (documentId: string | number) => Promise<{ success: boolean; data?: { success?: boolean; message?: string }; error?: string; needLogin?: boolean }>;
  },
  kbQa: {
    retrieveContext: (question: string, options?: KbQaRetrieveOptions) => Promise<{ success: boolean; data?: KbQaDocument[]; warnings?: string[]; error?: string }>;
    clearIndex: (source?: 'team' | 'personal') => Promise<{ success: boolean; error?: string }>;
    expandRelated: (seedDocs: KbQaDocument[], source: 'team' | 'personal', limit?: number) => Promise<{ success: boolean; data?: KbQaDocument[]; error?: string }>;
    buildGraph: (source: 'team' | 'personal' | 'both') => Promise<{ success: boolean; entityCount?: number; relationCount?: number; error?: string }>;
    graphFind: (question: string, source: 'team' | 'personal' | 'both', limit?: number) => Promise<{ success: boolean; docs?: KbQaDocument[]; graph?: { entities: Array<{ name: string; type?: string }>; relations: Array<{ subject: string; predicate: string; object: string; evidence?: string }> }; empty?: boolean; error?: string }>;
    graphStatus: (source: 'team' | 'personal' | 'both') => Promise<{ success: boolean; entityCount?: number; relationCount?: number; error?: string }>;
    clearGraph: (source: 'team' | 'personal') => Promise<{ success: boolean; error?: string }>;
    onBuildGraphProgress: (listener: (payload: { phase: string; message: string; done: number; total: number }) => void) => () => void;
  };
  kbQaSession: {
    list: (limit?: number) => Promise<KbQaSessionResult<KbQaSession[]>>;
    create: (options?: { title?: string | null; libraryType?: KbQaLibraryType }) => Promise<KbQaSessionResult<KbQaSession>>;
    rename: (sessionId: number, title: string) => Promise<KbQaSessionResult<KbQaSession>>;
    setStatus: (sessionId: number, status: KbQaSessionStatus) => Promise<KbQaSessionResult<KbQaSession>>;
    remove: (sessionId: number) => Promise<KbQaSessionResult<{ success: boolean }>>;
    clear: () => Promise<KbQaSessionResult<{ removed: number }>>;
    listMessages: (sessionId: number, afterId?: number) => Promise<KbQaSessionResult<KbQaStoredMessage[]>>;
    addMessage: (sessionId: number, payload: KbQaAddMessagePayload) => Promise<KbQaSessionResult<KbQaStoredMessage>>;
    updateMessage: (messageId: number, payload: KbQaUpdateMessagePayload) => Promise<KbQaSessionResult<KbQaStoredMessage>>;
  };
  plugins: {
    getAvailablePlugins: () => Promise<AvailablePlugin[]>;
    install: (pluginId: string) => Promise<void>;
    installOffline: () => Promise<OfflinePluginInstallResult>;
    uninstall: (pluginId: string) => Promise<void>;
    enable: (pluginId: string) => Promise<void>;
    disable: (pluginId: string) => Promise<void>;
    update: (pluginId: string) => Promise<void>;
    checkUpdates: () => Promise<PluginUpdateInfo[]>;
    updateAll: () => Promise<PluginUpdateAllResult>;
    openConfig: (pluginId: string) => Promise<void>;
    refreshMarket: () => Promise<void>;
    clearUpdateFailedState: (pluginId: string) => Promise<boolean>;
    notifyEvent: (pluginId: string, event: string, payload?: unknown) => Promise<void>;
  },
  kbPersonal: {
    getTree: () => Promise<{ success: boolean; data?: KbTeamTree; error?: string; needLogin?: boolean }>;
    listFolders: () => Promise<{ success: boolean; data?: any[]; error?: string; needLogin?: boolean }>;
    listDocuments: (folderId: string) => Promise<{ success: boolean; data?: any[]; error?: string; needLogin?: boolean }>;
    downloadDocument: (documentId: string, destPath?: string) => Promise<{ success: boolean; data?: { localPath: string }; error?: string }>;
    searchDocuments: (keyword: string, mode?: 'name' | 'content') => Promise<{ success: boolean; data?: any[]; error?: string; needLogin?: boolean }>;
    qaRetrieve: (keyword: string, limit?: number) => Promise<{ success: boolean; data?: KbQaDocument[]; error?: string; needLogin?: boolean }>;
    createFolder: (name: string, parentId?: string | null) => Promise<{ success: boolean; data?: KbTeamFolder; error?: string }>;
    uploadDocument: (folderId: string) => Promise<{ success: boolean; data?: { uploaded: Array<{ file: string; doc: KbTeamDocument }>; failed: Array<{ file: string; error: string }>; canceled: boolean }; error?: string }>;
    deleteFolder: (folderId: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    deleteDocument: (documentId: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    moveFolder: (folderId: string, parentId?: string | null) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    renameFolder: (folderId: string, name: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    renameDocument: (documentId: string, name: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    moveDocument: (documentId: string, folderId: string | number) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    listTrash: () => Promise<{ success: boolean; data?: KbTrash; error?: string }>;
    restoreFromTrash: (type: 'folder' | 'document', id: string | number) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    exportZip: (ids: Array<string | number>) => Promise<{ success: boolean; data?: { localPath: string }; error?: string; canceled?: boolean }>;
    importToTeam: (documentIds: Array<string | number>, targetTeamFolderId: string | number, folderIds?: Array<string | number>) => Promise<{ success: boolean; data?: { created: Array<{ document_id: string | number; remote_id: number; file_name?: string; analysis_synced?: boolean }>; failed: Array<{ document_id: string | number; error: string }>; auto_folder?: boolean; folder_name?: string; folder_id?: string }; error?: string }>;
    importFromTeam: (documentIds: Array<string | number>, folderIds?: Array<string | number>) => Promise<{ success: boolean; data?: { synced: Array<{ id: number; ok: boolean; personal_id?: string; folder_id?: string; file_name?: string; msg: string }> }; error?: string }>;
    getAnalysisStatus: (documentId: string | number) => Promise<{ success: boolean; data?: { status: string; progress: number; message: string; item_count?: number; candidate_item_count?: number; block_count?: number; filtered_block_count?: number }; error?: string; needLogin?: boolean }>;
    retryAnalysis: (documentId: string | number) => Promise<{ success: boolean; data?: { success?: boolean; message?: string }; error?: string; needLogin?: boolean }>;
  };
  kbVault: {
    getPath: () => Promise<{ success: boolean; data?: { vaultPath: string }; error?: string }>;
    setPath: (p: string) => Promise<{ success: boolean; data?: { vaultPath: string }; error?: string }>;
    export: () => Promise<{ success: boolean; exported?: number; skipped?: number; vaultPath?: string; error?: string }>;
    import: () => Promise<{ success: boolean; changed?: Array<{ id: string; file: string }>; vaultPath?: string; error?: string }>;
    open: () => Promise<{ success: boolean; openedWith?: 'obsidian' | 'explorer'; vaultPath?: string; error?: string }>;
  };
}

export type OfflinePluginInstallResult =
  | { canceled: true }
  | {
      canceled: false;
      id: string;
      name: string;
      version: string;
      previousVersion: string | null;
      updated: boolean;
      enabled: boolean;
    };

export interface AvailablePlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  repository: string;
  releaseUrl: string;
  tags: string[];
  iconUrl: string;
  downloadCount: number;
  installed: boolean;
  installedVersion?: string;
  enabled: boolean;
  hasConfig: boolean;
  hasUpdate?: boolean;
  updating?: boolean;
  updateFailed?: {
    stage: string;
    message: string;
  };
}
