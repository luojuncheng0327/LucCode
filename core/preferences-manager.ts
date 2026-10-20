/**
 * PreferencesManager — 全局 preferences.json 读写
 *
 * 统一管理用户级全局配置（bridge、agent 排序等），
 * 以及 primaryAgent 偏好。从 Engine 提取，避免 route 穿透私有字段。
 */
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import {
  approveComputerUseApp,
  normalizeComputerUseSettings,
  revokeComputerUseApp,
} from "./computer-use/settings.ts";
import {
  normalizeAutomationPermissionMode,
  normalizeBridgePermissionMode,
  normalizeSessionPermissionMode,
  SESSION_PERMISSION_MODES,
} from "./session-permission-mode.ts";
import {
  mergeEditorTypography,
  normalizeEditorTypography,
} from "../shared/editor-typography.ts";
import {
  getWorkspaceUiStateEntry,
  upsertWorkspaceUiState,
} from "../shared/workspace-ui-state.ts";
import { pruneMissingWorkspaceUiState } from "../shared/workspace-persistence-gc.ts";
import {
  mergeSidebarUiPrefs,
  normalizeSidebarUiPrefs,
} from "../shared/sidebar-ui-state.ts";
import { normalizeWorkspacePath } from "../shared/workspace-history.ts";
import { normalizeNetworkProxyConfig } from "../shared/network-proxy.ts";
import {
  mergeNotificationPreferences,
  normalizeNotificationPreferences,
} from "../shared/notification-preferences.ts";
import {
  mergeQuickChatPreferences,
  normalizeQuickChatPreferences,
} from "../shared/quick-chat-preferences.ts";
import {
  mergeBrowserPreferences,
  normalizeBrowserPreferences,
} from "../shared/browser-preferences.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { isValidAgentId } from "../shared/agent-id.ts";
import { normalizeSessionThinkingLevel } from "./session-thinking-level.ts";

const log = createModuleLogger("preferences");
const RETIRED_EXPERIMENT_IDS = new Set([
  "memory.cache_snapshot_reflection",
]);

function stripRetiredExperimentValues(prefs) {
  const experiments = prefs?.experiments;
  if (!experiments || typeof experiments !== "object" || Array.isArray(experiments)) {
    return prefs;
  }

  let nextExperiments = experiments;
  for (const id of RETIRED_EXPERIMENT_IDS) {
    if (!Object.prototype.hasOwnProperty.call(nextExperiments, id)) continue;
    if (nextExperiments === experiments) nextExperiments = { ...experiments };
    delete nextExperiments[id];
  }
  if (nextExperiments === experiments) return prefs;

  const next = { ...prefs };
  if (Object.keys(nextExperiments).length === 0) delete next.experiments;
  else next.experiments = nextExperiments;
  return next;
}

export class PreferencesManager {
  declare _agentsDir: any;
  declare _cache: any;
  declare _path: any;
  declare _sourceReadFailure: any;
  declare _userDir: any;
  /**
   * @param {object} opts
   * @param {string} opts.userDir  - 用户数据目录（preferences.json 所在）
   * @param {string} opts.agentsDir - agents 根目录（findFirstAgent 用）
   */
  constructor({ userDir, agentsDir }) {
    this._userDir = userDir;
    this._agentsDir = agentsDir;
    this._path = path.join(userDir, "preferences.json");
    this._sourceReadFailure = null;
    this._cache = this._readFromDisk();
    if (this._sourceReadFailure) {
      log.warn(`automatic preference maintenance skipped because the source is unreadable: ${this._path}`);
    } else {
      this._runConstructorMaintenance("retired experiments", () => this._migrateRetiredExperiments());
      this._runConstructorMaintenance("legacy defaults", () => this._migrateLegacyDefaults());
      this._runConstructorMaintenance("workspace state gc", () => this.gcWorkspaceUiState());
    }
  }

  _runConstructorMaintenance(label, operation) {
    try {
      operation();
    } catch (err) {
      log.warn(`automatic preference maintenance failed (${label}); startup will continue: ${err.message}`);
    }
  }

  _migrateRetiredExperiments() {
    const next = stripRetiredExperimentValues(this._cache);
    if (next === this._cache) return;
    this.savePreferences(next);
  }

  /**
   * 一次性迁移：把历史版本"无脑写入"的旧默认值回退到"未表达偏好"。
   *
   * 早前把 sandbox_network 的 default 从关改成开（!== false），
   * 但老用户 preferences.json 里仍有 `sandbox_network: false` —— 这是早期
   * 默认时无脑写入的，不是用户的显式选择。本 migration 把它清掉一次，
   * 让 getter 走新默认（开）。带 marker 防止重跑：用户之后显式关掉时
   * 不会再被覆盖。
   *
   * @private
   */
  _migrateLegacyDefaults() {
    if (this._cache._defaultsRelaxedMigrated) return;
    const next = { ...this._cache };
    if (next.sandbox_network === false) delete next.sandbox_network;
    next._defaultsRelaxedMigrated = true;
    this.savePreferences(next);
  }

  /** 读取全局 preferences（从内存缓存） */
  getPreferences() {
    return structuredClone(this._cache);
  }

  /** 写入全局 preferences（更新缓存 + 原子写磁盘） */
  savePreferences(prefs) {
    const next = this._preserveDiskSetupComplete(stripRetiredExperimentValues(structuredClone(prefs)));
    fs.mkdirSync(this._userDir, { recursive: true });
    try {
      this._preserveUnreadableSourceBeforeWrite();
      atomicWriteSync(this._path, JSON.stringify(next, null, 2) + "\n");
      this._cache = this._readFromDiskStrict();
    } catch (err) {
      try { fs.unlinkSync(this._path + ".tmp"); } catch {}
      throw err;
    }
  }

  /** @private 从磁盘读取（仅构造时调用一次） */
  _readFromDisk() {
    try {
      return this._readFromDiskStrict();
    } catch (err) {
      if (err.code === "ENOENT") return {};
      this._sourceReadFailure = err;
      log.warn(`failed to read ${this._path}: ${err.message}`);
      return {};
    }
  }

  /**
   * An unreadable preferences file is still user data. Before a later,
   * explicit write replaces it with a usable document, preserve the exact
   * original bytes beside it. Constructor maintenance never reaches this
   * path because it is skipped while the source is unreadable.
   */
  _preserveUnreadableSourceBeforeWrite() {
    if (!this._sourceReadFailure) return;
    try {
      if (!fs.existsSync(this._path)) {
        this._sourceReadFailure = null;
        return;
      }
      let timestamp = Date.now();
      let backupPath = `${this._path}.corrupt-${timestamp}`;
      while (fs.existsSync(backupPath)) {
        backupPath = `${this._path}.corrupt-${++timestamp}`;
      }
      fs.copyFileSync(this._path, backupPath, fs.constants.COPYFILE_EXCL);
      this._sourceReadFailure = null;
      log.warn(`preserved unreadable preferences before replacement: ${backupPath}`);
    } catch (err) {
      throw new Error(`cannot preserve unreadable preferences before write: ${err.message}`, { cause: err });
    }
  }

  /** @private 从磁盘读取，失败时抛给写入方，避免写后校验被吞掉 */
  _readFromDiskStrict() {
    return JSON.parse(fs.readFileSync(this._path, "utf-8"));
  }

  /**
   * @private setupComplete 是单向完成标记。即使有旧 server cache，
   * 后续偏好写入也不能把磁盘上已完成的事实覆盖掉。
   */
  _preserveDiskSetupComplete(prefs) {
    if (prefs.setupComplete === true) return prefs;
    try {
      const stored = this._readFromDiskStrict();
      if (stored?.setupComplete === true) {
        return { ...prefs, setupComplete: true };
      }
    } catch {}
    return prefs;
  }

  // ── 内部 getter 直接读 _cache，避免 structuredClone 开销 ──
  // 写操作使用 _mutableCopy() 获取浅拷贝，修改后 savePreferences

  /** @private 获取可修改的浅拷贝（setter 专用） */
  _mutableCopy() {
    return { ...this._cache };
  }

  /** 读取沙盒模式偏好 */
  getSandbox() {
    return this._cache.sandbox !== false;
  }

  /** 保存沙盒模式偏好 */
  setSandbox(enabled) {
    const prefs = this._mutableCopy();
    prefs.sandbox = typeof enabled === "string" ? enabled === "true" : !!enabled;
    this.savePreferences(prefs);
  }

  /** 读取沙盒内命令是否允许出站联网。默认开启，避免沙盒破坏常规工具链。 */
  getSandboxNetwork() {
    return this._cache.sandbox_network !== false;
  }

  /** 保存沙盒内命令出站联网偏好。 */
  setSandboxNetwork(enabled) {
    const prefs = this._mutableCopy();
    prefs.sandbox_network = typeof enabled === "string" ? enabled === "true" : !!enabled;
    this.savePreferences(prefs);
  }

  /** 读取桌面硬件加速偏好。默认开启。 */
  getHardwareAcceleration() {
    return this._cache.hardware_acceleration !== false;
  }

  /** 保存桌面硬件加速偏好；主进程下次启动时生效。 */
  setHardwareAcceleration(enabled) {
    const prefs = this._mutableCopy();
    if (typeof enabled === "string") {
      const value = enabled.trim().toLowerCase();
      prefs.hardware_acceleration = !["false", "0", "off", "no", "disabled"].includes(value);
    } else {
      prefs.hardware_acceleration = !!enabled;
    }
    this.savePreferences(prefs);
  }

  /**
   * 只消费旧版 GPU 自动安全模式写下的 `false`。
   *
   * 该操作由 server 在数据版本闸门通过后调用。比较当前缓存值再删除，
   * 避免桌面启动阶段持有的旧快照覆盖用户随后作出的新选择。
   */
  compareAndDeleteLegacyHardwareAccelerationPreference() {
    if (!Object.prototype.hasOwnProperty.call(this._cache, "hardware_acceleration")) {
      return { status: "already-absent" };
    }
    if (this._cache.hardware_acceleration !== false) {
      return { status: "value-changed" };
    }

    const prefs = this._mutableCopy();
    delete prefs.hardware_acceleration;
    this.savePreferences(prefs);
    return { status: "deleted" };
  }

  /** 读取新会话默认权限模式。首次安装没有该字段时默认 auto。 */
  getSessionPermissionModeDefault() {
    return normalizeSessionPermissionMode({ permissionMode: this._cache.session_permission_mode_default });
  }

  /** 保存新会话默认权限模式，用于记住用户上次选择。 */
  setSessionPermissionModeDefault(mode) {
    const prefs = this._mutableCopy();
    prefs.session_permission_mode_default = normalizeSessionPermissionMode(mode);
    this.savePreferences(prefs);
    return prefs.session_permission_mode_default;
  }

  /** 读取文件备份配置 */
  getFileBackup() {
    const cfg = this._cache.file_backup;
    if (!cfg) return { enabled: false, retention_days: 1, max_file_size_kb: 1024 };
    return {
      enabled: !!cfg.enabled,
      retention_days: cfg.retention_days || 1,
      max_file_size_kb: cfg.max_file_size_kb || 1024,
    };
  }

  /** 合并写入文件备份配置 */
  setFileBackup(partial) {
    const prefs = this._mutableCopy();
    prefs.file_backup = { ...(prefs.file_backup || {}), ...partial };
    this.savePreferences(prefs);
  }

  /** 读取频道系统总开关（全局，默认关闭） */
  getChannelsEnabled() {
    return this._cache.channels_enabled === true;
  }

  /** 保存频道系统总开关 */
  setChannelsEnabled(enabled) {
    const prefs = this._mutableCopy();
    prefs.channels_enabled = !!enabled;
    this.savePreferences(prefs);
  }

  /** 读取 bridge 权限模式（全局，默认自动审核） */
  getBridgePermissionMode() {
    return normalizeBridgePermissionMode(this._cache.bridge || {});
  }

  /** 保存 bridge 权限模式；保留 readOnly 旧字段供旧路径兼容 */
  setBridgePermissionMode(mode) {
    const normalized = normalizeBridgePermissionMode({ permissionMode: mode });
    const prefs = this._mutableCopy();
    const bridge = { ...(prefs.bridge || {}) };
    bridge.permissionMode = normalized;
    if (normalized === SESSION_PERMISSION_MODES.READ_ONLY) bridge.readOnly = true;
    else delete bridge.readOnly;
    prefs.bridge = bridge;
    this.savePreferences(prefs);
    return normalized;
  }

  /** 读取 bridge 只读总开关（全局，默认关闭） */
  getBridgeReadOnly() {
    return this.getBridgePermissionMode() === SESSION_PERMISSION_MODES.READ_ONLY;
  }

  /** 保存 bridge 只读总开关 */
  setBridgeReadOnly(enabled) {
    const prefs = this._mutableCopy();
    const bridge = { ...(prefs.bridge || {}) };
    if (enabled) {
      bridge.readOnly = true;
      if (bridge.permissionMode) bridge.permissionMode = SESSION_PERMISSION_MODES.READ_ONLY;
    } else {
      delete bridge.readOnly;
      if (bridge.permissionMode === SESSION_PERMISSION_MODES.READ_ONLY) {
        bridge.permissionMode = SESSION_PERMISSION_MODES.AUTO;
      }
    }
    if (Object.keys(bridge).length === 0) delete prefs.bridge;
    else prefs.bridge = bridge;
    this.savePreferences(prefs);
  }

  /** 读取 bridge 回复前提示总开关（全局，默认开启） */
  getBridgeReceiptEnabled() {
    return this._cache.bridge?.receiptEnabled !== false;
  }

  /** 保存 bridge 回复前提示总开关 */
  setBridgeReceiptEnabled(enabled) {
    const prefs = this._mutableCopy();
    const bridge = { ...(prefs.bridge || {}) };
    if (enabled === false) bridge.receiptEnabled = false;
    else delete bridge.receiptEnabled;
    if (Object.keys(bridge).length === 0) delete prefs.bridge;
    else prefs.bridge = bridge;
    this.savePreferences(prefs);
  }

  /** 读取 bridge 富文本流式开关（全局，默认开启） */
  getBridgeRichStreamingEnabled() {
    return this._cache.bridge?.richStreamingEnabled !== false;
  }

  /** 保存 bridge 富文本流式开关；false 表示强制走旧兼容路径 */
  setBridgeRichStreamingEnabled(enabled) {
    const prefs = this._mutableCopy();
    const bridge = { ...(prefs.bridge || {}) };
    if (enabled === false) bridge.richStreamingEnabled = false;
    else delete bridge.richStreamingEnabled;
    if (Object.keys(bridge).length === 0) delete prefs.bridge;
    else prefs.bridge = bridge;
    this.savePreferences(prefs);
  }

  /** 读取自动化运行权限模式（全局，默认自动审核）。 */
  getAutomationPermissionMode() {
    return normalizeAutomationPermissionMode(this._cache.automation || {});
  }

  /** 保存自动化运行权限模式。 */
  setAutomationPermissionMode(mode) {
    const normalized = normalizeAutomationPermissionMode({ permissionMode: mode });
    const prefs = this._mutableCopy();
    const automation = { ...(prefs.automation || {}) };
    automation.permissionMode = normalized;
    prefs.automation = automation;
    this.savePreferences(prefs);
    return normalized;
  }

  /** 读取全局出站代理设置。 */
  getNetworkProxy() {
    return normalizeNetworkProxyConfig(this._cache.network_proxy);
  }

  /** 保存全局出站代理设置。 */
  setNetworkProxy(partial) {
    const prefs = this._mutableCopy();
    prefs.network_proxy = normalizeNetworkProxyConfig(partial, { strict: true });
    this.savePreferences(prefs);
    return prefs.network_proxy;
  }

  /** 读取 Bridge 媒体临时公网 base URL。空值表示回退到启动环境变量。 */
  getBridgeMediaPublicBaseUrl() {
    return normalizeBridgeMediaPublicBaseUrl(this._cache.bridge?.mediaPublicBaseUrl || "");
  }

  /** 保存 Bridge 媒体临时公网 base URL。传空字符串会清除持久配置。 */
  setBridgeMediaPublicBaseUrl(value) {
    const normalized = normalizeBridgeMediaPublicBaseUrl(value);
    const prefs = this._mutableCopy();
    const bridge = { ...(prefs.bridge || {}) };
    if (normalized) bridge.mediaPublicBaseUrl = normalized;
    else delete bridge.mediaPublicBaseUrl;
    if (Object.keys(bridge).length === 0) delete prefs.bridge;
    else prefs.bridge = bridge;
    this.savePreferences(prefs);
    return normalized;
  }

  /** 读取 Computer Use 全局设置（provider 选择、批准列表、平台策略） */
  getComputerUseSettings() {
    return normalizeComputerUseSettings(this._cache.computer_use || {});
  }

  /** 合并写入 Computer Use 全局设置 */
  setComputerUseSettings(partial) {
    const prefs = this._mutableCopy();
    prefs.computer_use = normalizeComputerUseSettings({
      ...(prefs.computer_use || {}),
      ...(partial || {}),
    });
    this.savePreferences(prefs);
    return prefs.computer_use;
  }

  /** 批准 Computer Use 控制某个 provider 下的 app/window scope */
  approveComputerUseApp(approval) {
    const prefs = this._mutableCopy();
    prefs.computer_use = approveComputerUseApp(prefs.computer_use || {}, approval);
    this.savePreferences(prefs);
    return prefs.computer_use;
  }

  /** 撤销 Computer Use app 批准 */
  revokeComputerUseApp(approval) {
    const prefs = this._mutableCopy();
    prefs.computer_use = revokeComputerUseApp(prefs.computer_use || {}, approval);
    this.savePreferences(prefs);
    return prefs.computer_use;
  }

  /** 读取技能安装配置（全局，跨 agent） */
  getLearnSkills() {
    const cfg = this._cache.learn_skills;
    if (!cfg) return { enabled: true, safety_review: true };
    return cfg;
  }

  /** 合并写入技能安装配置 */
  setLearnSkills(partial) {
    const prefs = this._mutableCopy();
    prefs.learn_skills = { ...(prefs.learn_skills || {}), ...partial };
    this.savePreferences(prefs);
  }

  /** 读取语言偏好（全局） */
  getLocale() {
    return this._cache.locale || "";
  }

  /** 读取首次配置完成标记。 */
  getSetupComplete() {
    return this._cache.setupComplete === true;
  }

  /** 标记首次配置完成：原子写入后读回校验。 */
  markSetupComplete() {
    const prefs = this._mutableCopy();
    prefs.setupComplete = true;
    this.savePreferences(prefs);
    if (!this.getSetupComplete()) {
      throw new Error("setupComplete read-back verification failed");
    }
    return { setupComplete: true };
  }

  /** 保存语言偏好 */
  setLocale(locale) {
    const prefs = this._mutableCopy();
    prefs.locale = locale || "";
    this.savePreferences(prefs);
  }

  /**
   * 读取用户名（全局）。名字描述的是使用者本人，不属于任何一个 agent，
   * 所以正源在这里，而不是各 agent 的 config.yaml。
   */
  getUserName() {
    return this._cache.userName || "";
  }

  /** 保存用户名（全局） */
  setUserName(name) {
    const prefs = this._mutableCopy();
    prefs.userName = typeof name === "string" ? name.trim() : "";
    this.savePreferences(prefs);
  }

  /** 读取编辑器排版偏好 */
  getEditor() {
    return normalizeEditorTypography(this._cache.editor);
  }

  /** 合并写入编辑器排版偏好 */
  setEditor(partial) {
    const prefs = this._mutableCopy();
    prefs.editor = mergeEditorTypography(prefs.editor, partial);
    this.savePreferences(prefs);
    return prefs.editor;
  }

  /** 读取跨前端同步的外观偏好。 */
  getAppearance() {
    return normalizeAppearance(this._cache.appearance || {});
  }

  /** 合并写入跨前端同步的外观偏好。 */
  setAppearance(partial) {
    const prefs = this._mutableCopy();
    prefs.appearance = normalizeAppearance({
      ...(prefs.appearance || {}),
      ...(partial || {}),
    });
    this.savePreferences(prefs);
    return prefs.appearance;
  }

  /** 读取跨前端同步的通知偏好。 */
  getNotificationPreferences() {
    return normalizeNotificationPreferences(this._cache.notifications || {});
  }

  /** 合并写入跨前端同步的通知偏好。 */
  setNotificationPreferences(partial) {
    const prefs = this._mutableCopy();
    prefs.notifications = mergeNotificationPreferences(prefs.notifications || {}, partial || {});
    this.savePreferences(prefs);
    return prefs.notifications;
  }

  /** 读取快速聊天入口偏好。 */
  getQuickChatPreferences() {
    return normalizeQuickChatPreferences(this._cache.quick_chat || {});
  }

  /** 合并写入快速聊天入口偏好。 */
  setQuickChatPreferences(partial) {
    const prefs = this._mutableCopy();
    prefs.quick_chat = mergeQuickChatPreferences(prefs.quick_chat || {}, partial || {});
    this.savePreferences(prefs);
    return prefs.quick_chat;
  }

  /** 读取内置浏览器偏好。 */
  getBrowserPreferences() {
    return normalizeBrowserPreferences(this._cache.browser || {});
  }

  /** 合并写入内置浏览器偏好。 */
  setBrowserPreferences(partial) {
    const prefs = this._mutableCopy();
    prefs.browser = mergeBrowserPreferences(prefs.browser || {}, partial || {});
    this.savePreferences(prefs);
    return prefs.browser;
  }

  /** 读取指定工作区的 UI 状态（文件夹展开、预览 tabs 等）。 */
  getWorkspaceUiState(workspaceRoot, surface) {
    const workspace = normalizeWorkspacePath(workspaceRoot);
    if (!workspace) return null;
    this.gcWorkspaceUiState();
    return getWorkspaceUiStateEntry(this._cache.workspace_ui_state || {}, workspace, { surface });
  }

  /** 写入指定工作区的 UI 状态，状态按 workspace root + surface class keyed。 */
  setWorkspaceUiState(workspaceRoot, surface, entry) {
    const workspace = normalizeWorkspacePath(workspaceRoot);
    if (!workspace) return null;
    const prefs = this._mutableCopy();
    prefs.workspace_ui_state = upsertWorkspaceUiState(
      prefs.workspace_ui_state || {},
      workspace,
      entry,
      { surface },
    );
    this.savePreferences(prefs);
    return getWorkspaceUiStateEntry(prefs.workspace_ui_state, workspace, { surface });
  }

  /** 清理已确定不存在的 workspace UI state 根目录；权限错误等未知状态会保留。 */
  gcWorkspaceUiState( options: any = {}) {
    const prefs = this._mutableCopy();
    const { state, changed } = pruneMissingWorkspaceUiState(prefs.workspace_ui_state || {}, options);
    if (changed || prefs.workspace_ui_state) {
      prefs.workspace_ui_state = state;
    }
    if (changed) this.savePreferences(prefs);
    return state;
  }

  /** 读取侧边栏 UI 偏好（项目视图展开、展开全部等）。 */
  getSidebarUiPrefs() {
    return normalizeSidebarUiPrefs(this._cache.sidebar_ui || {});
  }

  /** 合并写入侧边栏 UI 偏好，按 UI 类型独立存储。 */
  setSidebarUiPrefs(partial) {
    const prefs = this._mutableCopy();
    prefs.sidebar_ui = mergeSidebarUiPrefs(prefs.sidebar_ui || {}, partial || {});
    this.savePreferences(prefs);
    return this.getSidebarUiPrefs();
  }

  /** 读取时区偏好（全局） */
  getTimezone() {
    return this._cache.timezone || "";
  }

  /** 保存时区偏好 */
  setTimezone(tz) {
    const prefs = this._mutableCopy();
    prefs.timezone = tz || "";
    this.savePreferences(prefs);
  }

  /** 读取 thinking level 偏好（用户全局，跨 agent / session） */
  getThinkingLevel() {
    return normalizeSessionThinkingLevel(this._cache.thinking_level);
  }

  /** 保存 thinking level 偏好 */
  setThinkingLevel(level) {
    const prefs = this._mutableCopy();
    prefs.thinking_level = normalizeSessionThinkingLevel(level);
    this.savePreferences(prefs);
  }

  /** 读取外部技能扫描路径 */
  getExternalSkillPaths() {
    return this._cache.external_skill_paths || [];
  }

  /** 保存外部技能扫描路径 */
  setExternalSkillPaths(paths) {
    const prefs = this._mutableCopy();
    prefs.external_skill_paths = paths;
    this.savePreferences(prefs);
  }

  /** 读取 OAuth 自定义模型 { provider: ["model-id", ...] }
   *  返回浅拷贝：调用方（如 auth.js）会 push() 到子数组再保存，
   *  必须隔离以免脏写 _cache */
  getOAuthCustomModels() {
    const src = this._cache.oauth_custom_models;
    if (!src) return {};
    const copy: any = {};
    for (const [k, v] of Object.entries(src)) {
      copy[k] = Array.isArray(v) ? [...v] : v;
    }
    return copy;
  }

  /** 设置某个 OAuth provider 的自定义模型列表 */
  setOAuthCustomModels(provider, modelIds) {
    const prefs = this._mutableCopy();
    if (!prefs.oauth_custom_models) prefs.oauth_custom_models = {};
    if (modelIds.length === 0) {
      delete prefs.oauth_custom_models[provider];
    } else {
      prefs.oauth_custom_models[provider] = modelIds;
    }
    this.savePreferences(prefs);
  }

  /** 读取是否允许 full-access 社区插件运行 */
  getAllowFullAccessPlugins() {
    return this._cache.allow_full_access_plugins || false;
  }

  /** 保存是否允许 full-access 社区插件运行 */
  setAllowFullAccessPlugins(value) {
    const prefs = this._mutableCopy();
    prefs.allow_full_access_plugins = !!value;
    this.savePreferences(prefs);
  }

  /** 读取 Agent 插件开发工具开关（全局，默认关闭） */
  getPluginDevToolsEnabled() {
    return this._cache.plugin_dev_tools?.enabled === true;
  }

  /** 保存 Agent 插件开发工具开关 */
  setPluginDevToolsEnabled(value) {
    const prefs = this._mutableCopy();
    prefs.plugin_dev_tools = {
      ...(prefs.plugin_dev_tools || {}),
      enabled: value === true,
    };
    this.savePreferences(prefs);
    return prefs.plugin_dev_tools.enabled;
  }

  /**
   * 读取内置/插件工具的延迟加载开关（全局，默认关闭）。
   *
   * 默认关闭是刻意的：内置工具是 Agent 的基本能力，把它们移出前缀会改变
   * 每个 session 的既有行为。外部 MCP 工具默认延迟，内置工具需要显式 opt-in。
   */
  getBuiltinToolDeferEnabled() {
    return this._cache.builtin_tool_defer?.enabled === true;
  }

  /** 保存内置/插件工具的延迟加载开关 */
  setBuiltinToolDeferEnabled(value) {
    const prefs = this._mutableCopy();
    prefs.builtin_tool_defer = {
      ...(prefs.builtin_tool_defer || {}),
      enabled: value === true,
    };
    this.savePreferences(prefs);
    return prefs.builtin_tool_defer.enabled;
  }

  /** 读取用户手动禁用的插件 ID 列表 */
  getDisabledPlugins() {
    return this._cache.disabled_plugins || [];
  }

  /** 保存用户手动禁用的插件 ID 列表 */
  setDisabledPlugins(list) {
    const prefs = this._mutableCopy();
    prefs.disabled_plugins = Array.isArray(list) ? list : [];
    this.savePreferences(prefs);
  }

  /** 读取插件 UI 偏好（hiddenWidgets / hiddenTabs / tabOrder） */
  getPluginUiPrefs() {
    const raw = this._cache.plugin_ui;
    return {
      hiddenWidgets: Array.isArray(raw?.hiddenWidgets) ? raw.hiddenWidgets : [],
      hiddenTabs: Array.isArray(raw?.hiddenTabs) ? raw.hiddenTabs : [],
      tabOrder: Array.isArray(raw?.tabOrder) ? raw.tabOrder : [],
    };
  }

  /** 合并写入插件 UI 偏好 */
  setPluginUiPrefs(partial) {
    const prefs = this._mutableCopy();
    const current = prefs.plugin_ui || {};
    const merged = { ...current };
    if (Array.isArray(partial.hiddenWidgets)) merged.hiddenWidgets = partial.hiddenWidgets;
    if (Array.isArray(partial.hiddenTabs)) merged.hiddenTabs = partial.hiddenTabs;
    if (Array.isArray(partial.tabOrder)) merged.tabOrder = partial.tabOrder;
    prefs.plugin_ui = merged;
    this.savePreferences(prefs);
    return this.getPluginUiPrefs();
  }

  getImageGenerationConfig() {
    return normalizeImageGenerationConfig(this._cache.imageGeneration);
  }

  hasImageGenerationLegacyConfigMigrated() {
    return this._cache._imageGenerationLegacyConfigMigrated === true;
  }

  migrateImageGenerationConfigFromLegacy(legacyConfig) {
    if (this.hasImageGenerationLegacyConfigMigrated()) {
      return this.getImageGenerationConfig();
    }
    const prefs = this._mutableCopy();
    prefs.imageGeneration = mergeImageGenerationConfig(
      normalizeImageGenerationConfig(legacyConfig),
      normalizeImageGenerationConfig(prefs.imageGeneration),
    );
    prefs._imageGenerationLegacyConfigMigrated = true;
    this.savePreferences(prefs);
    return this.getImageGenerationConfig();
  }

  setImageGenerationConfig(config) {
    const prefs = this._mutableCopy();
    prefs.imageGeneration = normalizeImageGenerationConfig(config);
    this.savePreferences(prefs);
    return this.getImageGenerationConfig();
  }

  getVideoGenerationConfig() {
    return normalizeVideoGenerationConfig(this._cache.videoGeneration);
  }

  setVideoGenerationConfig(config) {
    const prefs = this._mutableCopy();
    prefs.videoGeneration = normalizeVideoGenerationConfig(config);
    this.savePreferences(prefs);
    return this.getVideoGenerationConfig();
  }

  getSpeechRecognitionConfig() {
    const raw = this._cache.speechRecognition;
    const defaultModel = raw?.defaultModel && typeof raw.defaultModel === "object" && !Array.isArray(raw.defaultModel)
      ? {
        provider: typeof raw.defaultModel.provider === "string" ? raw.defaultModel.provider : "",
        id: typeof raw.defaultModel.id === "string" ? raw.defaultModel.id : "",
      }
      : null;
    return {
      enabled: raw?.enabled === true,
      ...(defaultModel?.provider && defaultModel.id ? { defaultModel } : {}),
    };
  }

  setSpeechRecognitionConfig(config) {
    const prefs = this._mutableCopy();
    const next = {
      enabled: config?.enabled === true,
      ...(config?.defaultModel?.provider && config?.defaultModel?.id ? {
        defaultModel: {
          provider: config.defaultModel.provider,
          id: config.defaultModel.id,
        },
      } : {}),
    };
    prefs.speechRecognition = next;
    this.savePreferences(prefs);
    return this.getSpeechRecognitionConfig();
  }

  /** 读取实验功能值（global scope）。未知 id 的语义由实验 registry 判断。 */
  getExperimentValue(id) {
    const experiments = this._cache.experiments;
    if (!experiments || typeof experiments !== "object" || Array.isArray(experiments)) return undefined;
    return experiments[id];
  }

  /** 保存实验功能值（global scope）。只保存值，不把 registry 定义混入 preferences。 */
  setExperimentValue(id, value) {
    const prefs = this._mutableCopy();
    const current = prefs.experiments && typeof prefs.experiments === "object" && !Array.isArray(prefs.experiments)
      ? prefs.experiments
      : {};
    prefs.experiments = { ...current, [id]: value };
    this.savePreferences(prefs);
  }

  /** 读取更新通道偏好："stable" | "beta" */
  getUpdateChannel() {
    return this._cache.update_channel || "stable";
  }

  /** 保存更新通道偏好 */
  setUpdateChannel(channel) {
    const prefs = this._mutableCopy();
    prefs.update_channel = channel === "beta" ? "beta" : "stable";
    this.savePreferences(prefs);
  }

  /** 读取"自动检查更新"开关：默认 true */
  getAutoCheckUpdates() {
    return this._cache.auto_check_updates !== false;
  }

  /** 保存"自动检查更新"开关 */
  setAutoCheckUpdates(value) {
    const prefs = this._mutableCopy();
    prefs.auto_check_updates = value !== false;
    this.savePreferences(prefs);
  }

  /** 读取桌面保活开关。默认关闭。 */
  getKeepAwake() {
    return this._cache.keep_awake === true;
  }

  /** 保存桌面保活开关。 */
  setKeepAwake(value) {
    const prefs = this._mutableCopy();
    prefs.keep_awake = value === true;
    this.savePreferences(prefs);
  }

  /** 读取 primary agent ID */
  getPrimaryAgent() {
    return this._cache.primaryAgent || null;
  }

  /** 保存 primary agent ID */
  savePrimaryAgent(agentId) {
    const prefs = this._mutableCopy();
    prefs.primaryAgent = agentId;
    this.savePreferences(prefs);
  }

  /**
   * 找到 agents/ 目录下第一个合法的 agent
   * @returns {string|null}
   */
  findFirstAgent() {
    try {
      const entries = fs.readdirSync(this._agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!isValidAgentId(entry.name)) continue;
        if (fs.existsSync(path.join(this._agentsDir, entry.name, "config.yaml"))) {
          return entry.name;
        }
      }
    } catch {}
    return null;
  }
}

export function normalizeImageGenerationConfig(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaultModel = raw.defaultImageModel && typeof raw.defaultImageModel === "object" && !Array.isArray(raw.defaultImageModel)
    ? {
      provider: typeof raw.defaultImageModel.provider === "string" ? raw.defaultImageModel.provider.trim() : "",
      id: typeof raw.defaultImageModel.id === "string" ? raw.defaultImageModel.id.trim() : "",
    }
    : null;
  const providerDefaults = raw.providerDefaults && typeof raw.providerDefaults === "object" && !Array.isArray(raw.providerDefaults)
    ? structuredClone(raw.providerDefaults)
    : null;
  return {
    ...(defaultModel?.provider && defaultModel.id ? { defaultImageModel: defaultModel } : {}),
    ...(providerDefaults ? { providerDefaults } : {}),
  };
}

export function normalizeVideoGenerationConfig(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaultModel = raw.defaultVideoModel && typeof raw.defaultVideoModel === "object" && !Array.isArray(raw.defaultVideoModel)
    ? {
      provider: typeof raw.defaultVideoModel.provider === "string" ? raw.defaultVideoModel.provider.trim() : "",
      id: typeof raw.defaultVideoModel.id === "string" ? raw.defaultVideoModel.id.trim() : "",
    }
    : null;
  const providerDefaults = raw.providerDefaults && typeof raw.providerDefaults === "object" && !Array.isArray(raw.providerDefaults)
    ? structuredClone(raw.providerDefaults)
    : null;
  return {
    ...(defaultModel?.provider && defaultModel.id ? { defaultVideoModel: defaultModel } : {}),
    ...(providerDefaults ? { providerDefaults } : {}),
  };
}

export function mergeImageGenerationConfig(base, override) {
  const left = normalizeImageGenerationConfig(base);
  const right = normalizeImageGenerationConfig(override);
  const next: any = {};
  const defaultModel = right.defaultImageModel || left.defaultImageModel || null;
  if (defaultModel) next.defaultImageModel = defaultModel;
  const providerDefaults = mergeProviderDefaults(left.providerDefaults, right.providerDefaults);
  if (providerDefaults) next.providerDefaults = providerDefaults;
  return next;
}

function mergeProviderDefaults(base, override) {
  const left = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  const right = override && typeof override === "object" && !Array.isArray(override) ? override : {};
  const providerIds = new Set([...Object.keys(left), ...Object.keys(right)]);
  if (providerIds.size === 0) return null;
  const next = {};
  for (const providerId of providerIds) {
    const baseValue = left[providerId];
    const overrideValue = right[providerId];
    if (
      baseValue && typeof baseValue === "object" && !Array.isArray(baseValue)
      && overrideValue && typeof overrideValue === "object" && !Array.isArray(overrideValue)
    ) {
      next[providerId] = { ...structuredClone(baseValue), ...structuredClone(overrideValue) };
    } else if (overrideValue !== undefined) {
      next[providerId] = structuredClone(overrideValue);
    } else {
      next[providerId] = structuredClone(baseValue);
    }
  }
  return next;
}

function normalizeBridgeMediaPublicBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("bridge media public base URL must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("bridge media public base URL must use http or https");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("bridge media public base URL must not include query or hash");
  }
  return raw.replace(/\/+$/, "");
}

function normalizeAppearance(value) {
  const src = value && typeof value === "object" ? value : {};
  const out: any = {};
  if (typeof src.theme === "string" && src.theme.trim()) out.theme = src.theme.trim();
  if (typeof src.serif === "boolean") out.serif = src.serif;
  if (typeof src.paperTexture === "boolean") out.paperTexture = src.paperTexture;
  if (typeof src.leavesOverlay === "boolean") out.leavesOverlay = src.leavesOverlay;
  return out;
}
