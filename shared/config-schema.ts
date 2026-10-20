// shared/config-schema.ts

/**
 * 配置字段 scope 声明 — 单一事实来源。
 *
 * - global: 存 preferences.json，跨 agent 共享
 * - agent（默认）: 存 agent config.yaml，per-agent 独立
 *
 * 未在此处声明的字段默认为 agent scope。
 * 嵌套路径最多支持 2 级（如 'capabilities.learn_skills'）。
 *
 * @typedef {'global' | 'agent'} ConfigScope
 * @typedef {object} FieldDef
 * @property {ConfigScope} scope
 * @property {string} [setter] - engine 上的 setter 方法名（仅 global scope）
 * @property {string} [getter] - engine 上的 getter 方法名（仅 global scope）
 * @property {string} [prefsPath] - preferences.json 中的真实存储路径（默认同 schema key）
 * @property {unknown} [defaultValue] - global 字段的默认值（用于 migrate-config-scope）
 */

/** @type {Record<string, FieldDef>} */
export const CONFIG_SCHEMA = {
  locale:                       { scope: 'global', setter: 'setLocale',         getter: 'getLocale', defaultValue: '' },
  // 用户名描述的是使用者本人，跨 agent 必须一致，所以唯一正源是全局
  // preferences：这条 global scope 把带 user.name 的写请求全部引到全局设置上，
  // 落不进任何一个 agent 的 config。读取侧同样只认全局值。
  'user.name':                  { scope: 'global', setter: 'setUserName',       getter: 'getUserName', prefsPath: 'userName', defaultValue: '' },
  timezone:                     { scope: 'global', setter: 'setTimezone',       getter: 'getTimezone', defaultValue: '' },
  sandbox:                      { scope: 'global', setter: 'setSandbox',        getter: 'getSandbox', defaultValue: true },
  sandbox_network:              { scope: 'global', setter: 'setSandboxNetwork', getter: 'getSandboxNetwork', defaultValue: true },
  hardware_acceleration:        { scope: 'global', setter: 'setHardwareAcceleration', getter: 'getHardwareAcceleration', defaultValue: true },
  file_backup:                  { scope: 'global', setter: 'setFileBackup',    getter: 'getFileBackup' },
  update_channel:               { scope: 'global', setter: 'setUpdateChannel',  getter: 'getUpdateChannel', defaultValue: 'stable' },
  auto_check_updates:           { scope: 'global', setter: 'setAutoCheckUpdates', getter: 'getAutoCheckUpdates', defaultValue: true },
  keep_awake:                   { scope: 'global', setter: 'setKeepAwake', getter: 'getKeepAwake', defaultValue: false },
  thinking_level:               { scope: 'global', setter: 'setThinkingLevel',  getter: 'getThinkingLevel', defaultValue: 'medium' },
  editor:                       { scope: 'global', setter: 'setEditor',         getter: 'getEditor' },
  'capabilities.learn_skills':  { scope: 'global', setter: 'setLearnSkills',    getter: 'getLearnSkills', prefsPath: 'learn_skills' },
  'desk.heartbeat_master':      { scope: 'global', setter: 'setHeartbeatMaster', getter: 'getHeartbeatMaster', prefsPath: 'heartbeat_master', defaultValue: true },
  'channels.enabled':           { scope: 'global', setter: 'setChannelsEnabled', getter: 'getChannelsEnabled', prefsPath: 'channels_enabled', defaultValue: false },
  'bridge.permissionMode':      { scope: 'global', setter: 'setBridgePermissionMode', getter: 'getBridgePermissionMode', defaultValue: 'auto' },
  'bridge.readOnly':            { scope: 'global', setter: 'setBridgeReadOnly', getter: 'getBridgeReadOnly', defaultValue: false },
  'bridge.receiptEnabled':      { scope: 'global', setter: 'setBridgeReceiptEnabled', getter: 'getBridgeReceiptEnabled', defaultValue: true },
  'bridge.richStreamingEnabled': { scope: 'global', setter: 'setBridgeRichStreamingEnabled', getter: 'getBridgeRichStreamingEnabled', defaultValue: true },
  'automation.permissionMode':  { scope: 'global', setter: 'setAutomationPermissionMode', getter: 'getAutomationPermissionMode', defaultValue: 'auto' },
  network_proxy:                { scope: 'global', setter: 'setNetworkProxy', getter: 'getNetworkProxy' },
};

// 未声明的字段默认为 agent scope，不需要额外导出。
// 迁移逻辑直接遍历 CONFIG_SCHEMA。
