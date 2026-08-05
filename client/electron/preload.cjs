const { contextBridge, ipcRenderer } = require('electron');

const bridge = {
  appName: '易标投标工具箱',
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  focusMainWindow: () => ipcRenderer.invoke('app:focus-main-window'),
  getGpuHardwareAccelerationStatus: () => ipcRenderer.invoke('app:get-gpu-hardware-acceleration-status'),
  saveGpuHardwareAccelerationPreference: (enabled) => ipcRenderer.invoke('app:save-gpu-hardware-acceleration-preference', enabled),
  startGpuHardwareAccelerationTrial: () => ipcRenderer.invoke('app:start-gpu-hardware-acceleration-trial'),
  relaunchWithGpuHardwareAccelerationDisabled: () => ipcRenderer.invoke('app:relaunch-with-gpu-hardware-acceleration-disabled'),
  requiredOnlineServices: {
    getStatus: () => ipcRenderer.invoke('required-online-services:get-status'),
  },
  getLatestVersion: () => ipcRenderer.invoke('app:get-latest-version'),
  getUpdateDownloadUrl: () => ipcRenderer.invoke('app:get-update-download-url'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  startUpdate: () => ipcRenderer.invoke('app:start-update'),
  quitAndInstall: () => ipcRenderer.invoke('app:quit-and-install'),
  onUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-progress', listener);
    return () => ipcRenderer.removeListener('app:update-progress', listener);
  },
  onUpdateDownloaded: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-downloaded', listener);
    return () => ipcRenderer.removeListener('app:update-downloaded', listener);
  },
  onUpdateError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-error', listener);
    return () => ipcRenderer.removeListener('app:update-error', listener);
  },
  database: {
    getStatus: () => ipcRenderer.invoke('workspace-database:get-status'),
    onStatus: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('workspace-database:status', listener);
      return () => ipcRenderer.removeListener('workspace-database:status', listener);
    },
  },
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config) => ipcRenderer.invoke('config:save', config),
    listModels: (config) => ipcRenderer.invoke('config:list-models', config),
    getModelInfo: (modelName) => ipcRenderer.invoke('config:get-model-info', modelName),
    openConfigFolder: () => ipcRenderer.invoke('config:open-config-folder'),
    loadGlobal: () => ipcRenderer.invoke('config:load-global'),
    saveGlobal: (cfg) => ipcRenderer.invoke('config:save-global', cfg),
    listModelsGlobal: () => ipcRenderer.invoke('config:list-models-global'),
    testMineruParse: (payload) => ipcRenderer.invoke('config:test-mineru-parse', payload),
  },
  license: {
    getStatus: () => ipcRenderer.invoke('license:get-status'),
    refresh: () => ipcRenderer.invoke('license:refresh'),
    importOfflineFile: () => ipcRenderer.invoke('license:import-offline-file'),
    activateOfflineCode: (code) => ipcRenderer.invoke('license:activate-offline-code', code),
  },
  ai: {
    chat: (request) => ipcRenderer.invoke('ai:chat', request),
    requestJson: (request) => ipcRenderer.invoke('ai:request-json', request),
    testTextModel: (config) => ipcRenderer.invoke('ai:test-text-model', config),
    testImageModel: (config) => ipcRenderer.invoke('ai:test-image-model', config),
    testEmbeddingModel: (config) => ipcRenderer.invoke('ai:test-embedding-model', config),
    onHttpError: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('ai:http-error', listener);
      return () => ipcRenderer.removeListener('ai:http-error', listener);
    },
  },
  agent: {
    run: (payload) => ipcRenderer.invoke('agent:run', payload),
    selfCheck: (runtimeId) => ipcRenderer.invoke('agent:self-check', runtimeId),
    exportSelfCheckReport: (payload) => ipcRenderer.invoke('agent:export-self-check-report', payload),
    getStatus: () => ipcRenderer.invoke('agent:get-status'),
    restart: (reason) => ipcRenderer.invoke('agent:restart', reason),
    listRuntimes: () => ipcRenderer.invoke('agent:list-runtimes'),
    onStatus: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('agent:status', listener);
      return () => ipcRenderer.removeListener('agent:status', listener);
    },
  },
  developerTokenStats: {
    openWindow: () => ipcRenderer.invoke('developer-token-stats:open-window'),
    get: () => ipcRenderer.invoke('developer-token-stats:get'),
    reset: () => ipcRenderer.invoke('developer-token-stats:reset'),
    onChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('developer-token-stats:changed', listener);
      return () => ipcRenderer.removeListener('developer-token-stats:changed', listener);
    },
  },
  developerAgentMonitor: {
    openWindow: () => ipcRenderer.invoke('developer-agent-monitor:open-window'),
    attach: () => ipcRenderer.invoke('developer-agent-monitor:attach'),
    detach: () => ipcRenderer.invoke('developer-agent-monitor:detach'),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('developer-agent-monitor:event', listener);
      return () => ipcRenderer.removeListener('developer-agent-monitor:event', listener);
    },
  },
  developerExpansionReplaceTest: {
    run: (payload) => ipcRenderer.invoke('developer-expansion-replace-test:run', payload),
  },
  file: {
    selectDuplicateCheckFiles: (options) => ipcRenderer.invoke('file:select-duplicate-check-files', options),
  },
  knowledgeBase: {
    getMigrationStatus: () => ipcRenderer.invoke('knowledge-base:get-migration-status'),
    migrateLegacy: () => ipcRenderer.invoke('knowledge-base:migrate-legacy'),
    list: () => ipcRenderer.invoke('knowledge-base:list'),
    createFolder: (name) => ipcRenderer.invoke('knowledge-base:create-folder', name),
    renameFolder: (folderId, name) => ipcRenderer.invoke('knowledge-base:rename-folder', folderId, name),
    reorderFolder: (draggedFolderId, targetFolderId, position) => ipcRenderer.invoke('knowledge-base:reorder-folder', draggedFolderId, targetFolderId, position),
    deleteFolder: (folderId) => ipcRenderer.invoke('knowledge-base:delete-folder', folderId),
    deleteDocument: (documentId) => ipcRenderer.invoke('knowledge-base:delete-document', documentId),
    moveDocument: (documentId, targetFolderId, targetDocumentId, position) => ipcRenderer.invoke('knowledge-base:move-document', documentId, targetFolderId, targetDocumentId, position),
    uploadDocuments: (folderId) => ipcRenderer.invoke('knowledge-base:upload-documents', folderId),
    retryDocument: (documentId) => ipcRenderer.invoke('knowledge-base:retry-document', documentId),
    startMatching: (documentId, batchSize) => ipcRenderer.invoke('knowledge-base:start-matching', documentId, batchSize), // batchSize 已忽略
    readMarkdown: (documentId) => ipcRenderer.invoke('knowledge-base:read-markdown', documentId),
    readItems: (documentId) => ipcRenderer.invoke('knowledge-base:read-items', documentId),
    readAnalysis: (documentId) => ipcRenderer.invoke('knowledge-base:read-analysis', documentId),
    analyzeExternalFile: (documentId, filePath, fileName, folderId, libraryType) => ipcRenderer.invoke('knowledge-base:analyze-external-file', documentId, filePath, fileName, folderId, libraryType),
    hydrateTeamAnalysis: (documentId, folderId) => ipcRenderer.invoke('knowledge-base:hydrate-team-analysis', documentId, folderId),
    hydratePersonalAnalysis: (documentId, folderId) => ipcRenderer.invoke('knowledge-base:hydrate-personal-analysis', documentId, folderId),
    getLocalStatus: (documentId) => ipcRenderer.invoke('knowledge-base:get-local-status', documentId),
    deleteLocalAnalysis: (documentId) => ipcRenderer.invoke('knowledge-base:delete-local-analysis', documentId),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('knowledge-base:event', listener);
      return () => ipcRenderer.removeListener('knowledge-base:event', listener);
    },
  },
  technicalPlan: {
    loadState: () => ipcRenderer.invoke('technical-plan:load-state'),
    importTenderDocument: () => ipcRenderer.invoke('technical-plan:import-tender-document'),
    importOriginalPlanDocument: () => ipcRenderer.invoke('technical-plan:import-original-plan-document'),
    checkBidSections: () => ipcRenderer.invoke('technical-plan:check-bid-sections'),
    selectBidSection: (selectedSection) => ipcRenderer.invoke('technical-plan:select-bid-section', selectedSection),
    readTenderMarkdown: () => ipcRenderer.invoke('technical-plan:read-tender-markdown'),
    readTenderSourceMarkdown: (sourceId) => ipcRenderer.invoke('technical-plan:read-tender-source-markdown', sourceId),
    readOriginalPlanMarkdown: () => ipcRenderer.invoke('technical-plan:read-original-plan-markdown'),
    updateStep: (step) => ipcRenderer.invoke('technical-plan:update-step', step),
    setWorkflowKind: (workflowKind) => ipcRenderer.invoke('technical-plan:set-workflow-kind', workflowKind),
    switchWorkflowKind: (workflowKind) => ipcRenderer.invoke('technical-plan:switch-workflow-kind', workflowKind),
    saveBidAnalysisConfig: (payload) => ipcRenderer.invoke('technical-plan:save-bid-analysis-config', payload),
    saveOutlineConfig: (payload) => ipcRenderer.invoke('technical-plan:save-outline-config', payload),
    saveOutline: (outlineData) => ipcRenderer.invoke('technical-plan:save-outline', outlineData),
    saveGlobalFacts: (globalFacts) => ipcRenderer.invoke('technical-plan:save-global-facts', globalFacts),
    saveContentGenerationOptions: (options) => ipcRenderer.invoke('technical-plan:save-content-generation-options', options),
    saveChapterContent: (payload) => ipcRenderer.invoke('technical-plan:save-chapter-content', payload),
    clear: () => ipcRenderer.invoke('technical-plan:clear'),
  },
  duplicateCheck: {
    loadState: () => ipcRenderer.invoke('duplicate-check:load-state'),
    saveFiles: (payload) => ipcRenderer.invoke('duplicate-check:save-files', payload),
    saveUiState: (payload) => ipcRenderer.invoke('duplicate-check:save-ui-state', payload),
    updateState: (partial) => ipcRenderer.invoke('duplicate-check:update-state', partial),
    clear: () => ipcRenderer.invoke('duplicate-check:clear'),
  },
  rejectionCheck: {
    loadState: () => ipcRenderer.invoke('rejection-check:load-state'),
    importDocument: (role) => ipcRenderer.invoke('rejection-check:import-document', role),
    importTenderFromTechnicalPlan: () => ipcRenderer.invoke('rejection-check:import-tender-from-technical-plan'),
    removeDocument: (role, documentId) => ipcRenderer.invoke('rejection-check:remove-document', role, documentId),
    saveUiState: (payload) => ipcRenderer.invoke('rejection-check:save-ui-state', payload),
    updateState: (partial) => ipcRenderer.invoke('rejection-check:update-state', partial),
    clear: () => ipcRenderer.invoke('rejection-check:clear'),
  },
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    get: (templateId) => ipcRenderer.invoke('templates:get', templateId),
    create: (config) => ipcRenderer.invoke('templates:create', config),
    update: (templateId, config) => ipcRenderer.invoke('templates:update', templateId, config),
    delete: (templateId) => ipcRenderer.invoke('templates:delete', templateId),
  },
  tasks: {
    startBidSectionExtraction: (payload) => ipcRenderer.invoke('tasks:start-bid-section-extraction', payload),
    startBidAnalysis: (payload) => ipcRenderer.invoke('tasks:start-bid-analysis', payload),
    startOutlineGeneration: (payload) => ipcRenderer.invoke('tasks:start-outline-generation', payload),
    startOutlineGenerationStep: (payload) => ipcRenderer.invoke('tasks:start-outline-step', payload),
    startGlobalFactsGeneration: (payload) => ipcRenderer.invoke('tasks:start-global-facts-generation', payload),
    startContentGeneration: (payload) => ipcRenderer.invoke('tasks:start-content-generation', payload),
    pauseContentGeneration: () => ipcRenderer.invoke('tasks:pause-content-generation'),
    startRejectionItemsExtraction: (payload) => ipcRenderer.invoke('tasks:start-rejection-items-extraction', payload),
    startRejectionCheck: (payload) => ipcRenderer.invoke('tasks:start-rejection-check', payload),
    startDuplicateAnalysis: (payload) => ipcRenderer.invoke('tasks:start-duplicate-analysis', payload),
    getActiveTasks: () => ipcRenderer.invoke('tasks:get-active'),
    onTaskEvent: (callback) => {
      ipcRenderer.send('tasks:subscribe');
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('tasks:event', listener);
      return () => ipcRenderer.removeListener('tasks:event', listener);
    },
  },
  export: {
    exportWord: (payload) => ipcRenderer.invoke('export:word', payload),
    openFile: (filePath) => ipcRenderer.invoke('export:open-file', filePath),
    onWordExportProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('export:word-progress', listener);
      return () => ipcRenderer.removeListener('export:word-progress', listener);
    },
  },
  systemFonts: {
    list: () => ipcRenderer.invoke('system-fonts:list'),
  },
  kbAuth: {
    login: (payload) => ipcRenderer.invoke('kb-auth:login', payload),
    logout: () => ipcRenderer.invoke('kb-auth:logout'),
    getStatus: () => ipcRenderer.invoke('kb-auth:get-status'),
    me: () => ipcRenderer.invoke('kb-auth:me'),
    setServer: (serverUrl) => ipcRenderer.invoke('kb-auth:set-server', serverUrl),
    register: (payload) => ipcRenderer.invoke('kb-auth:register', payload),
    onSessionExpired: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('kb-auth:session-expired', listener);
      return () => ipcRenderer.removeListener('kb-auth:session-expired', listener);
    },
    listEmployees: () => ipcRenderer.invoke('kb-auth:list-employees'),
    listPending: () => ipcRenderer.invoke('kb-auth:list-pending'),
    review: (payload) => ipcRenderer.invoke('kb-auth:review', payload),
    resetPassword: (payload) => ipcRenderer.invoke('kb-auth:reset-password', payload),
    verifyAdminPassword: (payload) => ipcRenderer.invoke('kb-auth:verify-admin-password', payload),
    setStatus: (payload) => ipcRenderer.invoke('kb-auth:set-status', payload),
    deleteEmployee: (payload) => ipcRenderer.invoke('kb-auth:delete-employee', payload),
    updateEmployee: (payload) => ipcRenderer.invoke('kb-auth:update-employee', payload),
    listPermissions: () => ipcRenderer.invoke('kb-auth:list-permissions'),
    listGroups: () => ipcRenderer.invoke('kb-auth:list-groups'),
    createGroup: (payload) => ipcRenderer.invoke('kb-auth:create-group', payload),
    deleteGroup: (payload) => ipcRenderer.invoke('kb-auth:delete-group', payload),
    setGroupPermissions: (payload) => ipcRenderer.invoke('kb-auth:set-group-permissions', payload),
    addGroupMember: (payload) => ipcRenderer.invoke('kb-auth:add-group-member', payload),
    removeGroupMember: (payload) => ipcRenderer.invoke('kb-auth:remove-group-member', payload),
    adminCreateEmployee: (payload) => ipcRenderer.invoke('kb-auth:admin-create-employee', payload),
    listAudit: (payload) => ipcRenderer.invoke('kb-auth:list-audit', payload),
  },
  kbTeam: {
    getTree: () => ipcRenderer.invoke('kb-team:get-tree'),
    createFolder: (name, parentId) => ipcRenderer.invoke('kb-team:create-folder', name, parentId),
    deleteFolder: (folderId) => ipcRenderer.invoke('kb-team:delete-folder', folderId),
    deleteDocument: (documentId) => ipcRenderer.invoke('kb-team:delete-document', documentId),
    uploadDocument: (folderId) => ipcRenderer.invoke('kb-team:upload-document', folderId),
    downloadDocument: (documentId, originalName) => ipcRenderer.invoke('kb-team:download-document', documentId, originalName),
    renameFolder: (folderId, name) => ipcRenderer.invoke('kb-team:rename-folder', folderId, name),
    moveFolder: (folderId, parentId) => ipcRenderer.invoke('kb-team:move-folder', folderId, parentId),
    renameDocument: (documentId, name) => ipcRenderer.invoke('kb-team:rename-document', documentId, name),
    moveDocument: (documentId, folderId) => ipcRenderer.invoke('kb-team:move-document', documentId, folderId),
    search: (query, mode) => ipcRenderer.invoke('kb-team:search', query, mode),
    qaRetrieve: (query, limit) => ipcRenderer.invoke('kb-team:qa-retrieve', query, limit),
    listTrash: () => ipcRenderer.invoke('kb-team:list-trash'),
    restoreFromTrash: (type, id) => ipcRenderer.invoke('kb-team:restore-from-trash', type, id),
    exportZip: (ids) => ipcRenderer.invoke('kb-team:export-zip', ids),
    getAnalysisStatus: (documentId) => ipcRenderer.invoke('kb-team:get-analysis-status', documentId),
    retryAnalysis: (documentId) => ipcRenderer.invoke('kb-team:retry-analysis', documentId),
  },
  kbPersonal: {
    getTree: () => ipcRenderer.invoke('kb-personal:get-tree'),
    listFolders: () => ipcRenderer.invoke('kb-personal:list-folders'),
    listDocuments: (folderId) => ipcRenderer.invoke('kb-personal:list-documents', folderId),
    downloadDocument: (documentId, destPath) => ipcRenderer.invoke('kb-personal:download-document', documentId, destPath),
    searchDocuments: (keyword, mode) => ipcRenderer.invoke('kb-personal:search', keyword, mode),
    qaRetrieve: (keyword, limit) => ipcRenderer.invoke('kb-personal:qa-retrieve', keyword, limit),
    createFolder: (name, parentId) => ipcRenderer.invoke('kb-personal:create-folder', name, parentId),
    uploadDocument: (folderId) => ipcRenderer.invoke('kb-personal:upload-document', folderId),
    deleteFolder: (folderId) => ipcRenderer.invoke('kb-personal:delete-folder', folderId),
    deleteDocument: (documentId) => ipcRenderer.invoke('kb-personal:delete-document', documentId),
    moveFolder: (folderId, parentId) => ipcRenderer.invoke('kb-personal:move-folder', folderId, parentId),
    renameFolder: (folderId, name) => ipcRenderer.invoke('kb-personal:rename-folder', folderId, name),
    renameDocument: (documentId, name) => ipcRenderer.invoke('kb-personal:rename-document', documentId, name),
    moveDocument: (documentId, folderId) => ipcRenderer.invoke('kb-personal:move-document', documentId, folderId),
    listTrash: () => ipcRenderer.invoke('kb-personal:list-trash'),
    restoreFromTrash: (type, id) => ipcRenderer.invoke('kb-personal:restore-from-trash', type, id),
    exportZip: (ids) => ipcRenderer.invoke('kb-personal:export-zip', ids),
    importToTeam: (documentIds, targetTeamFolderId, folderIds) => ipcRenderer.invoke('kb-personal:import-to-team', documentIds, targetTeamFolderId, folderIds),
    importFromTeam: (documentIds, folderIds) => ipcRenderer.invoke('kb-personal:import-from-team', documentIds, folderIds),
    getAnalysisStatus: (documentId) => ipcRenderer.invoke('kb-personal:get-analysis-status', documentId),
    retryAnalysis: (documentId) => ipcRenderer.invoke('kb-personal:retry-analysis', documentId),
  },
  kbQa: {
    retrieveContext: (question, options) => ipcRenderer.invoke('kb-qa:retrieve-context', question, options),
    clearIndex: (source) => ipcRenderer.invoke('kb-qa:clear-index', source),
  },
  kbQaSession: {
    list: (limit) => ipcRenderer.invoke('kb-qa-session:list', limit),
    create: (options) => ipcRenderer.invoke('kb-qa-session:create', options),
    rename: (sessionId, title) => ipcRenderer.invoke('kb-qa-session:rename', sessionId, title),
    setStatus: (sessionId, status) => ipcRenderer.invoke('kb-qa-session:set-status', sessionId, status),
    remove: (sessionId) => ipcRenderer.invoke('kb-qa-session:delete', sessionId),
    clear: () => ipcRenderer.invoke('kb-qa-session:clear'),
    listMessages: (sessionId, afterId) => ipcRenderer.invoke('kb-qa-session:list-messages', sessionId, afterId),
    addMessage: (sessionId, payload) => ipcRenderer.invoke('kb-qa-session:add-message', sessionId, payload),
    updateMessage: (messageId, payload) => ipcRenderer.invoke('kb-qa-session:update-message', messageId, payload),
  },
  plugins: {
    getAvailablePlugins: () => ipcRenderer.invoke('plugins:getAvailablePlugins'),
    install: (pluginId) => ipcRenderer.invoke('plugins:install', pluginId),
    installOffline: () => ipcRenderer.invoke('plugins:installOffline'),
    uninstall: (pluginId) => ipcRenderer.invoke('plugins:uninstall', pluginId),
    enable: (pluginId) => ipcRenderer.invoke('plugins:enable', pluginId),
    disable: (pluginId) => ipcRenderer.invoke('plugins:disable', pluginId),
    update: (pluginId) => ipcRenderer.invoke('plugins:update', pluginId),
    openConfig: (pluginId) => ipcRenderer.invoke('plugins:openConfig', pluginId),
    refreshMarket: () => ipcRenderer.invoke('plugins:refreshMarket'),
    clearUpdateFailedState: (pluginId) => ipcRenderer.invoke('plugins:clearUpdateFailedState', pluginId),
  },
};

contextBridge.exposeInMainWorld('yibiao', bridge);

contextBridge.exposeInMainWorld('yibiaoClient', {
  appName: bridge.appName,
  platform: bridge.platform,
});
