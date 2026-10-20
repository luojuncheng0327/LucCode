/**
 * 配置管理 REST 路由
 */
import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import { emitAppEvent } from "../app-events.ts";
import { safeJson } from "../hono-helpers.ts";
import { t } from "../../lib/i18n.ts";
import { debugLog } from "../../lib/debug-log.ts";
import { clearConfigCache } from "../../lib/memory/config-loader.ts";
import { FactStore } from "../../lib/memory/fact-store.ts";
import {
  clearCompiledMemoryArtifacts,
  clearCompiledSummarySources,
  writeCompiledResetMarker,
} from "../../lib/memory/compiled-memory-state.ts";
import {
  buildCompiledMemoryMarkdown,
  listWeekDayEntries,
  migrateLegacyEditableFacts,
  readCompiledMemorySections,
  writeEditableFactsSection,
  writeLongtermSection,
  writeTodaySection,
  writeWeekDayEntry,
} from "../../lib/memory/compile.ts";
import {
  ensureDefaultWorkspace,
  resolveDefaultWorkspacePath,
} from "../../shared/default-workspace.ts";
import { splitByScope, injectGlobalFields } from '../../shared/config-scope.ts';
import {
  clearWorkspaceHistory,
  mergeWorkspaceHistory,
  normalizeWorkspacePath,
  removeWorkspaceHistoryEntries,
} from "../../shared/workspace-history.ts";
import {
  collectProviderHeaderSecretPatchPathsFromConfig,
  maskProviderHeaders,
  resolveProviderHeadersPatch,
} from "../../shared/provider-auth.ts";
import { isSearchApiProvider, normalizeSearchApiKeys } from "../../shared/search-providers.ts";
import { resolveAgentStrict, AgentNotFoundError } from "../utils/resolve-agent.ts";
import { hasInlineProviderCredentialPatch } from "./provider-credentials.ts";
import {
  collectSecretPatchPaths,
  isMaskedSecretValue,
  maskObjectSecrets,
  maskSecretValue,
  resolveSecretPatch,
} from "../../shared/secret-custody.ts";
import { denySecretMutationWithoutScope, denyWithoutScope } from "../http/capability-guard.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";
import { readUserProfile, writeUserProfile } from "../../lib/user-profile-store.ts";

function hasOwn(value: any, key: string) {
  return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

function hasProviderMutationPatch(partial: any) {
  if (!partial || typeof partial !== "object") return false;
  if (hasOwn(partial, "providers")) return true;
  return ["api", "embedding_api", "utility_api"].some((key) => hasInlineProviderCredentialPatch(partial[key]));
}

function getGlobalValue(globalFields: any[], key: string) {
  return globalFields.find((field) => field.key === key)?.value;
}

function emitConfigAppEvents(engine: any, { globalFields, providersChanged }: any) {
  if (providersChanged) {
    // 供应商目录是全局的，改一次每个 agent 的模型列表都会跟着变，没有"属于
    // 哪个 agent"可言，所以这里不填 agent 身份，而不是随手填上此刻聚焦的那个。
    emitAppEvent(engine, "models-changed", { agentId: null });
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
}

function latestIso(values: any[]) {
  let latest = null;
  let latestTime = -Infinity;
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    const time = Date.parse(value);
    if (Number.isNaN(time)) continue;
    if (time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}

function normalizeMemoryStepHealth(step: any) {
  const failCount = Number(step?.failCount);
  return {
    lastSuccessAt: typeof step?.lastSuccessAt === "string" ? step.lastSuccessAt : null,
    lastErrorAt: typeof step?.lastErrorAt === "string" ? step.lastErrorAt : null,
    lastErrorMsg: step?.lastErrorMsg ? String(step.lastErrorMsg) : null,
    failCount: Number.isFinite(failCount) && failCount > 0 ? failCount : 0,
  };
}

function buildMemoryHealth(agent: any) {
  const base = {
    enabled: agent.memoryMasterEnabled !== false,
    reason: null,
    steps: {},
    failedSteps: [],
    maxFailCount: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
  };

  if (agent.memoryMasterEnabled === false) {
    return {
      ...base,
      status: "disabled",
      reason: "memory_disabled",
      enabled: false,
    };
  }

  if (!agent.memoryTicker || typeof agent.memoryTicker.getHealthStatus !== "function") {
    return {
      ...base,
      status: "unavailable",
      reason: "memory_ticker_unavailable",
    };
  }

  const rawSteps = agent.memoryTicker.getHealthStatus();
  const steps: Record<string, any> = {};
  for (const [key, value] of Object.entries(rawSteps || {})) {
    steps[key] = normalizeMemoryStepHealth(value);
  }

  const stepEntries = Object.entries(steps);
  const failedSteps = stepEntries
    .filter(([, step]) => step.failCount > 0 || !!step.lastErrorMsg || !!step.lastErrorAt)
    .map(([key]) => key);
  const maxFailCount = stepEntries.reduce((max, [, step]) => Math.max(max, step.failCount), 0);
  const status = failedSteps.length === 0 ? "healthy" : (maxFailCount >= 3 ? "unhealthy" : "degraded");

  return {
    ...base,
    status,
    steps,
    failedSteps,
    maxFailCount,
    lastSuccessAt: latestIso(stepEntries.map(([, step]) => step.lastSuccessAt)),
    lastErrorAt: latestIso(stepEntries.map(([, step]) => step.lastErrorAt)),
  };
}

export function createConfigRoute(engine: any) {
  const route = new Hono();

  // 读取全局设置：跨 agent 共享的偏好 + 供应商目录（脱敏：隐藏 API key）。
  //
  // 这条路径不带 agent 身份，所以答不了"哪个 agent 的配置"——某个 agent 自己的
  // 字段（名字、书桌目录、记忆开关、api 区块等）一律走 GET /api/agents/:id/config。
  route.get("/config", async (c) => {
    try {
      const config: Record<string, any> = {};

      // 供应商列表（附带 model_count）
      const rawProviders = engine.providerRegistry.getAllProvidersRaw();
      const providerEntries: Record<string, any> = {};
      for (const [name, p] of Object.entries(rawProviders) as [string, any][]) {
        const entry = engine.providerRegistry.get(name);
        providerEntries[name] = {
          base_url: p.base_url || entry?.baseUrl || "",
          api: p.api || entry?.api || "",
          api_key: maskSecretValue(p.api_key || ""),
          headers: maskProviderHeaders(p.headers || {}),
          models: p.models || [],
          model_count: (p.models || []).length,
        };
      }
      config.providers = providerEntries;

      // 自动注入全局字段（schema-driven）
      injectGlobalFields(config, engine);
      return c.json(maskObjectSecrets(config));
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 最近工作区（cwd_history）──
  //
  // 最近工作区列表写在某个 agent 自己的 config.yaml 里，所以这三条路由都要求
  // 显式 agentId：读的是那个 agent 的历史，写的也是那个 agent 的历史，全程不碰
  // 服务端此刻聚焦在谁身上。少了 agentId 就直接报错，不替调用方挑一个。

  route.post("/config/workspaces/recent", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      const body = await safeJson(c);
      const folder = normalizeWorkspacePath(body?.path);
      if (!folder) return c.json({ error: "path must be a non-empty string" }, 400);
      const stat = await fs.stat(folder).catch(() => null);
      if (!stat?.isDirectory()) return c.json({ error: "path must be an existing directory" }, 400);
      const cwdHistory = mergeWorkspaceHistory(agent.config?.cwd_history, [folder]);
      await engine.updateConfig({ cwd_history: cwdHistory }, { agentId: agent.id });
      return c.json({ ok: true, cwd_history: cwdHistory });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  route.delete("/config/workspaces/recent", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      const body = await safeJson(c).catch(() => ({}));
      const folder = normalizeWorkspacePath(body?.path);
      if (!folder) return c.json({ error: "path must be a non-empty string" }, 400);
      const cwdHistory = removeWorkspaceHistoryEntries(agent.config?.cwd_history, [folder]);
      await engine.updateConfig({ cwd_history: cwdHistory }, { agentId: agent.id });
      return c.json({ ok: true, cwd_history: cwdHistory });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  route.delete("/config/workspaces/recent/all", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      const cwdHistory = clearWorkspaceHistory();
      await engine.updateConfig({ cwd_history: cwdHistory }, { agentId: agent.id });
      return c.json({ ok: true, cwd_history: cwdHistory });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  // 默认工作区是一台机器上的一个固定目录（用户主目录下的桌面文件夹），
  // 跟 agent 无关：换 agent 不会换出另一个默认工作区。所以这两条路由没有
  // agentId 参数，也不该被要求加上。
  route.get("/config/default-workspace", async (c) => {
    return c.json({ path: resolveDefaultWorkspacePath() });
  });

  route.post("/config/default-workspace", async (c) => {
    try {
      return c.json({ ok: true, path: ensureDefaultWorkspace() });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 更新全局设置：跨 agent 共享的偏好 + 供应商目录。
  //
  // 收到某个 agent 自己的字段一律 400 退回并指路 per-agent 路由——这条路径不带
  // agent 身份，写下去只会落到"服务端此刻碰巧聚焦的那个 agent"，桌面和手机各开
  // 一个 agent 时就会写错人。校验放在任何写动作之前：宁可整条请求退回，也不要
  // 出现"全局的存了、agent 的丢了"这种一半成功。
  route.put("/config", async (c) => {
    try {
      const partial = await safeJson(c);
      if (!partial || typeof partial !== "object") {
        return c.json({ error: t("error.invalidJson") }, 400);
      }
      const settingsDenied = denyWithoutScope(c, "settings.write");
      if (settingsDenied) return settingsDenied;
      if (hasProviderMutationPatch(partial)) {
        const providerDenied = denyWithoutScope(c, "providers.manage");
        if (providerDenied) return providerDenied;
      }
      const secretFields = [
        ...collectSecretPatchPaths(partial, ["api_key"] as any),
        ...collectProviderHeaderSecretPatchPathsFromConfig(partial),
      ];
      const secretDenied = denySecretMutationWithoutScope(c, secretFields);
      if (secretDenied) return secretDenied;
      // ── schema-driven 全局字段分流 ──
      const { global: globalFields, agent: agentPartial } = splitByScope(partial) as { global: any[], agent: Record<string, any> };

      const agentOwnedKeys = Object.keys(agentPartial).filter((key) => key !== "providers");
      if (agentOwnedKeys.length > 0) {
        return c.json({
          error: `${agentOwnedKeys.join(", ")} belong to a specific agent; `
            + "send them to PUT /api/agents/{agentId}/config instead",
        }, 400);
      }

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
            const resolvedPatch = resolveSecretPatch({
              patch: data,
              existing: rawProviders[name] || {},
              secretKeys: ["api_key"] as any,
            });
            if (hasOwn(data as any, "headers")) {
              (resolvedPatch as any).headers = resolveProviderHeadersPatch({
                patch: (data as any).headers,
                existing: rawProviders[name]?.headers || {},
              } as any);
            }
            engine.providerRegistry.saveProvider(name, resolvedPatch);
          }
        }
        delete agentPartial.providers;
        providersChanged = true;
      }

      // providers 变更后确保运行时刷新
      if (providersChanged) {
        await engine.onProviderChanged();
        debugLog()?.log("api", `onProviderChanged OK after provider change (${engine.availableModels?.length ?? 0} models)`);
        clearConfigCache(undefined as any);
        await engine.updateConfig({});
      }

      emitConfigAppEvents(engine, { globalFields, providersChanged });
      recordSecurityAuditEvent(c, engine, {
        action: "settings.config.update",
        target: "config",
        secretFields,
      } as any);
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.error("api", `PUT /api/config failed: ${err.message}`);
      return c.json({ error: err.message }, err.statusCode || 500);
    }
  });

  // ── 用户档案（user.md）──
  //
  // user.md 属于使用者本人，不属于任何一个 agent：它存在 engine.userDir，所有
  // agent 共用同一份。所以这两条路由没有 agentId 参数，也不该被要求加上——
  // 这里没有"归属哪个 agent"的问题需要回答。

  // 读取 user.md 内容
  route.get("/user-profile", async (c) => {
    try {
      const content = await readUserProfile(engine.userDir);
      return c.json({ content });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 保存 user.md 内容，并触发 system prompt 重建
  route.put("/user-profile", async (c) => {
    try {
      const body = await safeJson(c);
      const { content } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a string" }, 400);
      }
      await writeUserProfile(engine.userDir, content);
      debugLog()?.log("api", `PUT /api/user-profile (saved, ${content.length} chars)`);
      await engine.updateConfig({});
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.error("api", `PUT /api/user-profile failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 记忆管理 ──

  /**
   * 获取指定 agent 的 FactStore。
   * 如果 agentId 就是当前 active agent，直接用 engine.factStore；
   * 否则临时打开那个 agent 的 facts.db。
   * 返回 { store, isTemp }，调用方用完 isTemp===true 的 store 需要 close。
   */
  function getStoreForAgent(agentId: string) {
    if (!agentId) throw new Error("agentId is required");
    const resolvedId = agentId;
    const agent = engine.getAgent(resolvedId);
    if (agent?.factStore) {
      return { store: agent.factStore, isTemp: false };
    }
    if (/[\/\\.]/.test(resolvedId)) throw new Error("Invalid agent ID");
    const dbPath = path.join(engine.agentsDir, resolvedId, "memory", "facts.db");
    try {
      const store = new FactStore(dbPath);
      return { store, isTemp: true };
    } catch (err) {
      throw new Error(`Cannot open fact DB for agent "${resolvedId}": ${err.message}`);
    }
  }

  // 获取记忆后台整理健康状态。显式 agentId 是状态归属边界。
  route.get("/memories/health", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      return c.json({
        agentId: agent.id,
        ...buildMemoryHealth(agent),
      });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  // 获取所有元事实
  route.get("/memories", async (c) => {
    let tempStore = null;
    try {
      const { store, isTemp } = getStoreForAgent(c.req.query("agentId"));
      if (isTemp) tempStore = store;
      return c.json({ memories: store.exportAll() });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // 读取编译后的 memory.md。显式 agentId 是状态归属边界。
  route.get("/memories/compiled", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      const memDir = path.dirname(agent.memoryMdPath);
      // 幂等：即使该 agent 从未跑起过 memoryTicker（未配置记忆模型），
      // 首次读取也会把遗留的 editable-facts.md 并入规范的 facts.md。
      migrateLegacyEditableFacts(memDir);
      const sections = readCompiledMemorySections(memDir, {
        summaryManager: agent.summaryManager,
      });
      const content = buildCompiledMemoryMarkdown(sections);
      // editableFactsEnabled 转正后恒为 true：facts 编辑能力不再受实验开关限制，
      // 字段保留是为了不破坏前端既有契约（CompiledMemoryViewer 仍读取此字段）。
      return c.json({ content, editableFactsEnabled: true, sections });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/memories/compiled/facts", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      const body = await safeJson(c);
      if (typeof body?.facts !== "string") {
        return c.json({ error: "facts must be a string" }, 400);
      }
      const memDir = path.dirname(agent.memoryMdPath);
      migrateLegacyEditableFacts(memDir);
      const normalizedFacts = writeEditableFactsSection(memDir, body.facts, {
        summaryManager: agent.summaryManager,
        memoryMdPath: agent.memoryMdPath,
      });
      debugLog()?.log("api", `PUT /api/memories/compiled/facts agent=${agent.id}`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true, facts: normalizedFacts });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/memories/compiled/today", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      const body = await safeJson(c);
      if (typeof body?.today !== "string") {
        return c.json({ error: "today must be a string" }, 400);
      }
      const memDir = path.dirname(agent.memoryMdPath);
      const normalizedToday = writeTodaySection(memDir, body.today, {
        memoryMdPath: agent.memoryMdPath,
      });
      debugLog()?.log("api", `PUT /api/memories/compiled/today agent=${agent.id}`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true, today: normalizedToday });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/memories/compiled/longterm", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      const body = await safeJson(c);
      if (typeof body?.longterm !== "string") {
        return c.json({ error: "longterm must be a string" }, 400);
      }
      const memDir = path.dirname(agent.memoryMdPath);
      const normalizedLongterm = writeLongtermSection(memDir, body.longterm, {
        memoryMdPath: agent.memoryMdPath,
      });
      debugLog()?.log("api", `PUT /api/memories/compiled/longterm agent=${agent.id}`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true, longterm: normalizedLongterm });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  // 读取按天的 week 日记条目，供编辑 UI 按天分行展示。显式 agentId 是状态归属边界。
  route.get("/memories/compiled/week/days", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      const memDir = path.dirname(agent.memoryMdPath);
      const days = listWeekDayEntries(memDir);
      return c.json({ days });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  // 改写某一天的日记正文，重新装配 week.md 并同步 memory.md；只能改写已存在的日期
  route.put("/memories/compiled/week/days/:date", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const agent = resolveAgentStrict(engine, c);
      const date = c.req.param("date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
        return c.json({ error: "date must be YYYY-MM-DD" }, 400);
      }
      const body = await safeJson(c);
      if (typeof body?.body !== "string") {
        return c.json({ error: "body must be a string" }, 400);
      }
      const memDir = path.dirname(agent.memoryMdPath);
      const existingDates = new Set(listWeekDayEntries(memDir).map((entry) => entry.date));
      if (!existingDates.has(date)) {
        return c.json({ error: `no daily entry for date "${date}"` }, 404);
      }
      const normalizedBody = writeWeekDayEntry(memDir, date, body.body, {
        memoryMdPath: agent.memoryMdPath,
      });
      debugLog()?.log("api", `PUT /api/memories/compiled/week/days/${date} agent=${agent.id}`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true, date, body: normalizedBody });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  // 清除编译产物（today/week/longterm/facts/memory.md + fingerprints）
  route.delete("/memories/compiled", async (c) => {
    try {
      const agent = resolveAgentStrict(engine, c);
      const memDir = path.dirname(agent.memoryMdPath);
      writeCompiledResetMarker(memDir);
      clearCompiledMemoryArtifacts(memDir);
      clearCompiledSummarySources(agent.summariesDir, agent.summaryManager);
      debugLog()?.log("api", `DELETE /api/memories/compiled agent=${agent.id}`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    }
  });

  // 清除所有记忆（facts.db + memory.md）
  route.delete("/memories", async (c) => {
    let tempStore = null;
    try {
      const agent = resolveAgentStrict(engine, c);
      const { store, isTemp } = getStoreForAgent(agent.id);
      if (isTemp) tempStore = store;
      const memDir = path.dirname(agent.memoryMdPath);
      writeCompiledResetMarker(memDir);
      store.clearAll();
      clearCompiledMemoryArtifacts(memDir);
      clearCompiledSummarySources(agent.summariesDir, agent.summaryManager);
      debugLog()?.log("api", `DELETE /api/memories agent=${agent.id}`);
      await engine.updateConfig({}, { agentId: agent.id });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // 导出记忆（JSON）
  route.get("/memories/export", async (c) => {
    let tempStore = null;
    try {
      const { store, isTemp } = getStoreForAgent(c.req.query("agentId"));
      if (isTemp) tempStore = store;
      return c.json({
        version: 2,
        exportedAt: new Date().toISOString(),
        facts: store.exportAll(),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // 导入记忆（直接写入，无需 embedding）
  route.post("/memories/import", async (c) => {
    let tempStore = null;
    try {
      const body = await safeJson(c);
      const { facts, memories } = body;
      // 兼容 v1 导出格式（memories 字段）和 v2 格式（facts 字段）
      const entries = facts || memories;
      if (!Array.isArray(entries) || entries.length === 0) {
        return c.json({ error: "facts must be a non-empty array" }, 400);
      }

      const importEntries = entries.map((e) => ({
        fact: e.fact || e.content || "",
        tags: e.tags || [],
        time: e.time || e.date || null,
        session_id: e.session_id || "imported",
      }));

      const { store, isTemp } = getStoreForAgent(c.req.query("agentId"));
      if (isTemp) tempStore = store;
      store.importAll(importEntries);
      debugLog()?.log("api", `POST /api/memories/import: ${importEntries.length} entries`);
      return c.json({ ok: true, imported: importEntries.length });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    } finally {
      tempStore?.close();
    }
  });

  // ── 搜索 API Key 验证 ──

  route.post("/search/verify", async (c) => {
    const body = await safeJson(c);
    const { provider } = body;
    const selectedProvider = body.search_provider || provider;
    if (!provider) {
      return c.json({ ok: false, error: "provider is required" }, 400);
    }
    const existingSearch = engine.getSearchConfig?.() || {};
    const api_key = isMaskedSecretValue(body.api_key)
      ? existingSearch.api_keys?.[provider] || existingSearch.api_key || ""
      : body.api_key || "";
    try {
      const { searchProviderRequiresApiKey, verifySearchKey } = await import("../../lib/tools/web-search.ts");
      if (searchProviderRequiresApiKey(provider) && !api_key) {
        return c.json({ ok: false, error: "api_key is required" }, 400);
      }
      await verifySearchKey(provider, api_key);
      const storedApiKey = searchProviderRequiresApiKey(provider) ? api_key : "";
      const apiKeys = normalizeSearchApiKeys(existingSearch.api_keys || {});
      if (isSearchApiProvider(provider)) apiKeys[provider] = storedApiKey;
      const selectedApiKey = isSearchApiProvider(selectedProvider) ? apiKeys[selectedProvider] || "" : "";
      engine.setSearchConfig({ provider: selectedProvider, api_key: selectedApiKey, api_keys: apiKeys });
      await engine.updateConfig({ search: { provider: selectedProvider, api_key: selectedApiKey, api_keys: apiKeys } });
      debugLog()?.log("api", `POST /api/search/verify provider=${provider} selected=${selectedProvider} (ok)`);
      return c.json({ ok: true });
    } catch (err) {
      debugLog()?.warn("api", `POST /api/search/verify provider=${provider} failed: ${err.message}`);
      return c.json({ ok: false, error: err.message });
    }
  });

  return route;
}
