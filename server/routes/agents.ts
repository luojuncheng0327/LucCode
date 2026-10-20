/**
 * 助手管理 REST 路由
 *
 * GET    /api/agents              — 列出所有助手
 * POST   /api/agents              — 创建新助手
 * POST   /api/agents/switch       — 切换到指定助手
 * DELETE /api/agents/:id          — 删除助手
 * PUT    /api/agents/primary      — 设置主助手
 * GET    /api/agents/:id/avatar   — 获取指定助手的头像
 * POST   /api/agents/:id/avatar   — 上传指定助手的头像
 * GET    /api/agents/:id/config   — 读取指定助手的 config
 * PUT    /api/agents/:id/config   — 写入指定助手的 config
 * GET    /api/agents/:id/identity — 读取 identity.md（缺失时回落模板，附 fromTemplate）
 * PUT    /api/agents/:id/identity — 写入 identity.md（用户显式定制才落盘）
 * GET    /api/agents/:id/agents-md — 读取 AGENTS.md（缺失时回落模板，附 fromTemplate）
 * PUT    /api/agents/:id/agents-md — 写入 AGENTS.md（用户显式定制才落盘）
 * GET/PUT /api/agents/:id/public-agents-md — 读写 AGENTS.public.md
 *   （/ishiki 与 /public-ishiki 是改名前的旧段，过渡期保留为同一 handler 的别名）
 * GET    /api/agents/:id/pinned   — 读取 pinned.md
 * PUT    /api/agents/:id/pinned   — 写入 pinned.md
 * GET    /api/agents/:id/experience — 读取经验（合并）
 * PUT    /api/agents/:id/experience — 写入经验（拆分）
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import YAML from "js-yaml";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { emitAppEvent } from "../app-events.ts";
import { safeJson } from "../hono-helpers.ts";
import { bodyFromRouteError, statusFromRouteError } from "./route-errors.ts";
import { saveConfig, clearConfigCache } from "../../lib/memory/config-loader.ts";
import {
  listExperienceDocuments,
  normalizeExperienceCategory,
  syncExperienceCategories,
} from "../../lib/tools/experience.ts";
import {
  readPinnedMemoryItems,
  replacePinnedMemoryItems,
} from "../../lib/memory/pinned-memory-store.ts";
import { splitByScope, injectGlobalFields } from '../../shared/config-scope.ts';
import { validateId, agentExists } from "../utils/validation.ts";
import {
  OPTIONAL_TOOL_NAMES,
  computeSettingsAvailableToolNames,
} from "../../shared/tool-categories.ts";
import {
  buildInlineProviderCredentialUpdate,
  clearInlineProviderCredentialFields,
  hasInlineProviderCredentialPatch,
} from "./provider-credentials.ts";
import { mergeWorkspaceHistory } from "../../shared/workspace-history.ts";
import {
  collectSecretPatchPaths,
  maskObjectSecrets,
  maskSecretValue,
  resolveSecretPatch,
} from "../../shared/secret-custody.ts";
import { denySecretMutationWithoutScope, denyWithoutScope } from "../http/capability-guard.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";

function hideDisabledGlobalToolsForSettings(toolNames, engine) {
  const computerUseEnabled = engine?.getComputerUseSettings?.()?.enabled === true;
  if (computerUseEnabled) return toolNames;
  return (toolNames || []).filter((name) => name !== "computer");
}
import { assertAgentConfigPatchYuan } from "../../core/yuan-registry.ts";
import { createModuleLogger } from "../../lib/debug-log.ts";
import { assertValidAgentId } from "../../shared/agent-id.ts";
import {
  PUBLIC_PERSONA_FILE_NAME,
  resolvePersonaLocale,
  resolvePersonaSource,
} from "../../core/persona-source.ts";

const log = createModuleLogger("agents");

// ── 工具函数 ──

function agentDir(engine, id) {
  return path.join(engine.agentsDir, id);
}

/**
 * 读取 identity.md / AGENTS.md 的实际生效内容（agentDir 落盘文件优先，缺失
 * 时按 yuan + locale 回落到 lib 模板）。优先走已加载的 Agent 实例（复用
 * agent.resolveLocale()）；非焦点 agent 可能尚未加载进 engine 内存，退化为
 * 直接读 config.yaml + 全局 locale，与 core/agent-manager.ts _scanAgentList
 * 的降级路径同一条链条，绝不因为 agent 未加载而抛错或返回空串。
 */
function readAgentPersonaSource(engine, id, kind) {
  const agent = typeof engine.getAgent === "function" ? engine.getAgent(id) : null;
  if (agent) {
    return kind === "identity" ? agent.readIdentitySource() : agent.readAgentsMdSource();
  }
  const cfgPath = path.join(agentDir(engine, id), "config.yaml");
  const cfg = YAML.load(fsSync.readFileSync(cfgPath, "utf-8")) || {};
  return resolvePersonaSource({
    agentDir: agentDir(engine, id),
    productDir: engine.productDir,
    yuanType: cfg.agent?.yuan || "luc",
    locale: resolvePersonaLocale(cfg.locale, engine.getLocale?.()),
    kind,
  });
}

function hasOwn(value, key) {
  return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

function hasProviderMutationPatch(partial) {
  if (!partial || typeof partial !== "object") return false;
  if (hasOwn(partial, "providers")) return true;
  return ["api", "embedding_api", "utility_api"].some((key) => hasInlineProviderCredentialPatch(partial[key]));
}

function getGlobalValue(globalFields, key) {
  return globalFields.find((field) => field.key === key)?.value;
}

function isExperienceEnabled(engine, id) {
  const agent = typeof engine.getAgent === "function" ? engine.getAgent(id) : null;
  if (typeof agent?.experienceEnabled === "boolean") {
    return agent.experienceEnabled === true;
  }

  try {
    const cfgPath = path.join(agentDir(engine, id), "config.yaml");
    const cfg = YAML.load(fsSync.readFileSync(cfgPath, "utf-8")) || {};
    return cfg.experience?.enabled === true;
  } catch {
    return false;
  }
}

function normalizeExperienceConfigForResponse(config) {
  const current = (config.experience && typeof config.experience === "object" && !Array.isArray(config.experience))
    ? config.experience
    : {};
  config.experience = {
    ...current,
    enabled: current.enabled === true,
  };
}

const WORKSPACE_SKILL_POLICY_FIELDS = [
  "discover_project_skills",
  "discover_compatible_project_skills",
];

function hasWorkspaceSkillPolicyPatch(workspaceContext) {
  return !!workspaceContext && WORKSPACE_SKILL_POLICY_FIELDS.some((field) => hasOwn(workspaceContext, field));
}

function validateWorkspaceSkillPolicyPatch(workspaceContext) {
  if (workspaceContext === undefined) return null;
  if (!workspaceContext || typeof workspaceContext !== "object" || Array.isArray(workspaceContext)) {
    return "workspace_context must be an object";
  }
  for (const field of WORKSPACE_SKILL_POLICY_FIELDS) {
    if (hasOwn(workspaceContext, field) && typeof workspaceContext[field] !== "boolean") {
      return `workspace_context.${field} must be a boolean`;
    }
  }
  return null;
}

function emitAgentConfigAppEvents(engine, agentId, { globalFields, agentPartial, providersChanged }) {
  if (
    providersChanged
    || hasOwn(agentPartial, "api")
    || hasOwn(agentPartial, "embedding_api")
    || hasOwn(agentPartial, "utility_api")
    || hasOwn(agentPartial, "models")
  ) {
    emitAppEvent(engine, "models-changed", { agentId });
  }

  const agentPayload: Record<string, any> = { agentId };
  let agentUpdated = false;
  if (hasOwn(agentPartial?.agent, "name")) {
    agentPayload.agentName = agentPartial.agent.name;
    agentUpdated = true;
  }
  if (hasOwn(agentPartial?.agent, "yuan")) {
    agentPayload.yuan = agentPartial.agent.yuan;
    agentUpdated = true;
  }
  if (agentUpdated) {
    emitAppEvent(engine, "agent-updated", agentPayload);
  }

  if (hasOwn(agentPartial?.desk, "home_folder")) {
    emitAppEvent(engine, "agent-workspace-changed", {
      agentId,
      homeFolder: agentPartial.desk.home_folder || null,
    });
    engine.refreshFileHistoryWorkspaces?.();
  }

  if (hasOwn(agentPartial?.memory, "enabled")) {
    emitAppEvent(engine, "memory-master-changed", {
      agentId,
      enabled: agentPartial.memory.enabled !== false,
    });
  }

  const locale = getGlobalValue(globalFields, "locale");
  if (locale !== undefined) {
    emitAppEvent(engine, "locale-changed", { locale });
  }

  const editor = getGlobalValue(globalFields, "editor");
  if (editor !== undefined) {
    emitAppEvent(engine, "editor-typography-changed", {
      editor: typeof engine.getEditor === "function" ? engine.getEditor() : editor,
    });
  }

  const networkProxy = getGlobalValue(globalFields, "network_proxy");
  if (networkProxy !== undefined) {
    emitAppEvent(engine, "network-proxy-changed", {
      network_proxy: typeof engine.getNetworkProxy === "function" ? engine.getNetworkProxy() : networkProxy,
    });
  }

  const keepAwake = getGlobalValue(globalFields, "keep_awake");
  if (keepAwake !== undefined) {
    emitAppEvent(engine, "keep-awake-changed", {
      keep_awake: typeof engine.getKeepAwake === "function" ? engine.getKeepAwake() : keepAwake === true,
    });
  }

  if (hasOwn(agentPartial, "skills") || hasWorkspaceSkillPolicyPatch(agentPartial.workspace_context)) {
    emitAppEvent(engine, "skills-changed", { agentId });
  }
}

// 本地应用，API key 不做掩码，前端用 type="password" 控制显隐

export function createAgentsRoute(engine) {
  const route = new Hono();

  // ════════════════════════════
  //  列表 / 创建 / 切换 / 删除 / 主助手
  // ════════════════════════════

  route.get("/agents", async (c) => {
    try {
      await engine.gcWorkspacePersistence?.();
      const fresh = c.req.query("fresh");
      if (fresh === "1" || fresh === "true") {
        engine.invalidateAgentListCache?.();
      }
      return c.json({ agents: withEffectiveHomeFolders(engine.listAgents(), engine) });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/agents", async (c) => {
    try {
      const body = await safeJson(c);
      const { name, id, yuan } = body;
      if (!name?.trim()) {
        return c.json({ error: "name is required" }, 400);
      }
      if (id !== undefined && id !== null) assertValidAgentId(id);
      const result = await engine.createAgent({ name, id, yuan });
      emitAppEvent(engine, "agent-created", { agentId: result.id, name: result.name });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err.message }, err.statusCode || (err.message.includes("已存在") ? 409 : 500));
    }
  });

  route.post("/agents/switch", async (c) => {
    try {
      const body = await safeJson(c);
      const { id } = body;
      if (!id?.trim() || !validateId(id)) {
        return c.json({ error: "invalid id" }, 400);
      }
      const switchResult = await engine.switchAgent(id);
      const agentName = engine.getAgent(id)?.agentName || id;
      const cwd = switchResult?.cwd || engine.cwd || null;
      const sessionPath = switchResult?.sessionPath || engine.currentSessionPath || null;
      const homeFolder = switchResult?.homeFolder ?? engine.getExplicitHomeCwd?.(id) ?? null;
      const workspaceFolders = sessionPath
        ? (engine.getSessionWorkspaceFolders?.(sessionPath) || [])
        : [];
      const authorizedFolders = sessionPath
        ? (engine.getSessionAuthorizedFolders?.(sessionPath) || [])
        : [];
      const cwdHistory = cwd
        ? mergeWorkspaceHistory(engine.config?.cwd_history, [cwd])
        : mergeWorkspaceHistory(engine.config?.cwd_history, []);
      if (cwd) {
        await engine.updateConfig?.(
          { last_cwd: cwd, cwd_history: cwdHistory },
          { agentId: id },
        );
      }
      const memoryMasterEnabled = engine.getAgent(id)?.memoryMasterEnabled !== false;
      const eventPayload = {
        agentId: id,
        agentName,
        sessionPath,
        cwd,
        homeFolder,
        workspaceFolders,
        authorizedFolders,
        cwdHistory,
        memoryMasterEnabled,
      };
      emitAppEvent(engine, "agent-switched", eventPayload);
      return c.json({
        ok: true,
        agent: {
          id,
          name: agentName,
        },
        sessionPath,
        cwd,
        homeFolder,
        workspaceFolders,
        authorizedFolders,
        cwdHistory,
        memoryMasterEnabled,
      });
    } catch (err) {
      // 响应按语义分层后，服务端仍要留全量记录：故障可见不能只靠客户端那一句提示。
      // stack 首行已经含 message，取不到 stack（抛的不是 Error）才退到 message。
      log.error(`switch error: ${err?.stack || err?.message || String(err)}`);
      return c.json(bodyFromRouteError(err), statusFromRouteError(err));
    }
  });

  route.delete("/agents/:id", async (c) => {
    try {
      const id = c.req.param("id");
      if (!validateId(id)) return c.json({ error: "invalid id" }, 400);
      const result = await engine.deleteAgent(id);
      const replacementAgentId = result?.replacementAgentId || null;
      if (replacementAgentId) {
        const replacementAgent = engine.getAgent?.(replacementAgentId);
        emitAppEvent(engine, "agent-switched", {
          agentId: replacementAgentId,
          agentName: replacementAgent?.agentName || replacementAgent?.name || replacementAgentId,
          sessionPath: result?.replacementSwitchResult?.sessionPath || null,
        });
      }
      emitAppEvent(engine, "agent-deleted", { agentId: id });
      return c.json({ ok: true, replacementAgentId });
    } catch (err) {
      const code = err.message.includes("cannot delete the last agent") ? 400
        : err.message.includes("不能删除当前") ? 400
        : err.message.includes("不存在") ? 404
        : 500;
      return c.json({ error: err.message }, code);
    }
  });

  route.put("/agents/primary", async (c) => {
    try {
      const body = await safeJson(c);
      const { id } = body;
      if (id === undefined || id === null || (typeof id === "string" && !id.trim())) {
        return c.json({ error: "id is required" }, 400);
      }
      assertValidAgentId(id);
      engine.setPrimaryAgent(id);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, err.statusCode || 500);
    }
  });

  // ════════════════════════════
  //  排序
  // ════════════════════════════

  route.put("/agents/order", async (c) => {
    try {
      const body = await safeJson(c);
      const { order } = body;
      if (!Array.isArray(order)) {
        return c.json({ error: "order must be an array" }, 400);
      }

      const seen = new Set();
      for (const id of order) {
        assertValidAgentId(id);
        if (seen.has(id)) {
          return c.json({ error: `duplicate agent id: ${id}` }, 400);
        }
        seen.add(id);
        if (!engine.getAgent?.(id)) {
          return c.json({ error: `agent not found: ${id}` }, 400);
        }
      }

      engine.saveAgentOrder([...order]);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, err.statusCode || 500);
    }
  });

  // ════════════════════════════
  //  头像
  // ════════════════════════════

  route.get("/agents/:id/avatar", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const avatarPath = path.join(agentDir(engine, id), "avatars");
    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      const p = path.join(avatarPath, `agent.${ext}`);
      try {
        await fs.access(p);
        const buf = await fs.readFile(p);
        c.header("Content-Type", mimeMap[ext]);
        c.header("Cache-Control", "no-cache");
        return c.body(buf);
      } catch {}
    }
    return c.json({ error: "no avatar" }, 404);
  });

  route.post("/agents/:id/avatar", bodyLimit({ maxSize: 15 * 1024 * 1024 }), async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    const body = await safeJson(c);
    const { data } = body;
    if (!data || typeof data !== "string") {
      return c.json({ error: "data (base64) is required" }, 400);
    }
    const match = data.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
    if (!match) {
      return c.json({ error: "invalid data URL format" }, 400);
    }
    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    const buf = Buffer.from(match[2], "base64");
    const dir = path.join(agentDir(engine, id), "avatars");
    await fs.mkdir(dir, { recursive: true });
    for (const oldExt of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `agent.${oldExt}`)); } catch {}
    }
    await fs.writeFile(path.join(dir, `agent.${ext}`), buf);
    engine.invalidateAgentListCache();
    emitAppEvent(engine, "agent-updated", { agentId: id });
    return c.json({ ok: true, ext });
  });

  route.delete("/agents/:id/avatar", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    const dir = path.join(agentDir(engine, id), "avatars");
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      try { await fs.unlink(path.join(dir, `agent.${ext}`)); } catch {}
    }
    engine.invalidateAgentListCache();
    emitAppEvent(engine, "agent-updated", { agentId: id });
    return c.json({ ok: true });
  });

  // ════════════════════════════
  //  Config（config.yaml）
  // ════════════════════════════

  route.get("/agents/:id/config", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      // Drop workspace history entries whose folders are gone before answering.
      // The bare config route has always done this; doing it here too means a
      // caller gets the same config whichever door it comes through, instead of
      // depending on having hit some other route first.
      await engine.gcWorkspacePersistence?.({ agentId: id });
      const configPath = path.join(agentDir(engine, id), "config.yaml");
      // 直接解析 YAML，不走 loadConfig 全局缓存
      const config = YAML.load(await fs.readFile(configPath, "utf-8")) || {};

      normalizeExperienceConfigForResponse(config);

      // 附带 raw 结构
      config._raw = {
        api: { provider: config.api?.provider || "", base_url: config.api?.base_url || "" },
        embedding_api: { provider: config.embedding_api?.provider || "", base_url: config.embedding_api?.base_url || "" },
        utility_api: { provider: config.utility_api?.provider || "", base_url: config.utility_api?.base_url || "" },
      };

      // 自动注入全局字段（schema-driven，替代手写逐个注入）
      injectGlobalFields(config, engine);

      // 供应商列表
      try {
        const rawProviders = engine.providerRegistry.getAllProvidersRaw();
        const providerEntries = {};
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

      // Expose a stable settings tool surface. Runtime tool names are included
      // for compatibility, but optional toggles must not disappear just because
      // a non-focused agent has only loaded config and not initialized runtime
      // tools yet. Uses keyed lookup rather than the focus pointer — state
      // ownership must be uniquely determined, not derived from focus.
      const agent = engine.getAgent(id);
      const pluginTools = engine.pluginManager?.getAllTools?.() || [];
      if (!agent) {
        // agentExists(engine, id) already guarded above; reaching here means
        // engine.getAgent diverged from agentExists. That's a bug, not a missing
        // resource — log it but don't 500 the response.
        log.warn(
          `GET /agents/${id}/config: agent not found by keyed lookup despite passing agentExists check`
        );
        config.availableTools = hideDisabledGlobalToolsForSettings(
          computeSettingsAvailableToolNames([], { pluginTools }),
          engine,
        );
      } else {
        const runtimeToolNames = (agent.tools || [])
          .map((t) => t.name)
          .filter(Boolean);
        config.availableTools = hideDisabledGlobalToolsForSettings(
          computeSettingsAvailableToolNames(runtimeToolNames, { pluginTools }),
          engine,
        );
      }

      return c.json(maskObjectSecrets(config));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/config", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const partial = await safeJson(c);
      if (!partial || typeof partial !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const settingsDenied = denyWithoutScope(c, "settings.write");
      if (settingsDenied) return settingsDenied;
      if (hasProviderMutationPatch(partial)) {
        const providerDenied = denyWithoutScope(c, "providers.manage");
        if (providerDenied) return providerDenied;
      }
      const secretFields = collectSecretPatchPaths(partial, ["api_key"] as any);
      const secretDenied = denySecretMutationWithoutScope(c, secretFields);
      if (secretDenied) return secretDenied;

      // Whitelist check: tools.disabled may only contain OPTIONAL_TOOL_NAMES.
      // Blocks attempts to disable core/standard tools via hand-crafted requests.
      if (partial.tools?.disabled !== undefined) {
        if (!Array.isArray(partial.tools.disabled)) {
          return c.json({ error: "tools.disabled must be an array" }, 400);
        }
        const invalid = partial.tools.disabled.filter(
          (n) => !OPTIONAL_TOOL_NAMES.includes(n)
        );
        if (invalid.length > 0) {
          return c.json(
            {
              error: `Invalid tool names in tools.disabled: ${invalid.join(", ")}. Only optional tools can be disabled.`,
            },
            400
          );
        }
      }
      if (partial.experience?.enabled !== undefined && typeof partial.experience.enabled !== "boolean") {
        return c.json({ error: "experience.enabled must be a boolean" }, 400);
      }
      if (partial.memory?.dream?.auto_enabled !== undefined
        && typeof partial.memory.dream.auto_enabled !== "boolean") {
        return c.json({ error: "memory.dream.auto_enabled must be a boolean" }, 400);
      }
      const workspaceSkillPolicyError = validateWorkspaceSkillPolicyPatch(partial.workspace_context);
      if (workspaceSkillPolicyError) {
        return c.json({ error: workspaceSkillPolicyError }, 400);
      }

      // ── schema-driven 全局字段分流 ──
      const { global: globalFields, agent: agentPartial } = splitByScope(partial) as { global: any[], agent: Record<string, any> };
      for (const { setter, value } of globalFields) {
        engine[setter](value);
      }

      // providers 块 → 全局 added-models.yaml
      let providersChanged = false;
      if (agentPartial.providers) {
        const rawProviders = engine.providerRegistry.getAllProvidersRaw?.() || {};
        for (const [name, data] of Object.entries(agentPartial.providers)) {
          if (data === null) {
            engine.providerRegistry.removeProvider(name);
          } else {
            engine.providerRegistry.saveProvider(name, resolveSecretPatch({
              patch: data,
              existing: rawProviders[name] || {},
              secretKeys: ["api_key"] as any,
            }));
          }
        }
        delete agentPartial.providers;
        providersChanged = true;
      }

      // 内联 API 凭证 → 全局 added-models.yaml 对应条目
      for (const blockName of ["api", "embedding_api", "utility_api"]) {
        const block = agentPartial[blockName];
        if (hasInlineProviderCredentialPatch(block)) {
          const cfgPath = path.join(agentDir(engine, id), "config.yaml");
          const agentCfg = YAML.load(fsSync.readFileSync(cfgPath, "utf-8")) || {};
          const { provider: provName, update: provUpdate } = buildInlineProviderCredentialUpdate(
            block,
            agentCfg[blockName]?.provider || "",
            (provider) => engine.providerRegistry?.getAllProvidersRaw?.()?.[provider] || {},
          );
          if (!provName) {
            return c.json({ error: `${blockName}.provider is required when saving credentials` }, 400);
          }
          engine.providerRegistry.saveProvider(provName, provUpdate);
          clearInlineProviderCredentialFields(block);
          providersChanged = true;
        }
      }

      // providers 变更后确保运行时刷新
      if (providersChanged) {
        await engine.onProviderChanged();
        clearConfigCache(undefined as any);
      }

      // providers 是全局状态，变更后无论编辑的是哪个 agent，运行时都要刷新
      if (providersChanged) {
        await engine.updateConfig({});
      }

      if (Object.keys(agentPartial).length === 0) {
        emitAgentConfigAppEvents(engine, id, { globalFields, agentPartial, providersChanged });
        recordSecurityAuditEvent(c, engine, {
          action: "settings.agent.config.update",
          target: `agents.${id}.config`,
          secretFields,
          metadata: { agentId: id },
        } as any);
        return c.json({ ok: true });
      }

      // 记忆总开关：写入时间戳（用于过滤关闭期间的 session）
      if (agentPartial.memory && "enabled" in agentPartial.memory) {
        const now = new Date().toISOString();
        if (agentPartial.memory.enabled === false) {
          agentPartial.memory.disabledSince = now;
        } else {
          agentPartial.memory.reenableAt = now;
        }
      }

      assertAgentConfigPatchYuan(engine.productDir, agentPartial);

      const configPath = path.join(agentDir(engine, id), "config.yaml");
      saveConfig(configPath, agentPartial);
      engine.invalidateAgentListCache();
      // 触发目标 agent 模块刷新 + prompt 重建
      await engine.updateConfig(agentPartial, { agentId: id });
      // @ui-focus-ok: the config was already written for the agent named in the
      // path. This only asks whether that agent is the one currently loaded, so
      // its live skill list is refreshed to match; any other agent picks the new
      // policy up when it next loads. The focus decides nothing about ownership.
      if (hasWorkspaceSkillPolicyPatch(agentPartial.workspace_context) && id === engine.currentAgentId) {
        engine.syncAgentWorkspaceSkills?.(id);
      }
      // 记忆总开关：无论是否 active agent，都需要刷新运行时状态（因为 ticker 后台在跑）
      if (agentPartial.memory && "enabled" in agentPartial.memory) {
        engine.setMemoryMasterEnabled(id, agentPartial.memory.enabled !== false);
      }
      emitAgentConfigAppEvents(engine, id, { globalFields, agentPartial, providersChanged });
      recordSecurityAuditEvent(c, engine, {
        action: "settings.agent.config.update",
        target: `agents.${id}.config`,
        secretFields,
        metadata: { agentId: id },
      } as any);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, err.statusCode || 500);
    }
  });

  // ════════════════════════════
  //  Identity（identity.md）
  // ════════════════════════════

  route.get("/agents/:id/identity", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const { content, fromTemplate } = readAgentPersonaSource(engine, id, "identity");
      return c.json({ content, fromTemplate });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/identity", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      await fs.writeFile(path.join(agentDir(engine, id), "identity.md"), content, "utf-8");
      engine.invalidateAgentListCache();
      await engine.updateConfig({}, { agentId: id, refreshDescription: true });
      emitAppEvent(engine, "agent-updated", { agentId: id });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ════════════════════════════
  //  AGENTS.md
  // ════════════════════════════

  // 每个人格文件都挂两个路由段：当前段，以及改名前的旧段。旧段只是过渡期
  // 兼容——用户可能还开着改名前版本的移动端或 Bridge 客户端，它们请求的是
  // 旧路径。两个段是同一个 handler，写的是同一个新文件名，没有第二套行为。
  // 计划两个版本后移除旧段。
  const readAgentsMd = async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const { content, fromTemplate } = readAgentPersonaSource(engine, id, "agents");
      return c.json({ content, fromTemplate });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  };

  const writeAgentsMd = async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      await fs.writeFile(path.join(agentDir(engine, id), "AGENTS.md"), content, "utf-8");
      await engine.updateConfig({}, { agentId: id, refreshDescription: true });
      emitAppEvent(engine, "agent-updated", { agentId: id });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  };

  route.get("/agents/:id/agents-md", readAgentsMd);
  route.get("/agents/:id/ishiki", readAgentsMd);
  route.put("/agents/:id/agents-md", writeAgentsMd);
  route.put("/agents/:id/ishiki", writeAgentsMd);

  // ════════════════════════════
  //  AGENTS.public.md
  // ════════════════════════════

  const readPublicAgentsMd = async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const content = await fs.readFile(
        path.join(agentDir(engine, id), PUBLIC_PERSONA_FILE_NAME),
        "utf-8",
      );
      return c.json({ content });
    } catch (err) {
      if (err.code === "ENOENT") return c.json({ content: "" });
      return c.json({ error: err.message }, 500);
    }
  };

  const writePublicAgentsMd = async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      await fs.writeFile(
        path.join(agentDir(engine, id), PUBLIC_PERSONA_FILE_NAME),
        content,
        "utf-8",
      );
      await engine.updateConfig({}, { agentId: id });
      emitAppEvent(engine, "agent-updated", { agentId: id });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  };

  route.get("/agents/:id/public-agents-md", readPublicAgentsMd);
  route.get("/agents/:id/public-ishiki", readPublicAgentsMd);
  route.put("/agents/:id/public-agents-md", writePublicAgentsMd);
  route.put("/agents/:id/public-ishiki", writePublicAgentsMd);

  // ════════════════════════════
  //  Pinned（pinned.md）
  // ════════════════════════════

  route.get("/agents/:id/pinned", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const pins = readPinnedMemoryItems(agentDir(engine, id)).map(item => item.content);
      return c.json({ pins });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/pinned", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    try {
      const body = await safeJson(c);
      const { pins } = body;
      if (!Array.isArray(pins)) {
        return c.json({ error: "pins must be an array" }, 400);
      }
      replacePinnedMemoryItems(agentDir(engine, id), pins.filter(p => typeof p === "string"));
      await engine.updateConfig({}, { agentId: id });
      emitAppEvent(engine, "agent-updated", { agentId: id });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ════════════════════════════
  //  Experience（experience/ 目录）
  // ════════════════════════════

  route.get("/agents/:id/experience", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    if (!isExperienceEnabled(engine, id)) {
      return c.json({ error: "experience is paused" }, 403);
    }
    try {
      const expDir = path.join(agentDir(engine, id), "experience");
      const docs = listExperienceDocuments(expDir).sort((a, b) => a.title.localeCompare(b.title));
      if (docs.length === 0) return c.json({ content: "" });

      const blocks = [];
      for (const doc of docs) {
        blocks.push(`# ${doc.title}\n${doc.body.trimEnd()}`);
      }
      return c.json({ content: blocks.join("\n\n") + "\n" });
    } catch (err) {
      if (err.code === "ENOENT") return c.json({ content: "" });
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/agents/:id/experience", async (c) => {
    const id = c.req.param("id");
    if (!validateId(id) || !agentExists(engine, id)) {
      return c.json({ error: "agent not found" }, 404);
    }
    if (!isExperienceEnabled(engine, id)) {
      return c.json({ error: "experience is paused" }, 403);
    }
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }

      const dir = agentDir(engine, id);
      const expDir = path.join(dir, "experience");
      const indexPath = path.join(dir, "experience.md");

      // 解析合并 markdown → 按 ^# 分割成分类
      const categories = new Map();
      let currentCat = null;
      const lines = content.split("\n");

      for (const line of lines) {
        const headingMatch = line.match(/^#\s+(.+)/);
        if (headingMatch) {
          currentCat = normalizeExperienceCategory(headingMatch[1].trim());
          if (!categories.has(currentCat)) categories.set(currentCat, []);
        } else if (currentCat !== null) {
          categories.get(currentCat).push(line);
        }
      }

      syncExperienceCategories(expDir, indexPath, categories);

      await engine.updateConfig({}, { agentId: id });
      emitAppEvent(engine, "agent-updated", { agentId: id });
      return c.json({ ok: true });
    } catch (err) {
      if (err.message === "invalid experience category") {
        return c.json({ error: err.message }, 400);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}

function withEffectiveHomeFolders(agents, engine) {
  return agents.map((agent) => ({
    ...agent,
    effectiveHomeFolder: engine.getHomeCwd?.(agent.id) || agent.homeFolder || null,
  }));
}
