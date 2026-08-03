const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, shell } = require('electron');

function registerConfigIpc({ configStore, aiService, kbAuthService, onDeveloperModeChange, onConfigChanged }) {
  ipcMain.handle('config:load', () => configStore.load());
  ipcMain.handle('config:save', (_event, config) => {
    const previousConfig = configStore.load();
    const result = configStore.save(config);
    const nextConfig = configStore.load();
    onDeveloperModeChange?.(Boolean(nextConfig?.developer_mode));
    onConfigChanged?.(nextConfig, previousConfig);
    return result;
  });
  ipcMain.handle('config:list-models', (_event, config) => aiService.listModels(config));
  ipcMain.handle('config:get-model-info', (_event, modelName) => aiService.getModelInfo(modelName));
  ipcMain.handle('config:open-config-folder', async () => {
    const configFolder = path.dirname(configStore.getConfigFilePath());
    fs.mkdirSync(configFolder, { recursive: true });
    const errorMessage = await shell.openPath(configFolder);

    if (errorMessage) {
      throw new Error(`打开配置文件夹失败：${errorMessage}`);
    }

    return { success: true, path: configFolder };
  });

  // ---------- 全局模型配置（服务端托管，管理员设置，全员生效）----------
  // 读取服务端模型配置（api_key 不返回）
  ipcMain.handle('config:load-global', async () => {
    if (!kbAuthService) return { success: false, error: 'kbAuthService 未初始化' };
    const { ok, status, data } = await kbAuthService.apiFetch('/api/admin/model-config', { method: 'GET' });
    if (!ok) return { success: false, status, error: data?.error || '读取模型配置失败' };
    return data;
  });
  // 保存服务端模型配置；api_key 传 '__UNCHANGED__' 表示保留原值
  ipcMain.handle('config:save-global', async (_event, cfg) => {
    if (!kbAuthService) return { success: false, error: 'kbAuthService 未初始化' };
    const { ok, status, data } = await kbAuthService.apiFetch('/api/admin/model-config', {
      method: 'POST',
      body: {
        base_url: cfg.base_url,
        api_key: cfg.api_key,
        analysis_model: cfg.analysis_model,
        qa_model: cfg.qa_model,
        embedding_model: cfg.embedding_model,
        file_parser_provider: cfg.file_parser_provider || 'local',
        pdf_image_parser_provider: cfg.pdf_image_parser_provider || 'local',
        mineru_token: cfg.mineru_token === undefined ? '__UNCHANGED__' : cfg.mineru_token,
      },
    });
    if (!ok) return { success: false, status, error: data?.error || '保存模型配置失败' };
    return data;
  });
  // 测试 MinerU Token 是否可用（accurate-api 需要）
  ipcMain.handle('config:test-mineru-token', async (_event, { mineru_token }) => {
    if (!kbAuthService) return { success: false, error: 'kbAuthService 未初始化' };
    const { ok, status, data } = await kbAuthService.apiFetch('/api/admin/test-mineru-token', {
      method: 'POST',
      body: { mineru_token: mineru_token || '' },
    });
    if (!ok) return { success: false, status, error: data?.error || '测试 MinerU Token 失败' };
    return data;
  });
  // 拉取服务端代理的 sub2api 模型列表
  ipcMain.handle('config:list-models-global', async () => {
    if (!kbAuthService) return { success: false, models: [] };
    const { ok, data } = await kbAuthService.apiFetch('/api/models', { method: 'GET' });
    if (!ok) return { success: false, models: [], error: data?.error };
    return { success: true, models: Array.isArray(data?.models) ? data.models : [] };
  });
}

module.exports = {
  registerConfigIpc,
};
