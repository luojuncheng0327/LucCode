/**
 * update-settings-tool.js — 设置修改工具（渐进式披露）
 *
 * 两阶段调用：search 查找设置项 → apply 修改设置项。
 * description 不列举设置，由 search 按需返回匹配结果。
 */

import path from "path";
import { Type, StringEnum } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import themeRegistry from "../../desktop/src/shared/theme-registry.cjs";
import { parseModelRef } from "../../shared/model-ref.ts";
import { emitAppEvent } from "../../server/app-events.ts";
import {
  migrateLegacyEditableFacts,
  readEditableFactsText,
  writeEditableFactsSection,
} from "../memory/compile.ts";
import {
  createSettingsToolResult,
  createSettingsUpdate,
  formatSettingsValue,
} from "./settings-update-result.ts";

/**
 * i18n key → 本地化标签 批量转换
 */
function i18nLabels(keyMap: Record<string, string>) {
  return Object.fromEntries(Object.entries(keyMap).map(([k, v]) => [k, t(v)]));
}

const THEME_I18N = Object.fromEntries(
  Object.entries(themeRegistry.THEMES).map(([id, theme]) => [id, theme.i18nName])
);
// 'auto' 不在 THEMES 表里，显式补上
THEME_I18N[themeRegistry.AUTO_OPTION.id] = themeRegistry.AUTO_OPTION.i18nName;

const THINKING_I18N = {
  "off": "settings.agent.thinkingLevels.off",
  "low": "settings.agent.thinkingLevels.low",
  "medium": "settings.agent.thinkingLevels.medium",
  "high": "settings.agent.thinkingLevels.high",
  "max": "settings.agent.thinkingLevels.max",
  "xhigh": "settings.agent.thinkingLevels.xhigh",
};

const LOCALE_LABELS = {
  "zh-CN": "简体中文", "zh-TW": "繁體中文", "ja": "日本語", "ko": "한국어", "en": "English",
};

const MCP_SETTINGS_ACTIONS = {
  "mcp.global.enabled": {
    type: "toggle",
    label: "MCP enabled",
    description: "Enable or disable MCP connectors globally.",
    searchTerms: ["mcp", "connector", "server", "global", "enable", "disable"],
  },
  "mcp.connector.add": {
    type: "text",
    label: "Add MCP connector",
    description: "Add a remote or local MCP connector. Use a JSON value with name, transport, url or command, authType, and optional secrets.",
    searchTerms: ["mcp", "connector", "server", "add", "install", "github", "remote"],
  },
  "mcp.connector.update": {
    type: "text",
    label: "Update MCP connector",
    description: "Update an MCP connector. Use a JSON value with connectorId and the fields to change.",
    searchTerms: ["mcp", "connector", "server", "update", "edit"],
  },
  "mcp.connector.remove": {
    type: "text",
    label: "Remove MCP connector",
    description: "Remove an MCP connector by connectorId.",
    searchTerms: ["mcp", "connector", "server", "remove", "delete"],
  },
  "mcp.connector.start": {
    type: "text",
    label: "Start MCP connector",
    description: "Start an MCP connector by connectorId.",
    searchTerms: ["mcp", "connector", "server", "start"],
  },
  "mcp.connector.stop": {
    type: "text",
    label: "Stop MCP connector",
    description: "Stop an MCP connector by connectorId.",
    searchTerms: ["mcp", "connector", "server", "stop"],
  },
  "mcp.connector.refresh_tools": {
    type: "text",
    label: "Refresh MCP tools",
    description: "Refresh the tool list for a running MCP connector by connectorId.",
    searchTerms: ["mcp", "connector", "tools", "refresh", "reload"],
  },
  "mcp.agent.connector.enable": {
    type: "toggle",
    label: "Enable MCP connector for this agent",
    description: "Enable or disable one MCP connector for the current agent. Use JSON with connectorId and enabled.",
    scope: "agent",
    searchTerms: ["mcp", "agent", "connector", "enable", "disable"],
  },
  "mcp.agent.tool.enable": {
    type: "toggle",
    label: "Enable MCP tool for this agent",
    description: "Enable or disable one MCP tool for the current agent. Use JSON with connectorId, toolName, and enabled.",
    scope: "agent",
    searchTerms: ["mcp", "agent", "tool", "enable", "disable"],
  },
};

function requireAgentId(agent, key) {
  const agentId = agent?.id || null;
  if (!agentId) throw new Error(`${key} requires target agent`);
  return agentId;
}

function resolveAgentMemoryPaths(agent, key) {
  const memoryMdPath = agent?.memoryMdPath
    || (agent?.agentDir ? path.join(agent.agentDir, "memory", "memory.md") : null);
  if (!memoryMdPath) throw new Error(`${key} requires target agent memory path`);
  return {
    memoryMdPath,
    memoryDir: path.dirname(memoryMdPath),
  };
}

const USER_ONLY_SETTINGS = {
  sandbox: {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.sandbox"); },
    get description() { return t("toolDef.updateSettings.sandboxDesc"); },
  },
  sandbox_network: {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.sandboxNetwork"); },
    get description() { return t("toolDef.updateSettings.sandboxNetworkDesc"); },
  },
};

/**
 * 设置注册表
 */
const SETTINGS_REGISTRY = {
  file_backup: {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.fileBackup"); },
    get description() { return t("toolDef.updateSettings.fileBackupDesc"); },
    searchTerms: ["backup", "备份", "バックアップ", "백업", "checkpoint"],
    get: (engine, _agent) => String(engine.preferences.getFileBackup().enabled),
    apply: (engine, _agent, v) => {
      const enabled = typeof v === "string" ? v === "true" : !!v;
      engine.setFileBackup({ enabled });
    },
  },
  locale: {
    type: "list",
    get label() { return t("toolDef.updateSettings.locale"); },
    options: ["zh-CN", "zh-TW", "ja", "ko", "en"],
    optionLabels: LOCALE_LABELS,
    searchTerms: ["language", "国际化", "言語", "언어"],
    get: (engine, _agent) => engine.preferences.getLocale() || "zh-CN",
    apply: (engine, _agent, v) => engine.setLocale(v),
  },
  timezone: {
    type: "text",
    get label() { return t("toolDef.updateSettings.timezone"); },
    get description() { return t("toolDef.updateSettings.timezoneDesc"); },
    get: (engine, _agent) => engine.preferences.getTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone,
    apply: (engine, _agent, v) => engine.setTimezone(v),
  },
  bridge_media_public_base_url: {
    type: "text",
    get label() { return t("toolDef.updateSettings.bridgeMediaPublicBaseUrl"); },
    get description() { return t("toolDef.updateSettings.bridgeMediaPublicBaseUrlDesc"); },
    searchTerms: ["bridge", "media", "public url", "公网", "文件发送", "qq", "tunnel", "ngrok", "cloudflare"],
    get: (engine, _agent) => engine.getBridgeMediaPublicBaseUrl?.() || "",
    apply: (engine, _agent, v) => engine.setBridgeMediaPublicBaseUrl(v),
  },
  "computer_use.enabled": {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.computerUse"); },
    get description() { return t("toolDef.updateSettings.computerUseDesc"); },
    searchTerms: ["computer use", "computer", "电脑控制", "使用电脑", "实验", "desktop control", "gui"],
    get: (engine, _agent) => String(engine.getComputerUseSettings?.()?.enabled === true),
    apply: async (engine, _agent, v) => {
      const enabled = v === true || v === "true";
      if (typeof engine.updateComputerUseSettings === "function") {
        await engine.updateComputerUseSettings({ enabled });
        return;
      }
      if (typeof engine.setComputerUseSettings === "function") {
        engine.setComputerUseSettings({ enabled });
        return;
      }
      throw new Error("computer use preferences are not available");
    },
  },
  thinking_level: {
    type: "list",
    get label() { return t("toolDef.updateSettings.thinkingBudget"); },
    options: ["off", "low", "medium", "high", "max"],
    get optionLabels() { return i18nLabels(THINKING_I18N); },
    searchTerms: ["reasoning", "推理", "思考", "推論"],
    get: (engine, _agent) => {
      if (engine.currentSessionPath && typeof engine.getSessionThinkingLevel === "function") {
        const sessionLevel = engine.getSessionThinkingLevel(engine.currentSessionPath);
        if (sessionLevel) return sessionLevel;
      }
      return engine.getDefaultThinkingLevel?.() || engine.preferences.getThinkingLevel() || "medium";
    },
    apply: (engine, _agent, v) => {
      if (engine.currentSessionPath && typeof engine.setSessionThinkingLevel === "function") {
        return engine.setSessionThinkingLevel(engine.currentSessionPath, v);
      }
      if (typeof engine.setDefaultThinkingLevel === "function") {
        return engine.setDefaultThinkingLevel(v);
      }
      return engine.setThinkingLevel(v);
    },
  },
  "memory.enabled": {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.memory"); },
    get description() { return t("toolDef.updateSettings.memoryDesc"); },
    scope: "agent",
    get: (engine, agent) => agent ? String(agent.memoryMasterEnabled !== false) : null,
    apply: (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      agent.updateConfig({ memory: { enabled: v === true || v === "true" } });
    },
  },
  "memory.facts": {
    type: "text",
    get label() { return t("toolDef.updateSettings.memoryFacts"); },
    get description() { return t("toolDef.updateSettings.memoryFactsDesc"); },
    scope: "agent",
    searchTerms: ["facts", "editable memory", "memory facts", "记忆事实", "重要事实", "可编辑记忆"],
    get: (engine, agent) => {
      if (!agent) return null;
      try {
        const { memoryDir } = resolveAgentMemoryPaths(agent, "memory.facts");
        // 幂等：即使该 agent 从未跑起过 memoryTicker，也要在首次读取时把
        // 遗留的 editable-facts.md 并入规范的 facts.md。
        migrateLegacyEditableFacts(memoryDir);
        return readEditableFactsText(memoryDir);
      } catch {
        return null;
      }
    },
    apply: async (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      const { memoryDir, memoryMdPath } = resolveAgentMemoryPaths(agent, "memory.facts");
      migrateLegacyEditableFacts(memoryDir);
      writeEditableFactsSection(memoryDir, v, {
        summaryManager: agent.summaryManager,
        memoryMdPath,
      });
      await engine.updateConfig?.({}, { agentId: agent.id });
    },
  },
  "experience.enabled": {
    type: "toggle",
    get label() { return t("toolDef.updateSettings.experience"); },
    get description() { return t("toolDef.updateSettings.experienceDesc"); },
    scope: "agent",
    searchTerms: ["experience", "经验", "成長", "成长", "経験", "경험"],
    get: (_engine, agent) => agent ? String(agent.experienceEnabled === true) : null,
    apply: (_engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      agent.updateConfig({ experience: { enabled: v === true || v === "true" } });
    },
  },
  "agent.name": {
    type: "text",
    get label() { return t("toolDef.updateSettings.agentName"); },
    scope: "agent",
    get: (engine, agent) => agent?.agentName || null,
    apply: (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      agent.updateConfig({ agent: { name: v } });
    },
  },
  // 用户的名字描述的是使用者本人，不是某个 agent 的属性：改一次，所有 agent
  // 都跟着改口。所以这里写全局 preferences，而不是当前 agent 的 config。
  "user.name": {
    type: "text",
    get label() { return t("toolDef.updateSettings.userName"); },
    get: (engine, agent) => agent?.userName || engine.getUserName?.() || null,
    apply: (engine, _agent, v) => engine.setUserName(v),
  },
  home_folder: {
    type: "text",
    get label() { return t("toolDef.updateSettings.workingDir"); },
    get description() { return t("toolDef.updateSettings.workingDirDesc"); },
    scope: "agent",
    get: (engine, agent) => engine.getHomeFolder(requireAgentId(agent, "home_folder")) || "",
    apply: (engine, agent, v) => engine.setHomeFolder(requireAgentId(agent, "home_folder"), v),
  },
  theme: {
    type: "list",
    get label() { return t("toolDef.updateSettings.theme"); },
    options: [...themeRegistry.getThemeIds(), themeRegistry.AUTO_OPTION.id],
    get optionLabels() { return i18nLabels(THEME_I18N); },
    searchTerms: ["dark", "light", "暗色", "亮色", "外观", "appearance", "夜间", "ダーク", "다크"],
    get: (engine, _agent) => engine.getAppearance?.().theme || themeRegistry.AUTO_OPTION.id,
    apply: (engine, _agent, v) => {
      if (typeof engine.setAppearance !== "function") {
        throw new Error("appearance preferences are not available");
      }
      const before = engine.getAppearance?.() || {};
      const appearance = engine.setAppearance({ theme: v }) || {};
      if (appearance.theme && appearance.theme !== before.theme) {
        emitAppEvent(engine, "theme-changed", { theme: appearance.theme });
      }
    },
  },
  "models.chat": {
    type: "list",
    get label() { return t("toolDef.updateSettings.chatModel"); },
    scope: "agent",
    optionsFrom: "availableModels",
    searchTerms: ["model", "模型", "モデル", "모델"],
    get: (_engine, agent) => {
      const ref = parseModelRef(agent?.config?.models?.chat);
      if (!ref?.id) return null;
      return ref.provider ? `${ref.provider}/${ref.id}` : ref.id;
    },
    apply: async (engine, agent, v) => {
      if (!agent) throw new Error("no active agent");
      const ref = parseModelRef(v);
      if (!ref?.id || !ref?.provider) {
        throw new Error(`models.chat requires provider/id (got ${JSON.stringify(v)})`);
      }
      await engine.setDefaultModel(ref.id, ref.provider, { agentId: agent.id });
    },
  },
};

// ── 搜索 ──

function resolveOptions(reg, engine) {
  if (reg.optionsFrom === "availableModels") {
    return (engine.availableModels || []).map(m => `${m.provider}/${m.id}`);
  }
  return reg.options || null;
}

function resolveOptionLabels(reg, engine) {
  if (reg.optionsFrom === "availableModels") {
    return Object.fromEntries(
      (engine.availableModels || []).map(m => [`${m.provider}/${m.id}`, m.name || m.id]),
    );
  }
  return reg.optionLabels || null;
}

function resolveTargetAgent(engine, fallbackAgent) {
  const agentId = fallbackAgent?.id || null;
  if (!agentId) return { agentId: null, agent: fallbackAgent || null };
  const agent = typeof engine?.getAgent === "function"
    ? (engine.getAgent(agentId) || fallbackAgent)
    : fallbackAgent;
  return { agentId, agent };
}

function searchSettings(query, engine) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const [key, reg] of Object.entries({ ...SETTINGS_REGISTRY, ...MCP_SETTINGS_ACTIONS }) as [string, any][]) {
    const options = resolveOptions(reg, engine);
    const optionLabels = resolveOptionLabels(reg, engine);
    const haystack = [
      key, reg.label, reg.description || "",
      ...(reg.searchTerms || []),
      ...(options || []),
      ...Object.keys(optionLabels || {}),
      ...Object.values(optionLabels || {}),
    ].join(" ").toLowerCase();
    if (haystack.includes(q)) {
      results.push({ key, reg, options });
    }
  }
  return results;
}

// ── 格式化 ──

function formatOptionList(options, labels, maxShow = 12) {
  if (!options?.length) return "";
  const shown = options.slice(0, maxShow);
  const rest = options.length - shown.length;
  const parts = shown.map(o => labels?.[o] ? `${o}(${labels[o]})` : o);
  if (rest > 0) parts.push(`...+${rest}`);
  return parts.join(" / ");
}

function formatSearchResults(results, engine, agent) {
  return results.map((r, i) => {
    const { key, reg, options } = r;
    const ol = resolveOptionLabels(reg, engine);
    const lines = [`[${i + 1}] ${key} — ${reg.label} (${reg.type})`];

    if (typeof reg.get === "function") {
      const cv = reg.get(engine, agent);
      if (cv === null) {
        lines.push(`    → (N/A)`);
      } else {
        const cvLabel = ol?.[cv] ? `${cv} (${ol[cv]})` : cv;
        lines.push(`    → ${cvLabel}`);
      }
    } else if (reg.scope === "agent" && !agent) {
      lines.push(`    → (N/A)`);
    }

    // 选项列表
    if (options?.length) {
      lines.push(`    ${formatOptionList(options, ol)}`);
    }
    if (reg.description) {
      lines.push(`    ${reg.description}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

function displayLabelForUpdate(key, reg) {
  if (key === "locale") return "Locale";
  return reg?.label || key;
}

function createUserOnlySettingsResult(key, reg) {
  const label = displayLabelForUpdate(key, reg);
  return createSettingsToolResult({
    status: "blocked",
    action: "core.apply",
    key,
    title: `${label} is user-only`,
    summary: `${label} controls the execution boundary. Ask the user to open Settings > Security to change it.`,
  }, {
    settingKey: key,
    cardType: reg?.type || "text",
    currentValue: "",
    proposedValue: "",
    label,
    confirmed: false,
  });
}

function parseSettingsPayload(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return {};
  if (raw === "true" || raw === "false") return { enabled: raw === "true", value: raw === "true" };
  if (raw.startsWith("{") || raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return { value: parsed };
  }
  return { value: raw };
}

async function applyMcpSettingsAction(engine, key, value, agentId) {
  const bus = engine?.getEventBus?.() || engine?.eventBus || null;
  if (!bus?.request) {
    return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
  }
  let payload;
  try {
    payload = parseSettingsPayload(value);
  } catch (err) {
    return { content: [{ type: "text", text: t("error.settingsApplyFailed", { msg: err.message }) }] };
  }
  try {
    const result = await bus.request("mcp:settings-action", { action: key, agentId: agentId || null, payload });
    if (result?.settingsUpdate) {
      return createSettingsToolResult(result.settingsUpdate, {
        settingKey: key,
        cardType: MCP_SETTINGS_ACTIONS[key]?.type || "text",
        confirmed: true,
      });
    }
    return createSettingsToolResult({
      status: "applied",
      action: key,
      key,
      title: "MCP settings updated",
      summary: "MCP settings were updated.",
    }, { settingKey: key, cardType: MCP_SETTINGS_ACTIONS[key]?.type || "text", confirmed: true });
  } catch (err) {
    const update = createSettingsUpdate({
      status: "failed",
      action: key,
      key,
      title: "MCP settings change failed",
      summary: err.message || "MCP settings change failed.",
    });
    return createSettingsToolResult(update, { settingKey: key, cardType: MCP_SETTINGS_ACTIONS[key]?.type || "text", confirmed: false });
  }
}

// ── 工具 ──

export function createUpdateSettingsTool(deps: Record<string, any> = {}) {
  const {
    getEngine,
    getAgent,
  } = deps;

  return {
    name: "update_settings",
    userFacingName: "Settings",
    description: "Modify LucCode's settings. When the user mentions changing settings without naming a specific app, assume this application. For preferences like appearance/theme, language/region, model selection, memory, personal info, working directory, or MCP connectors, use this tool, and do not search the web or edit config files directly. Sandbox and execution-boundary controls are user-only: tell the user to open Settings > Security instead of applying them. Two actions available:\n- search + query: Search settings by keyword, see current values and options\n- apply + key + value: Change a setting (Auto reviews the boundary in the background; Ask may request confirmation)\n\nIf you already know the exact key, you can apply directly. When intent is clear, apply directly and report the result in one sentence; when unsure, search first.",
    sessionPermission: {
      resolveInvocation: (params: any = {}) => {
        if (params.action === "search") {
          return {
            action: "search",
            kind: "read",
            capability: "update_settings.search",
          };
        }
        if (params.action === "apply") {
          const key = typeof params.key === "string" ? params.key : "";
          if (!key || key !== key.trim() || params.value === undefined) return null;
          const isUserOnly = Object.hasOwn(USER_ONLY_SETTINGS, key);
          const isMcpAction = Object.hasOwn(MCP_SETTINGS_ACTIONS, key);
          const isRegistered = Object.hasOwn(SETTINGS_REGISTRY, key);
          if (!isUserOnly && !isMcpAction && !isRegistered) return null;

          return {
            action: "apply",
            kind: "review",
            capability: "update_settings.apply",
            target: { type: "setting", id: key, label: key },
          };
        }
        return null;
      },
    },
    parameters: Type.Object({
      action: StringEnum(
        ["search", "apply"],
        { description: "Action: search to find settings / apply to change a setting" },
      ),
      query: Type.Optional(Type.String({ description: "Search keyword (required for search)" })),
      key: Type.Optional(Type.String({ description: "Setting key (found via search)" })),
      value: Type.Optional(Type.String({ description: "Proposed new value" })),
    }),
    isUserFacing: true,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const engine = getEngine?.();
      const initialAgent = getAgent?.() || engine?.agent;
      const { agentId: targetAgentId, agent: targetAgent } = resolveTargetAgent(engine, initialAgent);

      switch (params.action) {
        // ── search ──
        case "search": {
          const query = params.query?.trim();
          if (!query) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.searchMissingQuery") }] };
          }
          if (!engine) {
            return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
          }
          const results = searchSettings(query, engine);
          if (results.length === 0) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.searchNoResults", { query }) }] };
          }
          const body = formatSearchResults(results, engine, targetAgent);
          return { content: [{ type: "text", text: t("toolDef.updateSettings.searchResult", { count: String(results.length), results: body }) }] };
        }

        // ── apply ──
        case "apply": {
          const { key, value } = params;
          if (!key || value === undefined) {
            return { content: [{ type: "text", text: t("toolDef.updateSettings.applyMissingParams") }] };
          }

          if (!engine) {
            return { content: [{ type: "text", text: t("error.settingsNotReady") }] };
          }

          if (Object.hasOwn(USER_ONLY_SETTINGS, key)) {
            return createUserOnlySettingsResult(key, USER_ONLY_SETTINGS[key]);
          }

          if (Object.hasOwn(MCP_SETTINGS_ACTIONS, key)) {
            const actionMeta = MCP_SETTINGS_ACTIONS[key];
            if (actionMeta.scope === "agent" && !targetAgentId) {
              return { content: [{ type: "text", text: t("error.settingsNoAgent") }] };
            }
            return applyMcpSettingsAction(engine, key, value, targetAgentId);
          }

          const reg = SETTINGS_REGISTRY[key];
          if (!reg) {
            return { content: [{ type: "text", text: t("error.settingsUnknownKey", { key }) }] };
          }

          // scope: "agent" 的设置在无 agent 时拒绝操作
          if (reg.scope === "agent" && !targetAgent) {
            return { content: [{ type: "text", text: t("error.settingsNoAgent") }] };
          }

          // 读取当前值
          const currentValue = reg.get(engine, targetAgent);

          // 动态选项
          const options = resolveOptions(reg, engine);

          // toggle 校验
          if (reg.type === "toggle" && value !== "true" && value !== "false") {
            return { content: [{ type: "text", text: t("error.settingsInvalidToggle") }] };
          }

          // list 校验
          if (reg.type === "list" && options?.length && !options.includes(value)) {
            const ol = resolveOptionLabels(reg, engine);
            const optList = formatOptionList(options, ol);
            return { content: [{ type: "text", text: t("error.settingsInvalidValue", { value, options: optList }) }] };
          }

          try {
            if (typeof reg.apply === "function") {
              const parsed = reg.type === "toggle" ? (value === "true") : value;
              const { agent: applyAgent } = resolveTargetAgent(engine, targetAgent);
              await reg.apply(engine, applyAgent, parsed);
            }
            let afterValue = typeof reg.get === "function" ? reg.get(engine, targetAgent) : value;
            if (String(afterValue ?? "") === String(currentValue ?? "") && String(value) !== String(currentValue ?? "")) {
              afterValue = value;
            }
            const label = displayLabelForUpdate(key, reg);
            return createSettingsToolResult({
              status: "applied",
              action: "core.apply",
              key,
              title: `${label} updated`,
              summary: `${label} changed from ${formatSettingsValue(currentValue, { key })} to ${formatSettingsValue(afterValue, { key })}.`,
              target: reg.scope === "agent" ? { type: "agent", id: targetAgentId, label: targetAgent?.agentName || targetAgentId } : { type: "global", id: "preferences", label: "Preferences" },
              changes: [{
                key,
                label,
                before: currentValue,
                after: afterValue,
              }],
            }, {
              settingKey: key,
              cardType: reg.type,
              currentValue: String(currentValue ?? ""),
              proposedValue: String(value),
              label,
              confirmed: true,
            });
          } catch (err) {
            return createSettingsToolResult({
              status: "failed",
              action: "core.apply",
              key,
              title: `${displayLabelForUpdate(key, reg)} update failed`,
              summary: err.message || t("error.settingsApplyFailed", { msg: "" }),
            }, {
              settingKey: key,
              cardType: reg.type,
              currentValue: String(currentValue ?? ""),
              proposedValue: String(value),
              label: displayLabelForUpdate(key, reg),
              confirmed: false,
            });
          }
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${params.action}` }] };
      }
    },
  };
}
