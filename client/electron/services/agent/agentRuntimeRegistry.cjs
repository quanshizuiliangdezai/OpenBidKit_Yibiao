// 精简版智能体运行时注册表（仅保留 Pi Agent）。
// OpenCode 运行时已移除；上游重构后 agentService 默认走 Pi SDK，此处仅用于
// 向设置页提供运行时列表元数据，并对外提供统一的默认/归一化接口。

const runtimeDefinitions = [
  {
    id: 'pi',
    displayName: 'Pi Agent',
    description: '使用内嵌 Pi SDK 智能体链路。',
    isDefault: true,
    createRuntime(options) {
      const { createPiRuntimeService } = require('../pi/piRuntimeService.cjs');
      return createPiRuntimeService(options);
    },
  },
];

const runtimeById = new Map(runtimeDefinitions.map((item) => [item.id, item]));
const defaultRuntime = runtimeDefinitions.find((item) => item.isDefault);

if (!defaultRuntime) {
  throw new Error('智能体运行时注册表缺少默认项');
}

// 返回可安全发送给 Renderer 的运行时元数据。
function listAgentRuntimeDescriptors() {
  return runtimeDefinitions.map(({ id, displayName, description, isDefault }) => ({
    id,
    display_name: displayName,
    description,
    is_default: isDefault,
  }));
}

function getDefaultAgentRuntimeId() {
  return defaultRuntime.id;
}

// 统一默认值；未知配置（含历史遗留的 opencode）一律回退到 Pi，绝不抛错。
function normalizeAgentRuntimeId(value) {
  const runtimeId = String(value || '').trim();
  if (runtimeId && runtimeById.has(runtimeId)) {
    return runtimeId;
  }
  return getDefaultAgentRuntimeId();
}

function getAgentRuntimeDefinition(runtimeId) {
  const normalizedId = normalizeAgentRuntimeId(runtimeId);
  return runtimeById.get(normalizedId);
}

function createAgentRuntime(runtimeId, options) {
  const definition = getAgentRuntimeDefinition(runtimeId);
  return definition.createRuntime({
    ...options,
    runtime: {
      id: definition.id,
      displayName: definition.displayName,
      description: definition.description,
    },
  });
}

module.exports = {
  createAgentRuntime,
  getAgentRuntimeDefinition,
  getDefaultAgentRuntimeId,
  listAgentRuntimeDescriptors,
  normalizeAgentRuntimeId,
};
