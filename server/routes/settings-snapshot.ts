import fs from "fs/promises";
import path from "path";
import YAML from "js-yaml";
import { Hono } from "hono";
import { injectGlobalFields } from "../../shared/config-scope.ts";
import { computeSettingsAvailableToolNames } from "../../shared/tool-categories.ts";
import { readPinnedMemoryItems } from "../../lib/memory/pinned-memory-store.ts";
import { listExperienceDocuments } from "../../lib/tools/experience.ts";
import { createAccessSummary, getLanAddresses } from "./access.ts";
import { buildBridgeStatus } from "./bridge.ts";
import { buildComputerUsePreferences } from "./preferences.ts";
import { normalizeNotificationPreferences } from "../../shared/notification-preferences.ts";
import { normalizeQuickChatPreferences } from "../../shared/quick-chat-preferences.ts";
import { normalizeBrowserPreferences } from "../../shared/browser-preferences.ts";
import { normalizeSearchApiKeys, SEARCH_API_PROVIDER_IDS } from "../../shared/search-providers.ts";
import { maskObjectSecrets, maskSecretValue } from "../../shared/secret-custody.ts";
import { listResolvedExperiments } from "../../lib/experiments/registry.ts";
import { normalizeBridgePermissionMode } from "../../core/session-permission-mode.ts";
import { agentExists, validateId } from "../utils/validation.ts";
import { readAuthPrincipal } from "../http/capability-guard.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";
import { readUserProfile } from "../../lib/user-profile-store.ts";
import {
  PUBLIC_PERSONA_FILE_NAME,
  resolvePersonaLocale,
  resolvePersonaSource,
} from "../../core/persona-source.ts";

function agentDir(engine: any, id: string) {
  return path.join(engine.agentsDir, id);
}

function hideDisabledGlobalToolsForSettings(toolNames: string[], engine: any) {
  const computerUseEnabled = engine?.getComputerUseSettings?.()?.enabled === true;
  if (computerUseEnabled) return toolNames;
  return (toolNames || []).filter((name) => name !== "computer");
}

function normalizeExperienceConfigForResponse(config: Record<string, any>) {
  const current = (config.experience && typeof config.experience === "object" && !Array.isArray(config.experience))
    ? config.experience
    : {};
  config.experience = {
    ...current,
    enabled: current.enabled === true,
  };
}

async function readTextFile(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

function readPinned(agentBaseDir: string) {
  return readPinnedMemoryItems(agentBaseDir).map(item => item.content);
}

function isExperienceEnabled(engine: any, id: string, config: Record<string, any>) {
  const agent = typeof engine.getAgent === "function" ? engine.getAgent(id) : null;
  if (typeof agent?.experienceEnabled === "boolean") return agent.experienceEnabled === true;
  return config.experience?.enabled === true;
}

function readExperience(engine: any, id: string, config: Record<string, any>) {
  if (!isExperienceEnabled(engine, id, config)) return "";
  try {
    const expDir = path.join(agentDir(engine, id), "experience");
    const docs = listExperienceDocuments(expDir).sort((a, b) => a.title.localeCompare(b.title));
    if (docs.length === 0) return "";
    return docs.map(doc => `# ${doc.title}\n${doc.body.trimEnd()}`).join("\n\n") + "\n";
  } catch (err: any) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

function maskSearchApiKeys(apiKeys: any) {
  const normalized = normalizeSearchApiKeys(apiKeys);
  return Object.fromEntries(
    SEARCH_API_PROVIDER_IDS.map(provider => [provider, maskSecretValue(normalized[provider] || "")]),
  );
}

function buildGlobalModels(engine: any) {
  const search = engine.getSearchConfig?.() || {};
  const utilityApi = engine.getUtilityApi?.() || {};
  return {
    models: engine.getSharedModels?.() || {},
    thinking_level: engine.getThinkingLevel?.() || "medium",
    search: {
      provider: search.provider || "",
      api_key: maskSecretValue(search.api_key || ""),
      api_keys: maskSearchApiKeys(search.api_keys || {}),
    },
    utility_api: {
      provider: utilityApi.provider || "",
      base_url: utilityApi.base_url || "",
      api_key: maskSecretValue(utilityApi.api_key || ""),
    },
  };
}

function addProviderSummary(config: Record<string, any>, engine: any) {
  try {
    const rawProviders = engine.providerRegistry.getAllProvidersRaw();
    const providerEntries: Record<string, any> = {};
    for (const [name, p] of Object.entries(rawProviders) as [string, any][]) {
      const entry = engine.providerRegistry.get(name);
      providerEntries[name] = {
        base_url: p.base_url || entry?.baseUrl || "",
        api: p.api || entry?.api || "",
        api_key: maskSecretValue(p.api_key || ""),
        models: p.models || [],
        model_count: (p.models || []).length,
      };
    }
    config.providers = providerEntries;
  } catch {
    config.providers = {};
  }
}

function addAvailableTools(config: Record<string, any>, engine: any, id: string) {
  const agent = engine.getAgent?.(id);
  const pluginTools = engine.pluginManager?.getAllTools?.() || [];
  const runtimeToolNames = (agent?.tools || [])
    .map((tool: any) => tool.name)
    .filter(Boolean);
  config.availableTools = hideDisabledGlobalToolsForSettings(
    computeSettingsAvailableToolNames(runtimeToolNames, { pluginTools }),
    engine,
  );
}

async function buildAgentConfig(engine: any, id: string) {
  const configPath = path.join(agentDir(engine, id), "config.yaml");
  const config = YAML.load(await fs.readFile(configPath, "utf-8")) as Record<string, any> || {};
  normalizeExperienceConfigForResponse(config);
  config._raw = {
    api: { provider: config.api?.provider || "", base_url: config.api?.base_url || "" },
    embedding_api: { provider: config.embedding_api?.provider || "", base_url: config.embedding_api?.base_url || "" },
    utility_api: { provider: config.utility_api?.provider || "", base_url: config.utility_api?.base_url || "" },
  };
  injectGlobalFields(config, engine);
  addProviderSummary(config, engine);
  addAvailableTools(config, engine, id);
  return maskObjectSecrets(config);
}

function resolveSnapshotAgentId(engine: any, rawAgentId: string | undefined) {
  // A snapshot describes one agent's settings, so the agent has to be named.
  // Without an explicit id the primary agent is the only defensible answer:
  // handing back whichever agent the server is focused on, or whichever one
  // happens to be listed first, would show the caller another agent's
  // settings under the name they asked about. Say nothing instead.
  const id = rawAgentId || engine.getPrimaryAgentId?.();
  if (!id || !validateId(id) || !agentExists(engine, id)) {
    throw new Error("settings snapshot agent not found");
  }
  return id;
}

function buildPluginSettings(engine: any, canSeeLocalPaths: boolean) {
  const pm = engine.pluginManager;
  return {
    allowFullAccess: pm?.getAllowFullAccess?.() || false,
    devToolsEnabled: engine.getPluginDevToolsEnabled?.() || false,
    userDir: canSeeLocalPaths ? (pm?.getUserPluginsDir?.() || "") : "",
    settingsTabs: pm?.getSettingsTabs?.().map((tab: any) => ({
      pluginId: tab.pluginId,
      id: tab.id,
      title: tab.title,
      icon: tab.icon,
      nativeComponent: tab.nativeComponent,
    })) || [],
  };
}

function buildBridgePreferences(engine: any) {
  const permissionMode = engine.getBridgePermissionMode?.()
    || normalizeBridgePermissionMode({ readOnly: engine.getBridgeReadOnly?.() });
  return {
    permissionMode,
    readOnly: engine.getBridgeReadOnly?.() === true,
    receiptEnabled: engine.getBridgeReceiptEnabled?.() !== false,
    richStreamingEnabled: engine.getBridgeRichStreamingEnabled?.() !== false,
  };
}

function resolveBridgeManager(ref: any) {
  if (!ref) return null;
  if (typeof ref.get === "function") return ref.get() || null;
  return ref;
}

function buildAccessSnapshot(engine: any, canSeeLocalPaths: boolean, options: Record<string, any>) {
  if (!canSeeLocalPaths || !engine?.luccodeHome) return null;
  return createAccessSummary(
    engine,
    options.runtimeState || {},
    options.listLanAddresses || getLanAddresses,
  );
}

export function createSettingsSnapshotRoute(engine: any, options: Record<string, any> = {}) {
  const route = new Hono();

  route.get("/settings/snapshot", async (c) => {
    try {
      const agentId = resolveSnapshotAgentId(engine, c.req.query("agentId"));
      const baseDir = agentDir(engine, agentId);
      const config = await buildAgentConfig(engine, agentId);
      const runtimeAgent = engine.getAgent?.(agentId);
      const snapshotAgent = runtimeAgent?.config
        ? runtimeAgent
        : { ...(runtimeAgent || {}), id: agentId, config };
      // identity.md / AGENTS.md 惰性材料化后可能没有落盘文件；快照必须反映
      // agent 此刻实际生效的内容（回落到模板，见 core/persona-source.ts），
      // 而不是空字符串。locale 优先走已加载 Agent 实例的 resolveLocale()，
      // 未加载时退化为同一条链（config.locale → 全局 prefs → "en"）。
      const configRecord = config as Record<string, any>;
      const personaLocale = runtimeAgent?.resolveLocale?.()
        ?? resolvePersonaLocale(configRecord.locale, engine.getLocale?.());
      const personaYuanType = configRecord.agent?.yuan || "luc";
      const identity = resolvePersonaSource({
        agentDir: baseDir, productDir: engine.productDir, yuanType: personaYuanType, locale: personaLocale, kind: "identity",
      }).content;
      const agents = resolvePersonaSource({
        agentDir: baseDir, productDir: engine.productDir, yuanType: personaYuanType, locale: personaLocale, kind: "agents",
      }).content;
      const publicAgents = await readTextFile(path.join(baseDir, PUBLIC_PERSONA_FILE_NAME));
      const canSeeLocalPaths = isLocalOwnerPrincipal(readAuthPrincipal(c));
      return c.json({
        agentId,
        config,
        identity,
        agents,
        publicAgents,
        userProfile: await readUserProfile(engine.userDir),
        experience: readExperience(engine, agentId, config),
        pinned: { pins: readPinned(baseDir) },
        globalModels: buildGlobalModels(engine),
        preferences: {
          quickChat: engine.getQuickChatPreferences?.() || normalizeQuickChatPreferences({}),
          browser: engine.getBrowserPreferences?.() || normalizeBrowserPreferences({}),
          notifications: engine.getNotificationPreferences?.() || normalizeNotificationPreferences({}),
          bridge: buildBridgePreferences(engine),
          computerUse: await buildComputerUsePreferences(engine, {
            platform: options.platform || process.platform,
          }),
          imageGeneration: engine.media?.getImageConfig?.() || engine.preferences?.getImageGenerationConfig?.() || {},
          speechRecognition: engine.speechRecognition?.getConfig?.() || engine.getSpeechRecognitionConfig?.() || { enabled: false },
          experiments: listResolvedExperiments(engine.preferences),
        },
        access: buildAccessSnapshot(engine, canSeeLocalPaths, options),
        bridgeStatus: snapshotAgent
          ? buildBridgeStatus(engine, resolveBridgeManager(options.bridgeManagerRef), snapshotAgent)
          : null,
        plugins: buildPluginSettings(engine, canSeeLocalPaths),
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
