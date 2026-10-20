/**
 * desk.js — Desk 系统 REST API
 *
 * 提供 cron 任务、工作台文件的 HTTP 接口。
 * 前端通过这些接口直接操作（不经过 agent/LLM），
 * agent 通过 tool 操作（走 WebSocket 推送更新）。
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { parseSkillMetadata } from "../../lib/skills/skill-metadata.ts";
import { installSkillPackageFromPath } from "../../lib/skills/skill-package-installer.ts";
import { createSkillSourceIdentity } from "../../lib/skills/skill-file-identity.ts";
import {
  resolveWorkspaceSkillCatalogPaths,
  resolveWorkspaceSkillCandidateStates,
  workspaceSkillPolicyFromConfig,
} from "../../shared/workspace-skill-paths.ts";
import { DEFAULT_DISABLED_TOOL_NAMES } from "../../shared/tool-categories.ts";
import { applyMarkdownCoverFromGeneratedFile } from "../../plugins/beautify/lib/markdown-cover-service.ts";
import { resolveCoverGalleryPresetImagePath } from "../../plugins/beautify/lib/cover-gallery-assets.ts";
import { buildCoverStyleGuideForAgent } from "../../plugins/beautify/lib/cover-style-guide.ts";
import { DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS, activityTimeoutPatch } from "../../lib/desk/activity-store.ts";
import { t } from "../../lib/i18n.ts";
import { realPath, isSensitivePath } from "../utils/path-security.ts";
import { readAuthPrincipal } from "../http/capability-guard.ts";
import { jsonRouteError } from "../http/route-errors.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";
import { createRequestContext } from "../http/boundary.ts";
import { createApiResourceOperationContext, requestIdFromHono } from "../http/resource-operation-context.ts";
import { MountAwareFileError, MountAwareFileService } from "../../core/mount-aware-file-service.ts";
import { materializeUploadedSkillPackage } from "../utils/uploaded-skill-package.ts";
import { requireAutomationExecutionContext } from "../../lib/desk/automation-execution-context.ts";

/** 安全路径校验：target 必须在 baseDir 内部（解析 symlink 后比较） */
function isInsidePath(target, baseDir) {
  const base = realPath(baseDir);
  if (!base) return false;
  const resolved = realPath(target);
  if (resolved) return resolved === base || resolved.startsWith(base + path.sep);
  // 路径不存在（mkdir / rename 目标）：解析父目录 + 保留 basename
  const parentResolved = realPath(path.dirname(target));
  if (!parentResolved) return false;
  const full = path.join(parentResolved, path.basename(target));
  return full === base || full.startsWith(base + path.sep);
}

function isInsideAnyRoot(dir, roots) {
  const resolved = realPath(dir);
  if (!resolved) return false;
  return roots.filter(Boolean).some(root => {
    const r = realPath(root);
    if (!r) return false;
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

function selectedAgentDeskRoots(engine, agentId) {
  if (!agentId || typeof agentId !== "string") return [];
  return [
    typeof engine.getExplicitHomeCwd === "function" ? engine.getExplicitHomeCwd(agentId) : null,
    typeof engine.getHomeCwd === "function" ? engine.getHomeCwd(agentId) : null,
  ].filter(Boolean);
}

/** 校验 dir 覆盖：仅允许 engine 已知的根目录（解析 symlink 后比较） */
function isApprovedDir(dir, engine, { agentId = null } = {}) {
  if (isInsideAnyRoot(dir, selectedAgentDeskRoots(engine, agentId))) {
    return true;
  }
  if (typeof engine.isApprovedDeskDir === "function") {
    return engine.isApprovedDeskDir(dir, { agentId });
  }
  const approved = [
    engine.deskCwd,
    engine.homeCwd,
    ...(Array.isArray(engine.config?.cwd_history) ? engine.config.cwd_history : []),
  ].filter(Boolean);
  if (typeof engine.isApprovedWorkspaceDir === "function" && engine.isApprovedWorkspaceDir(dir, { agentId })) {
    return true;
  }
  return isInsideAnyRoot(dir, approved);
}

function defaultDeskDir(engine) {
  return engine.defaultDeskCwd || engine.homeCwd || engine.deskCwd;
}

function isPlainEntryName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\");
}

function normalizeMountId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function deskRouteError(c, code, message, status) {
  return jsonRouteError(c, { code, message, status });
}

const SAFE_CRON_STORE_ERRORS = Object.freeze({
  cron_store_corrupt: Object.freeze({ message: "automation task storage is corrupt", status: 500 }),
  cron_store_unavailable: Object.freeze({ message: "automation task storage is unavailable", status: 500 }),
  cron_store_recovery_failed: Object.freeze({ message: "automation task recovery failed", status: 500 }),
  cron_store_reentrant_write: Object.freeze({ message: "cron store does not allow reentrant writes", status: 409 }),
  cron_store_async_mutator_forbidden: Object.freeze({ message: "cron store mutator must be synchronous", status: 409 }),
});

function isSafeCronStoreError(err) {
  if (!err || typeof err !== "object" || typeof err.code !== "string") return false;
  const expected = SAFE_CRON_STORE_ERRORS[err.code];
  return !!expected && err.message === expected.message && err.status === expected.status;
}

function cronStoreRouteFailure(c, err) {
  if (isSafeCronStoreError(err)) {
    return deskRouteError(c, err.code, err.message, err.status);
  }
  return deskRouteError(
    c,
    "cron_store_operation_failed",
    "Unable to access automation tasks",
    500,
  );
}

function deskFileActionErrorMessage(err) {
  if (err?.code === "resource_not_found") return "not found";
  if (err?.code === "target_already_exists") return "target already exists";
  if (err?.code === "already_exists") return "already exists";
  return err?.message || err?.code || "file action failed";
}

function getStudioCronStore(engine, studioId = null) {
  const service = engine.getStudioCronStore?.() || null;
  if (!service || !studioId || typeof service.forStudio !== "function") return null;
  return service.forStudio(studioId);
}

function normalizeRouteExecutionContext(value, actorAgentId, engine) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value;
  if (
    (typeof input.sourceBridgeSessionKey === "string" && input.sourceBridgeSessionKey.trim())
    || input.notificationContext != null
  ) {
    throw new Error("executionContext Bridge identity and notification context are host-managed");
  }
  const inputSessionId = typeof input.sourceSessionId === "string" && input.sourceSessionId.trim()
    ? input.sourceSessionId.trim()
    : null;
  const inputSessionPath = typeof input.sourceSessionPath === "string" && input.sourceSessionPath.trim()
    ? input.sourceSessionPath
    : null;
  const sourceSessionId = inputSessionId
    || (inputSessionPath ? engine.getSessionIdForPath?.(inputSessionPath) || null : null);
  if (inputSessionPath && !sourceSessionId) {
    throw new Error("executionContext source session path has no stable identity");
  }
  if (sourceSessionId) {
    const manifest = engine.getSessionManifest?.(sourceSessionId) || null;
    if (
      !manifest
      || manifest.lifecycle === "deleted"
      || manifest.health !== "ok"
      || !manifest.currentLocator?.path
    ) {
      throw new Error("executionContext source session is unavailable");
    }
    if (manifest.ownerAgentId !== actorAgentId) {
      throw new Error("executionContext source session does not belong to actorAgentId");
    }
    const currentPath = manifest.currentLocator.path;
    const reverseSessionId = engine.getSessionIdForPath?.(currentPath) || null;
    if (reverseSessionId !== sourceSessionId) {
      throw new Error("executionContext source session identity is inconsistent");
    }
    const folderScope = engine.getSessionFolderScope?.(currentPath) || null;
    return requireAutomationExecutionContext({
      kind: typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : "session_workspace",
      sourceSessionId,
      sourceBridgeSessionKey: null,
      sourceSessionPath: currentPath,
      cwd: folderScope?.cwd ?? null,
      workspaceFolders: Array.isArray(folderScope?.workspaceFolders) ? folderScope.workspaceFolders : [],
      authorizedFolders: Array.isArray(folderScope?.authorizedFolders) ? folderScope.authorizedFolders : [],
      createdByAgentId: actorAgentId,
      notificationContext: null,
    }, actorAgentId);
  }
  const actorHome = typeof engine.getHomeCwd === "function"
    ? engine.getHomeCwd(actorAgentId)
    : null;
  return requireAutomationExecutionContext({
    kind: typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : "session_workspace",
    sourceSessionId: null,
    sourceBridgeSessionKey: null,
    sourceSessionPath: null,
    cwd: actorHome || null,
    workspaceFolders: actorHome ? [actorHome] : [],
    authorizedFolders: [],
    createdByAgentId: actorAgentId,
    notificationContext: null,
  }, actorAgentId);
}

function normalizeRouteCreatedBy(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.kind === "string") {
    return JSON.parse(JSON.stringify(value));
  }
  return { kind: "user" };
}

function normalizeRouteEverySchedule(schedule) {
  if (typeof schedule === "number") {
    if (!Number.isFinite(schedule) || schedule < 60_000) {
      throw new Error("every schedule must be at least 60000 milliseconds");
    }
    return schedule;
  }
  const minutes = parseInt(schedule, 10);
  if (isNaN(minutes) || minutes <= 0) {
    throw new Error("every schedule must be a positive number (minutes)");
  }
  return minutes * 60_000;
}

function normalizeRouteExecutor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.kind !== "string") {
    return null;
  }
  const authorityFields = [
    "permissionMode",
    "approvalPolicy",
    "allowHumanApproval",
    "authorization",
    "requestedGrants",
  ];
  const injectedField = authorityFields.find((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (injectedField) {
    throw new Error(`executor field is host-managed: ${injectedField}`);
  }
  const normalized = { kind: value.kind.trim() };
  for (const key of ["agentId", "prompt", "model", "executionContext", "migratedFrom"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      normalized[key] = JSON.parse(JSON.stringify(value[key]));
    }
  }
  return normalized;
}

function validateRouteExecutor(executor) {
  if (!executor) return null;
  if (executor.kind === "agent_session") return null;
  return `unsupported automation executor: ${executor.kind}`;
}

const AUTOMATION_SUGGESTION_EDITABLE_FIELDS = new Set([
  "type",
  "schedule",
  "label",
  "prompt",
  "model",
  "targetAgentId",
]);

function normalizeSuggestionEdits(value, engine) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("automation suggestion jobData must be an object"), {
      code: "automation_suggestion_invalid",
      status: 400,
    });
  }
  const forbidden = Object.keys(value).filter((key) => !AUTOMATION_SUGGESTION_EDITABLE_FIELDS.has(key));
  if (forbidden.length > 0) {
    throw Object.assign(new Error(`automation suggestion field is host-managed: ${forbidden[0]}`), {
      code: "automation_suggestion_authority_field_forbidden",
      status: 400,
    });
  }
  const edits: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(value, "type")) {
    if (!new Set(["at", "every", "cron"]).has(value.type)) {
      throw new Error(`Invalid scheduleType: ${value.type}. Must be at/every/cron.`);
    }
    edits.type = value.type;
  }
  if (Object.prototype.hasOwnProperty.call(value, "schedule")) edits.schedule = value.schedule;
  for (const key of ["label", "prompt"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (typeof value[key] !== "string") throw new Error(`${key} must be a string`);
    edits[key] = value[key];
  }
  if (Object.prototype.hasOwnProperty.call(value, "model")) {
    edits.model = JSON.parse(JSON.stringify(value.model));
  }
  if (Object.prototype.hasOwnProperty.call(value, "targetAgentId")) {
    const targetAgentId = typeof value.targetAgentId === "string" ? value.targetAgentId.trim() : "";
    if (!targetAgentId) throw new Error("targetAgentId must be a non-empty string");
    if (
      typeof engine.getAgent !== "function"
      || !engine.getAgent(targetAgentId)
      || engine.isAgentDeleted?.(targetAgentId) === true
    ) {
      throw Object.assign(new Error(`agent not found: ${targetAgentId}`), {
        code: "automation_suggestion_target_agent_not_found",
        status: 404,
      });
    }
    edits.targetAgentId = targetAgentId;
  }
  return edits;
}

const WORKSPACE_SEARCH_LIMIT = 80;
const BEAUTIFY_OPTIONAL_TOOL_NAME = "beautify";
const MAX_COVER_UPLOAD_BYTES = 25 * 1024 * 1024;

export function createDeskRoute(engine, hub) {
  const route = new Hono();

  function bindCronRequestScope(c) {
    const requestContext = createRequestContext(c, engine);
    const runtimeStudioId = typeof requestContext.runtimeContext?.studioId === "string"
      && requestContext.runtimeContext.studioId.trim()
      ? requestContext.runtimeContext.studioId.trim()
      : null;
    const principalStudioId = typeof requestContext.authPrincipal?.studioId === "string"
      && requestContext.authPrincipal.studioId.trim()
      ? requestContext.authPrincipal.studioId.trim()
      : null;
    if (!runtimeStudioId) {
      return {
        error: deskRouteError(c, "runtime_studio_unavailable", "Runtime Studio unavailable", 503),
      };
    }
    if (!principalStudioId || principalStudioId !== runtimeStudioId) {
      return {
        error: deskRouteError(
          c,
          "studio_scope_mismatch",
          "Authenticated Studio does not match this server Studio",
          403,
        ),
      };
    }
    const store = getStudioCronStore(engine, runtimeStudioId);
    if (!store) {
      return {
        error: deskRouteError(c, "cron_store_unavailable", "Desk not initialized", 503),
      };
    }
    if (store.studioId !== runtimeStudioId) {
      return {
        error: deskRouteError(c, "studio_binding_invariant", "Cron Studio binding failed", 500),
      };
    }
    return { requestContext, studioId: runtimeStudioId, store, error: null };
  }

  /** 从所有 agent 的 activityStore 中按 ID 查找 entry */
  function findActivityEntry(activityId) {
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      const entry = store?.get(activityId);
      if (entry) return { entry, agentId: ag.id };
    }
    return { entry: null, agentId: null };
  }

  // ════════════════════════════
  //  助手活动
  // ════════════════════════════

  function emitActivityUpdate(activity, sessionPath = null) {
    hub?.eventBus?.emit?.({ type: "activity_update", activity }, sessionPath);
  }

  function emitActivityUpdates(activities) {
    for (const activity of activities || []) emitActivityUpdate(activity);
  }

  function buildBeautifyCoverPrompt({ filePath, themeTone, userGuidance }) {
    const styleGuide = buildCoverStyleGuideForAgent({ themeTone, userGuidance });
    return [
      "这是一个由编辑器 UI 按钮发起的 Beautify 后台任务，目标 Markdown 路径已经由按钮明确给出。",
      `目标文件：${filePath}`,
      "",
      "请按这个顺序完成：",
      "1. 阅读目标 Markdown 文件，理解文章内容和情绪。",
      "2. 你自己写一条给生图模型使用的英文提示词。",
      "3. 调用 media_generate-image 生成 1 张图片，ratio 固定传 3:2，resolution 传 2k。",
      "4. 调用 check_pending_tasks 查询本会话的图片生成任务；如果任务还没完成，停止当前轮次并说明 cover 会在后台任务完成后继续处理。",
      "5. 图片生成成功后，从 resolved 结果的 sessionFiles[0].filePath 取生成图片绝对路径。",
      "6. 调用 beautify_create-cover，把生成图片应用到 Markdown：",
      `   - targetFilePath: ${filePath}`,
      "   - generatedFilePath: <上一步生成图片的绝对路径>",
      "",
      styleGuide,
      "",
      "边界：Beautify 工具只负责把已有图片复制到附件文件夹并写入 cover frontmatter。图片来源未来也可以是内置头图库或用户本地图片，但当前按钮任务默认走生图工具。不要用 Beautify 工具生成提示词或提交生图任务，不要把生图 prompt、模型、provider、生成时间写进 Markdown。",
      "完成后用一句话说明图片已经应用为 cover，或说明失败原因。",
    ].filter(Boolean).join("\n");
  }

  function getBeautifyExecutorAgent(requestedAgentId) {
    // Beautify runs as a named agent. Fall back to the primary agent when the
    // caller does not name one, and report no executor at all when there is no
    // primary: running as whichever agent the server is focused on would put
    // the work, and its token cost, on an agent the caller never chose.
    const agentId = typeof requestedAgentId === "string" && requestedAgentId.trim()
      ? requestedAgentId.trim()
      : (engine.getPrimaryAgentId?.() || null);
    const agent = agentId ? engine.getAgent?.(agentId) : null;
    return {
      agent: agent || null,
      agentId: agent?.id || agentId || null,
    };
  }

  function isBeautifyPluginAvailable() {
    return (engine.pluginManager?.getAllTools?.() || [])
      .some((tool) => tool?._pluginId === BEAUTIFY_OPTIONAL_TOOL_NAME);
  }

  function isBeautifyEnabled(agent) {
    const disabled = Array.isArray(agent?.config?.tools?.disabled)
      ? agent.config.tools.disabled
      : DEFAULT_DISABLED_TOOL_NAMES;
    return !disabled.includes(BEAUTIFY_OPTIONAL_TOOL_NAME);
  }

  function beautifyAgentName(agent, agentId) {
    return agent?.agentName || agent?.name || agentId || null;
  }

  // engine.media (core/media/universal-media-manager.ts) is the sole runtime
  // source: it is constructed unconditionally by LucEngine, so its absence
  // here means genuinely unavailable, never "ask the plugin manager instead".
  function getImageGenerationRuntime() {
    if (!engine.media) return null;
    return {
      config: engine.media.config,
      resolveImageModelRef: (ref) => engine.media.resolveImageModelRef(ref),
    };
  }

  async function resolveDefaultImageModelStatus() {
    const imageRuntime = getImageGenerationRuntime();
    if (!imageRuntime) {
      return {
        ok: false,
        status: 404,
        reason: "image-generation-unavailable",
        error: "image generation runtime is unavailable",
        settingsTarget: "media",
      };
    }
    const defaultModel = imageRuntime.config?.get?.("defaultImageModel");
    if (!defaultModel?.provider || !defaultModel?.id) {
      return {
        ok: false,
        status: 409,
        reason: "default-image-model-missing",
        error: "default image model is not configured",
        settingsTarget: "media",
      };
    }

    try {
      const resolved = await imageRuntime.resolveImageModelRef({ providerId: defaultModel.provider, modelId: defaultModel.id });
      return { ok: true, resolved };
    } catch (err) {
      return {
        ok: false,
        status: 409,
        reason: "default-image-model-invalid",
        error: err?.message || String(err),
        settingsTarget: "media",
      };
    }
  }

  async function getBeautifyGenerationStatus(requestedAgentId) {
    const { agent, agentId } = getBeautifyExecutorAgent(requestedAgentId);
    const base = {
      available: false,
      enabled: false,
      executorAgentId: agentId,
      executorAgentName: beautifyAgentName(agent, agentId),
      disabledReason: null,
      message: null,
      settingsTarget: null,
    };

    if (!agentId || !agent) {
      return {
        ...base,
        disabledReason: "agent-unavailable",
        message: "agent unavailable",
      };
    }

    if (!isBeautifyPluginAvailable()) {
      return {
        ...base,
        disabledReason: "beautify-plugin-unavailable",
        message: "beautify tool is unavailable",
        settingsTarget: "plugins",
      };
    }

    if (!isBeautifyEnabled(agent)) {
      return {
        ...base,
        available: true,
        disabledReason: "beautify-disabled",
        message: "beautify tool is disabled for this agent",
        settingsTarget: "agent-tools",
      };
    }

    const imageStatus = await resolveDefaultImageModelStatus();
    if (!imageStatus.ok) {
      return {
        ...base,
        available: true,
        disabledReason: imageStatus.reason,
        message: imageStatus.error,
        settingsTarget: imageStatus.settingsTarget,
      };
    }

    return {
      ...base,
      available: true,
      enabled: true,
    };
  }

  function validateBeautifyMarkdownFilePath(filePath) {
    if (!filePath || !path.isAbsolute(filePath)) {
      return "filePath must be an absolute Markdown file path";
    }
    if (path.extname(filePath).toLowerCase() !== ".md") {
      return "filePath must point to a .md file";
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return "filePath must point to a file";
    } catch (err) {
      return `filePath is not readable: ${err.message}`;
    }
    return null;
  }

  function validateMarkdownCoverSystemAccess() {
    if (!isBeautifyPluginAvailable()) {
      return { error: "beautify tool is unavailable", status: 404 };
    }
    return {};
  }

  function canUseLocalAbsolutePaths(c) {
    const principal = readAuthPrincipal(c);
    return !principal || principal.kind === "unknown" || isLocalOwnerPrincipal(principal);
  }

  function fileServiceForRequest(c, defaultRootOverride = null) {
    const requestContext = createRequestContext(c, engine);
    return new MountAwareFileService({
      lucHome: engine.luccodeHome,
      defaultRoot: defaultRootOverride || defaultDeskDir(engine),
      studioId: requestContext?.studioId || engine.getRuntimeContext?.()?.studioId || null,
      createCheckpoint: typeof engine.createUserEditCheckpoint === "function"
        ? (args) => engine.createUserEditCheckpoint(args)
        : null,
      resourceIO: resourceIOForEngine(engine),
      operationContext: createApiResourceOperationContext({
        requestContext,
        requestId: requestIdFromHono(c),
      }),
    });
  }

  function resourceIOForEngine(engine) {
    const candidate = engine?.resourceIO || engine?.getResourceIO?.();
    return candidate
      && typeof candidate.stat === "function"
      && typeof candidate.write === "function"
      && typeof candidate.list === "function"
      ? candidate
      : null;
  }

  function resolveWorkspaceRootFromRequest(c, body = null) {
    const mountId = normalizeMountId(body?.mountId || body?.rootId || c.req.query("mountId") || c.req.query("rootId"));
    if (mountId) {
      const files = fileServiceForRequest(c);
      const root = files.resolveRoot(mountId);
      return {
        dir: files.resolveDirectory(mountId, ""),
        mountId: root.mountId || root.id || mountId,
        mount: root,
      };
    }
    const dir = body?.dir || (c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine));
    return { dir, mountId: null, mount: null };
  }

  function normalizeWorkbenchCoverTarget(body) {
    const raw = body?.target || body?.remoteContentRef || null;
    if (!raw) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw coverRouteError("target must be a workbench file target", "invalid_target", 400);
    }
    if (raw.kind !== "workbench-file" && raw.kind !== "mobile-workbench") {
      throw coverRouteError("target.kind must be workbench-file", "invalid_target", 400);
    }
    const mountId = typeof raw.mountId === "string" && raw.mountId.trim()
      ? raw.mountId.trim()
      : (typeof raw.rootId === "string" && raw.rootId.trim() ? raw.rootId.trim() : "default");
    return {
      kind: "workbench-file",
      mountId,
      rootId: typeof raw.rootId === "string" && raw.rootId.trim() ? raw.rootId.trim() : mountId,
      subdir: typeof raw.subdir === "string" ? raw.subdir : "",
      name: typeof raw.name === "string" ? raw.name : "",
    };
  }

  function resolveBeautifyMarkdownTarget(c, body) {
    try {
      const target = normalizeWorkbenchCoverTarget(body);
      if (target) {
        const resolved = fileServiceForRequest(c).writeFileTarget(target.mountId, target.subdir, target.name);
        const fileError = validateBeautifyMarkdownFilePath(resolved.target);
        if (fileError) return { error: fileError, status: 400 };
        return {
          filePath: resolved.target,
          target: {
            kind: "workbench-file",
            mountId: resolved.root?.mountId || resolved.root?.id || target.mountId,
            rootId: resolved.root?.id || target.rootId,
            subdir: target.subdir,
            name: resolved.filename,
          },
        };
      }

      const filePath = typeof body?.filePath === "string" ? body.filePath : "";
      if (!canUseLocalAbsolutePaths(c)) {
        return { error: "filePath requires local owner; use target for remote clients", status: 403 };
      }
      const fileError = validateBeautifyMarkdownFilePath(filePath);
      if (fileError) return { error: fileError, status: 400 };
      return { filePath, target: null };
    } catch (err) {
      if (err instanceof MountAwareFileError) {
        return { error: err.message, status: err.status };
      }
      return { error: err?.message || String(err), status: err?.status || 400 };
    }
  }

  function resolveLocalCoverImagePath(c, body) {
    const imageFilePath = typeof body?.imageFilePath === "string"
      ? body.imageFilePath
      : typeof body?.generatedFilePath === "string" ? body.generatedFilePath : "";
    if (!imageFilePath) return null;
    if (!canUseLocalAbsolutePaths(c)) {
      return { error: "imageFilePath requires local owner; upload image.contentBase64 for remote clients", status: 403 };
    }
    if (!path.isAbsolute(imageFilePath)) {
      return { error: "imageFilePath must be an absolute image file path", status: 400 };
    }
    return { filePath: imageFilePath, cleanup: null };
  }

  function writeUploadedCoverImage(body) {
    const image = body?.image && typeof body.image === "object" && !Array.isArray(body.image)
      ? body.image
      : null;
    const contentBase64 = typeof image?.contentBase64 === "string" ? image.contentBase64 : "";
    if (!contentBase64) return null;

    const base64 = contentBase64.includes(",") ? contentBase64.split(",").pop() : contentBase64;
    const buffer = Buffer.from(String(base64 || ""), "base64");
    if (buffer.byteLength === 0) {
      return { error: "image.contentBase64 is empty", status: 400 };
    }
    if (buffer.byteLength > MAX_COVER_UPLOAD_BYTES) {
      return { error: "image file too large", status: 413 };
    }

    const filename = typeof image.filename === "string" && image.filename.trim()
      ? image.filename.trim()
      : typeof image.name === "string" && image.name.trim() ? image.name.trim() : "cover.png";
    const ext = path.extname(filename).toLowerCase() || ".png";
    const uploadRoot = path.join(engine.luccodeHome || os.tmpdir(), "tmp", "markdown-cover-uploads");
    fs.mkdirSync(uploadRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(uploadRoot, "cover-"));
    const filePath = path.join(tempDir, `upload-${crypto.randomBytes(4).toString("hex")}${ext}`);
    fs.writeFileSync(filePath, buffer);
    return {
      filePath,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
  }

  function coverImageFromRequest(c, body) {
    const local = resolveLocalCoverImagePath(c, body);
    if (local) return local;
    const uploaded = writeUploadedCoverImage(body);
    if (uploaded) return uploaded;
    return { error: "imageFilePath or image.contentBase64 is required", status: 400 };
  }

  function coverRouteError(message, code, status) {
    const err: any = new Error(message);
    err.code = code;
    err.status = status;
    return err;
  }

  async function validateBeautifyGenerationAccess(body) {
    const status = await getBeautifyGenerationStatus(body?.executorAgentId || body?.agentId);
    if (!status.executorAgentId) return { error: "agent unavailable", status: 500, reason: "agent-unavailable" };
    if (!status.enabled) {
      const httpStatus = status.disabledReason === "beautify-disabled"
        ? 403
        : status.disabledReason === "beautify-plugin-unavailable" || status.disabledReason === "image-generation-unavailable"
          ? 404
          : 409;
      return {
        error: status.message || "beautify generation is unavailable",
        status: httpStatus,
        reason: status.disabledReason,
        settingsTarget: status.settingsTarget,
      };
    }
    const agent = engine.getAgent?.(status.executorAgentId);
    return { agent, agentId: status.executorAgentId };
  }

  route.get("/desk/beautify/status", async (c) => {
    const systemCover = { available: isBeautifyPluginAvailable() };
    const agentGenerate = await getBeautifyGenerationStatus(c.req.query("executorAgentId") || c.req.query("agentId"));
    return c.json({
      systemCover,
      agentGenerate,
      // Compatibility for older renderer code while the desktop bundle updates.
      available: systemCover.available,
      enabled: agentGenerate.enabled,
      agentId: agentGenerate.executorAgentId,
    });
  });

  route.post("/desk/beautify/cover/apply", async (c) => {
    const body = await safeJson(c);
    const targetInfo = resolveBeautifyMarkdownTarget(c, body);
    if (targetInfo.error) return c.json({ error: targetInfo.error }, targetInfo.status as any);

    const access = validateMarkdownCoverSystemAccess();
    if (access.error) return c.json({ error: access.error }, access.status as any);

    const image = coverImageFromRequest(c, body);
    if (image.error) return c.json({ error: image.error }, image.status as any);

    try {
      const result = await (applyMarkdownCoverFromGeneratedFile as any)({
        markdownFilePath: targetInfo.filePath,
        generatedFilePath: image.filePath,
        resourceIO: resourceIOForEngine(engine),
        operationContext: createApiResourceOperationContext({
          requestContext: createRequestContext(c, engine),
          requestId: requestIdFromHono(c),
          reason: "desk.beautify.cover.apply",
        }),
      });
      return c.json({
        ok: true,
        ...(targetInfo.target ? { target: targetInfo.target } : {}),
        cover: result.cover,
        beautifyCover: result,
      });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    } finally {
      image.cleanup?.();
    }
  });

  route.post("/desk/beautify/cover/preset/apply", async (c) => {
    const body = await safeJson(c);
    const targetInfo = resolveBeautifyMarkdownTarget(c, body);
    if (targetInfo.error) return c.json({ error: targetInfo.error }, targetInfo.status as any);

    const access = validateMarkdownCoverSystemAccess();
    if (access.error) return c.json({ error: access.error }, access.status as any);

    const presetId = typeof body?.presetId === "string" ? body.presetId : "";
    let imageFilePath;
    try {
      imageFilePath = resolveCoverGalleryPresetImagePath(presetId);
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }

    try {
      const result = await (applyMarkdownCoverFromGeneratedFile as any)({
        markdownFilePath: targetInfo.filePath,
        generatedFilePath: imageFilePath,
        resourceIO: resourceIOForEngine(engine),
        operationContext: createApiResourceOperationContext({
          requestContext: createRequestContext(c, engine),
          requestId: requestIdFromHono(c),
          reason: "desk.beautify.cover.preset_apply",
        }),
      });
      return c.json({
        ok: true,
        ...(targetInfo.target ? { target: targetInfo.target } : {}),
        cover: result.cover,
        beautifyCover: result,
      });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }
  });

  route.post("/desk/beautify/cover", async (c) => {
    const body = await safeJson(c);
    const targetInfo = resolveBeautifyMarkdownTarget(c, body);
    if (targetInfo.error) return c.json({ error: targetInfo.error }, targetInfo.status as any);
    const filePath = targetInfo.filePath;

    const access = await validateBeautifyGenerationAccess(body);
    if (access.error) {
      return c.json({
        error: access.error,
        reason: access.reason,
        settingsTarget: access.settingsTarget,
      }, access.status as any);
    }
    const { agent, agentId } = access;

    const activityId = `beautify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const activityDir = path.join(engine.agentsDir, agentId, "activity");
    const store = engine.getActivityStore(agentId);
    const activity = store.add({
      id: activityId,
      type: "beautify",
      label: "Markdown cover",
      status: "running",
      agentId,
      agentName: agent?.agentName || agent?.name || agentId,
      summary: `正在为 ${path.basename(filePath)} 生成 cover`,
      startedAt: Date.now(),
      finishedAt: null,
      sessionFile: null,
      targetFilePath: filePath,
    });
    emitActivityUpdate(activity);

    const themeTone = body?.themeTone === "dark" ? "dark" : "light";
    const userGuidance = typeof body?.userGuidance === "string" ? body.userGuidance.trim() : "";
    const abortController = new AbortController();
    let finalized = false;
    let timeoutTimer;
    const finishActivity = (patch, sessionPath = null) => {
      if (finalized) return null;
      finalized = true;
      clearTimeout(timeoutTimer);
      const updated = store.update(activityId, patch);
      if (updated) emitActivityUpdate(updated, sessionPath);
      return updated;
    };
    timeoutTimer = setTimeout(() => {
      abortController.abort();
      finishActivity(activityTimeoutPatch(activity, Date.now(), DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS));
    }, DEFAULT_ACTIVITY_EXECUTION_TIMEOUT_MS);
    timeoutTimer.unref?.();

    void engine.executeIsolated(buildBeautifyCoverPrompt({ filePath, themeTone, userGuidance }), {
      agentId,
      cwd: path.dirname(filePath),
      persist: activityDir,
      activityType: "beautify",
      toolFilter: "*",
      signal: abortController.signal,
      onSessionReady: (sessionPath) => {
        if (!sessionPath || finalized) return;
        const updated = store.update(activityId, { sessionFile: path.basename(sessionPath) });
        if (updated) emitActivityUpdate(updated, sessionPath);
      },
    }).then((result) => {
      const error = result?.error || (Array.isArray(result?.toolErrors) && result.toolErrors.length ? result.toolErrors.join("; ") : null);
      finishActivity({
        status: error ? "error" : "done",
        finishedAt: Date.now(),
        summary: error
          ? `Cover 生成失败：${error}`
          : `已应用 ${path.basename(filePath)} 的 cover`,
        ...(error ? { error } : {}),
        ...(result?.sessionPath ? { sessionFile: path.basename(result.sessionPath) } : {}),
      }, result?.sessionPath || null);
    }).catch((err) => {
      finishActivity({
        status: "error",
        finishedAt: Date.now(),
        error: err?.message || String(err),
        summary: `Cover 生成失败：${err?.message || err}`,
      });
    });

    return c.json({ ok: true, activity });
  });

  /** 活动列表（合并所有 agent） */
  route.get("/desk/activities", async (c) => {
    const allActivities = [];
    const now = Date.now();
    for (const ag of engine.listAgents()) {
      const store = engine.getActivityStore(ag.id);
      emitActivityUpdates(store?.reconcileOverdueRunning?.({ now }));
      const items = store?.list() || [];
      for (const a of items) {
        allActivities.push({
          ...a,
          agentId: a.agentId || ag.id,
          agentName: a.agentName || ag.name,
        });
      }
    }
    // 按 startedAt 倒序
    allActivities.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return c.json({ activities: allActivities });
  });

  /** 读取指定活动的 session 对话消息（只读查看用） */
  route.get("/desk/activities/:id/session", async (c) => {
    const id = c.req.param("id");
    // 从所有 agent 的 activityStore 中查找
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return deskRouteError(c, "activity_not_found", "activity not found", 404);
    if (!entry.sessionFile) return deskRouteError(c, "activity_session_unavailable", "no session file", 404);

    const activityDir = path.join(engine.agentsDir, foundAgentId, "activity");
    const sessionPath = path.join(activityDir, entry.sessionFile);
    if (!fs.existsSync(sessionPath)) return deskRouteError(c, "activity_session_missing", "session file missing", 404);

    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const lines = raw.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg) continue;
        if (msg.role !== "user" && msg.role !== "assistant") continue;

        const content = Array.isArray(msg.content)
          ? msg.content.filter(b => b.type === "text" && b.text).map(b => b.text).join("")
          : (typeof msg.content === "string" ? msg.content : "");

        if (!content) continue;
        messages.push({ role: msg.role, content });
      }

      return c.json({
        activity: {
          id: entry.id,
          type: entry.type,
          label: entry.label || null,
          agentId: entry.agentId || foundAgentId,
          agentName: entry.agentName || engine.getAgent(foundAgentId)?.agentName || foundAgentId,
          summary: entry.summary,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt,
        },
        messages,
      });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** 将活动 session 提升为正常 session（从 activity/ 移到 sessions/） */
  route.post("/desk/activities/:id/promote", async (c) => {
    const id = c.req.param("id");
    const { entry, agentId: foundAgentId } = findActivityEntry(id);
    if (!entry) return c.json({ error: "activity not found" });
    if (!entry.sessionFile) return c.json({ error: "no session file" });

    const newPath = await engine.promoteActivitySession(entry.sessionFile, foundAgentId);
    if (!newPath) return c.json({ error: "promote failed" });

    // 从 ActivityStore 移除已升格的条目
    const store = engine.getActivityStore(foundAgentId);
    store?.remove(id);

    return c.json({ ok: true, sessionPath: newPath, agentId: foundAgentId });
  });

  /** 用小工具模型快速摘要（DevTools 调试用） */
  route.post("/desk/activities/summarize", async (c) => {
    const body = await safeJson(c);
    const { id } = body;
    if (!id) return c.json({ error: "id required" });
    try {
      const summary = await engine.summarizeActivityQuick(id);
      return c.json({ summary: summary || null });
    } catch (err) {
      return c.json({ error: err.message });
    }
  });

  /** DevTools 日志（历史） */
  route.get("/desk/logs", async (c) => {
    return c.json({ logs: engine.getDevLogs() });
  });

  /** 手动触发心跳巡检（调试用） */
  route.post("/desk/heartbeat", async (c) => {
    const agentId = c.req.query("agentId");
    if (!agentId) return c.json({ error: "agentId is required" }, 400);
    const hb = hub?.scheduler?.getHeartbeat(agentId);
    if (!hb) return deskRouteError(c, "heartbeat_unavailable", "Heartbeat not initialized", 503);
    hb.triggerNow();
    return c.json({ ok: true, message: t("error.heartbeatTriggered") });
  });

  // ════════════════════════════
  //  Cron 任务
  // ════════════════════════════

  /** 列出 cron 任务 */
  route.get("/desk/cron", async (c) => {
    let scope;
    try {
      scope = bindCronRequestScope(c);
    } catch (err) {
      return cronStoreRouteFailure(c, err);
    }
    if (scope.error) return scope.error;
    const { store } = scope;
    try {
      return c.json({ jobs: store.listJobs() });
    } catch (err) {
      return cronStoreRouteFailure(c, err);
    }
  });

  /** 操作 cron 任务 */
  route.post("/desk/cron", async (c) => {
    let scope;
    try {
      scope = bindCronRequestScope(c);
    } catch (err) {
      return cronStoreRouteFailure(c, err);
    }
    if (scope.error) return scope.error;
    const { store, studioId } = scope;

    const body = await safeJson(c);
    const { action, ...params } = body;

    try {
      switch (action) {
      case "apply_suggestion": {
        const suggestionId = typeof params.suggestionId === "string" && params.suggestionId.trim()
          ? params.suggestionId.trim()
          : null;
        const sessionId = typeof params.sessionId === "string" && params.sessionId.trim()
          ? params.sessionId.trim()
          : null;
        if (!suggestionId || !sessionId) {
          return deskRouteError(c, "automation_suggestion_identity_required", "suggestionId and sessionId required", 400);
        }
        const suggestionStore = engine.getAutomationSuggestionStore?.() || engine.automationSuggestionStore || null;
        if (!suggestionStore?.apply) {
          return deskRouteError(c, "automation_suggestion_store_unavailable", "Automation suggestion store unavailable", 503);
        }
        try {
          const editedJobData = normalizeSuggestionEdits(params.jobData, engine);
          const applied = await suggestionStore.apply({
            sessionId,
            studioId,
            ref: suggestionId,
            value: { jobData: editedJobData },
          });
          if (!applied?.ok) {
            const applying = applied?.reason === "already-applying";
            const expired = applied?.reason === "expired" || applied?.reason === "not-found";
            return deskRouteError(
              c,
              applying ? "automation_suggestion_applying" : "automation_suggestion_expired",
              applying ? "Automation suggestion is already being applied" : "Automation suggestion expired or does not belong to this session and Studio",
              applying ? 409 : expired ? 410 : 400,
            );
          }
          return c.json({ ok: true, job: applied.result, jobs: store.listJobs() });
        } catch (err) {
          if (isSafeCronStoreError(err)) return cronStoreRouteFailure(c, err);
          const message = err instanceof Error ? err.message : String(err);
          const code = typeof err?.code === "string" ? err.code : "automation_suggestion_invalid";
          const status = [400, 404, 409, 410].includes(err?.status)
            ? err.status
            : code === "cron_job_revision_conflict"
              ? 409
              : code === "automation_suggestion_receipt_expired"
                ? 410
                : 400;
          return deskRouteError(c, code, message, status);
        }
      }

      case "add": {
        const type = params.scheduleType || params.type;
        let executor;
        try {
          executor = normalizeRouteExecutor(params.executor);
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
        const executorError = validateRouteExecutor(executor);
        if (executorError) return c.json({ error: executorError }, 400);
        const enabled = params.enabled !== false;
        const requiresPrompt = enabled && (!executor || executor.kind === "agent_session");
        if (!type || !params.schedule || (requiresPrompt && !params.prompt)) {
          return c.json({ error: "scheduleType, schedule, prompt required" }, 400);
        }
        const VALID_TYPES = new Set(["at", "every", "cron"]);
        if (!VALID_TYPES.has(type)) {
          return c.json({ error: `Invalid scheduleType: ${type}. Must be at/every/cron.` }, 400);
        }
        if (type === "every") {
          try {
            params.schedule = normalizeRouteEverySchedule(params.schedule);
          } catch (err) {
            return c.json({ error: err.message }, 400);
          }
        }
        const actorAgentId = typeof params.actorAgentId === "string" && params.actorAgentId.trim()
          ? params.actorAgentId.trim()
          : null;
        let executionContext;
        try {
          executionContext = normalizeRouteExecutionContext(params.executionContext, actorAgentId, engine);
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
        if (!actorAgentId || !executionContext) {
          return c.json({ error: "actorAgentId and executionContext required" }, 400);
        }
        if (typeof engine.getAgent === "function" && !engine.getAgent(actorAgentId)) {
          return c.json({ error: `agent not found: ${actorAgentId}` }, 404);
        }
        const job = store.addJob({
          type,
          schedule: params.schedule,
          prompt: typeof params.prompt === "string" ? params.prompt : "",
          label: params.label,
          model: params.model,
          actorAgentId,
          executionContext,
          executor,
          createdBy: normalizeRouteCreatedBy(params.createdBy),
          enabled,
        });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "remove": {
        if (!params.id) return c.json({ error: "id required" });
        const ok = store.removeJob(params.id);
        if (!ok) return c.json({ error: "not found" });
        return c.json({ ok: true, jobs: store.listJobs() });
      }

      case "toggle": {
        if (!params.id) return c.json({ error: "id required" });
        let job;
        try {
          job = store.toggleJob(params.id);
        } catch (err) {
          if (isSafeCronStoreError(err)) return cronStoreRouteFailure(c, err);
          const message = err instanceof Error ? err.message : String(err);
          return c.json({ error: message }, 400);
        }
        if (!job) return c.json({ error: "not found" });
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      case "update": {
        if (!params.id) return c.json({ error: "id required" });
        const { id, ...fields } = params;
        const existingJob = store.getJob(id);
        if (!existingJob) return c.json({ error: "not found" });
        if (Object.prototype.hasOwnProperty.call(fields, "executor")) {
          try {
            fields.executor = normalizeRouteExecutor(fields.executor);
          } catch (err) {
            return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
          const executorError = validateRouteExecutor(fields.executor);
          if (executorError) return c.json({ error: executorError }, 400);
        }
        if (Object.prototype.hasOwnProperty.call(fields, "actorAgentId")) {
          fields.actorAgentId = typeof fields.actorAgentId === "string" && fields.actorAgentId.trim()
            ? fields.actorAgentId.trim()
            : null;
          if (!fields.actorAgentId) return c.json({ error: "actorAgentId required" }, 400);
          if (typeof engine.getAgent === "function" && !engine.getAgent(fields.actorAgentId)) {
            return c.json({ error: `agent not found: ${fields.actorAgentId}` }, 404);
          }
        }
        if (Object.prototype.hasOwnProperty.call(fields, "executionContext")) {
          const actorAgentId = typeof fields.actorAgentId === "string" && fields.actorAgentId.trim()
            ? fields.actorAgentId.trim()
            : existingJob.actorAgentId;
          try {
            fields.executionContext = normalizeRouteExecutionContext(fields.executionContext, actorAgentId, engine);
          } catch (err) {
            return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
          if (!fields.executionContext) return c.json({ error: "executionContext required" }, 400);
        }
        const VALID_TYPES = new Set(["at", "every", "cron"]);
        if (fields.type !== undefined && !VALID_TYPES.has(fields.type)) {
          return c.json({ error: `Invalid scheduleType: ${fields.type}. Must be at/every/cron.` }, 400);
        }
        if (fields.type !== undefined && fields.type !== existingJob.type && fields.schedule === undefined) {
          return c.json({ error: "schedule required when changing scheduleType" }, 400);
        }
        const nextType = fields.type || existingJob.type;
        if (fields.schedule !== undefined && nextType === "every") {
          try {
            fields.schedule = normalizeRouteEverySchedule(fields.schedule);
          } catch (err) {
            return c.json({ error: err.message }, 400);
          }
        }
        let job;
        try {
          job = store.updateJob(id, fields);
        } catch (err) {
          if (isSafeCronStoreError(err)) return cronStoreRouteFailure(c, err);
          const message = err instanceof Error ? err.message : String(err);
          return c.json({ error: message }, 400);
        }
        return c.json({ ok: true, job, jobs: store.listJobs() });
      }

      default:
        return deskRouteError(c, "unknown_cron_action", `unknown action: ${action}`, 400);
      }
    } catch (err) {
      return cronStoreRouteFailure(c, err);
    }
  });

  // ════════════════════════════
  //  工作台文件（直接使用 cwd）
  // ════════════════════════════

  /** 扫描工作台下的项目级技能 */
  route.get("/desk/skills", async (c) => {
    try {
      const agentId = c.req.query("agentId") || null;
      const targetAgent = agentId ? engine.getAgent?.(agentId) : engine.agent;
      const policy = workspaceSkillPolicyFromConfig(targetAgent?.config?.workspace_context);
      const workspace = resolveWorkspaceRootFromRequest(c);
      const dir = workspace.dir;
      if (!dir) return c.json({ skills: [], policy });
      if (!workspace.mountId && c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) {
        return c.json({ skills: [], policy });
      }

      const results = [];
      for (const root of resolveWorkspaceSkillCatalogPaths(dir)) {
        const { dirPath: skillsDir, label, category } = root;
        try {
          for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
            if (!fs.existsSync(skillFile)) continue;
            try {
              const content = fs.readFileSync(skillFile, "utf-8");
              const meta = parseSkillMetadata(content, entry.name);
              const baseDir = path.join(skillsDir, entry.name);
              const sourceIdentity = createSkillSourceIdentity({
                owner: "workspace",
                skillName: meta.name,
                filePath: skillFile,
                baseDir,
              });
              results.push({
                name: meta.name,
                description: meta.description,
                source: label,
                sourceCategory: category,
                dirPath: skillsDir,
                filePath: skillFile,
                baseDir,
                workspaceMountId: workspace.mountId,
                sourceIdentity,
                resolutionIdentity: { source: label, sourceIdentity },
              });
            } catch { /* ignore malformed workspace skill entries */ }
          }
        } catch { /* ignore unreadable workspace skill roots */ }
      }
      const resolved = resolveWorkspaceSkillCandidateStates(results, policy)
        .map(({ resolutionIdentity: _resolutionIdentity, ...skill }) => skill);
      return c.json({ skills: resolved, policy });
    } catch (err) {
      if (err instanceof MountAwareFileError) return c.json({ error: err.message, code: err.code }, err.status as any);
      return c.json({ error: err?.message || String(err) }, err?.status || 500);
    }
  });

  /**
   * 拖拽安装项目技能
   * 接收文件路径，自动创建 .agents/skills/ 并安装
   * 支持文件夹（直接复制）和 .zip/.skill（解压）
   */
  route.post("/desk/install-skill", async (c) => {
    const body = await safeJson(c);
    let uploadedSource = null;
    try {
      const { filePath, dir } = body;
      const agentId = body.agentId || null;
      const workspace = resolveWorkspaceRootFromRequest(c, body);
      const cwd = workspace.dir;
      const sourcePath = filePath || (uploadedSource = materializeUploadedSkillPackage(engine, body))?.sourcePath;
      if (!sourcePath || !cwd) {
        return c.json({ error: "skill package and active workspace required" }, 400);
      }
      if (!workspace.mountId && dir && !isApprovedDir(cwd, engine, { agentId })) {
        return c.json({ error: "workspace is not approved" }, 403);
      }

      const skillsDir = path.join(cwd, ".agents", "skills");

      // 确保 .agents/skills/ 存在
      fs.mkdirSync(skillsDir, { recursive: true });

      // macOS: 隐藏 .agents 目录（chflags hidden）
      if (process.platform === "darwin") {
        const agentsDir = path.join(cwd, ".agents");
        try { execFileSync("chflags", ["hidden", agentsDir]); } catch { /* best effort macOS Finder hint */ }
      }

      const installed = await installSkillPackageFromPath({
        sourcePath,
        installDir: skillsDir,
        owner: "workspace",
      });
      if (typeof engine.syncWorkspaceSkillPaths === "function") {
        await engine.syncWorkspaceSkillPaths(cwd, { reload: true, emitEvent: true, force: true, agentId });
      }
      return c.json({
        ok: true,
        name: installed.name,
        installedSkillSource: installed.installedSkillSource,
      });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    } finally {
      uploadedSource?.cleanup?.();
    }
  });

  /** 删除项目技能 */
  route.post("/desk/delete-skill", async (c) => {
    const body = await safeJson(c);
    const { skillDir } = body;
    const agentId = body.agentId || null;
    if (!skillDir) {
      return c.json({ error: "skillDir is required" }, 400);
    }
    try {
      // 安全检查：必须在当前工作区的已知技能目录下
      const workspace = resolveWorkspaceRootFromRequest(c, body);
      const cwd = workspace.dir;
      if (!cwd) {
        return c.json({ error: "No active workspace" }, 400);
      }
      const allowedRoots = resolveWorkspaceSkillCatalogPaths(cwd, { existingOnly: false });
      const allowed = allowedRoots.some(({ dirPath }) =>
        isInsidePath(skillDir, dirPath)
      );
      if (!allowed) {
        return c.json({ error: "Only skills in current workspace skill directories can be deleted" }, 403);
      }
      fs.rmSync(skillDir, { recursive: true, force: true });
      if (typeof engine.syncWorkspaceSkillPaths === "function") {
        await engine.syncWorkspaceSkillPaths(cwd, { reload: true, emitEvent: true, force: true, agentId });
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  /** 工作台路径 */
  route.get("/desk/path", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ path: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    fs.mkdirSync(dir, { recursive: true });
    return c.json({ path: dir });
  });

  /** 列出工作台文件（支持 ?subdir=xxx 浏览子目录, ?dir=xxx 覆盖基目录） */
  route.get("/desk/files", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ files: [], subdir: "", basePath: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const subdir = c.req.query("subdir") || "";
    // 安全：禁止路径穿越
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    try {
      const result = await fileServiceForRequest(c, dir).listFiles("default", subdir);
      return c.json({ files: result.files, subdir: subdir || "", basePath: dir });
    } catch (err) {
      return c.json({ error: deskFileActionErrorMessage(err), ...(err?.code ? { code: err.code } : {}) }, err?.status || 400);
    }
  });

  /** 搜索工作台文件名（递归，默认跳过隐藏目录和常见依赖/构建目录） */
  route.get("/desk/search-files", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ results: [], basePath: null, query: c.req.query("q") || "" });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const query = c.req.query("q") || "";
    const limitRaw = Number.parseInt(c.req.query("limit") || "", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, WORKSPACE_SEARCH_LIMIT)
      : WORKSPACE_SEARCH_LIMIT;
    try {
      await fileServiceForRequest(c, dir).listFiles("default", "");
      const result = await fileServiceForRequest(c, dir).searchFiles("default", query);
      return c.json({ results: result.results.slice(0, limit), basePath: dir, query });
    } catch (err) {
      if (err?.code === "resource_not_found") return c.json({ results: [], basePath: dir, query });
      return c.json({ error: deskFileActionErrorMessage(err), ...(err?.code ? { code: err.code } : {}) }, err?.status || 400);
    }
  });

  /** 读取指定目录的 jian.md */
  route.get("/desk/jian", async (c) => {
    const agentId = c.req.query("agentId") || null;
    const dir = c.req.query("dir") ? decodeURIComponent(c.req.query("dir")) : defaultDeskDir(engine);
    if (!dir) return c.json({ content: null });
    if (c.req.query("dir") && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const subdir = c.req.query("subdir") || "";
    if (subdir && (subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = subdir ? path.join(dir, subdir) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });
    try {
      const result = await fileServiceForRequest(c, dir).readText("default", subdir, "jian.md");
      return c.json({ content: result.exists ? result.content : null });
    } catch (err) {
      if (err?.code === "resource_not_found") return c.json({ content: null });
      return c.json({ error: deskFileActionErrorMessage(err), ...(err?.code ? { code: err.code } : {}) }, err?.status || 400);
    }
  });

  /** 保存指定目录的 jian.md（自动创建 / 内容为空时删除） */
  route.post("/desk/jian", async (c) => {
    const body = await safeJson(c);
    const agentId = body.agentId || null;
    const dir = body.dir ? body.dir : defaultDeskDir(engine);
    if (!dir) return c.json({ error: t("error.noWorkspace") });
    if (body.dir && !isApprovedDir(dir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    const { subdir, content } = body;
    const sub = subdir || "";
    if (sub && (sub.includes("\\") || sub.includes("..") || sub.startsWith("."))) {
      return c.json({ error: "invalid subdir" });
    }
    const target = sub ? path.join(dir, sub) : dir;
    if (!isInsidePath(target, dir)) return c.json({ error: "invalid path" });

    try {
      if (content === null || content === undefined || content.trim() === "") {
        await fileServiceForRequest(c, dir).safeDeleteIfExists("default", sub, "jian.md", { reason: "desk.jian.delete" });
        return c.json({ ok: true, content: null });
      }
      await fileServiceForRequest(c, dir).writeText("default", sub, {
        action: "writeText",
        name: "jian.md",
        content,
      }, { reason: "desk.jian.write" });
      return c.json({ ok: true, content });
    } catch (err) {
      return c.json({ error: deskFileActionErrorMessage(err), ...(err?.code ? { code: err.code } : {}) }, err?.status || 400);
    }
  });

  /** 工作台文件操作（支持 subdir + dir override） */
  route.post("/desk/files", async (c) => {
    const body = await safeJson(c);
    const agentId = body.agentId || null;
    const baseDir = body.dir || defaultDeskDir(engine);
    if (!baseDir) return c.json({ error: t("error.noWorkspace") });
    if (body.dir && !isApprovedDir(baseDir, engine, { agentId })) return c.json({ error: t("error.dirNotAllowed") });
    fs.mkdirSync(baseDir, { recursive: true });

    const { action, subdir: sub, paths, name, content, oldName, newName } = body;

    // 解析子目录
    const isValidSubdir = (value) => {
      const subdir = value || "";
      return !(subdir.includes("\\") || subdir.includes("..") || subdir.startsWith("."));
    };
    const subdirStr = sub || "";
    if (!isValidSubdir(subdirStr)) return c.json({ error: "invalid subdir" });
    const dir = subdirStr ? path.join(baseDir, subdirStr) : baseDir;
    if (!isInsidePath(dir, baseDir)) return c.json({ error: "invalid path" });

    const subdirToDir = (value) => {
      const subdir = value || "";
      if (!isValidSubdir(subdir)) return null;
      const target = subdir ? path.join(baseDir, subdir) : baseDir;
      return isInsidePath(target, baseDir) ? target : null;
    };
    const reasonFor = (name) => `desk.files.${name}`;

    try {
    switch (action) {
      case "upload": {
        // upload 接受调用方提供的绝对源路径列表，把本机文件复制进 desk。
        // 该语义只为桌面 owner 端的本机拖拽设计；远端 paired 设备不应能借此
        // 把 desk dir 之外的任意可读路径（~/Documents、Library、shell init 等）
        // 拷进工作区再读回。远端要上传文件应走 /api/workbench/upload。
        if (!isLocalOwnerPrincipal(readAuthPrincipal(c))) {
          return c.json({ error: "upload by absolute path requires local owner" }, 403);
        }
        if (!Array.isArray(paths) || paths.length === 0) {
          return deskRouteError(c, "workspace_file_validation_failed", "paths required", 400);
        }
        const files = fileServiceForRequest(c, baseDir);
        const results = [];
        for (const srcPath of paths) {
          try {
            if (!path.isAbsolute(srcPath) || !fs.existsSync(srcPath)) {
              results.push({ src: srcPath, error: "invalid path" });
              continue;
            }
            if (isSensitivePath(srcPath, engine.luccodeHome)) {
              results.push({ src: srcPath, error: "sensitive path blocked" });
              continue;
            }
            const copied = await files.copyLocalPathIntoDirectory("default", subdirStr, srcPath, { reason: reasonFor("upload") });
            results.push({ src: srcPath, name: copied.filename });
          } catch (err) {
            results.push({ src: srcPath, error: err.message });
          }
        }
        return c.json({ ok: true, results, files: await files.filesForDirectory("default", subdirStr) });
      }

      case "create": {
        if (!name || content === undefined) {
          return deskRouteError(c, "workspace_file_validation_failed", "name and content required", 400);
        }
        if (!isPlainEntryName(name)) return c.json({ error: "invalid name" });
        const files = fileServiceForRequest(c, baseDir);
        const result = await files.writeText("default", subdirStr, { action: "create", name, content }, {
          reason: reasonFor("create"),
          mustNotExist: true,
        });
        return c.json({ ok: true, files: result.files });
      }

      case "mkdir": {
        if (!name) return deskRouteError(c, "workspace_file_validation_failed", "name required", 400);
        if (!isPlainEntryName(name)) return c.json({ error: "invalid name" });
        const files = fileServiceForRequest(c, baseDir);
        const result = await files.mkdir("default", subdirStr, { name }, { reason: reasonFor("mkdir") });
        return c.json({ ok: true, files: result.files });
      }

      case "rename": {
        if (!oldName || !newName) return deskRouteError(c, "workspace_file_validation_failed", "oldName and newName required", 400);
        if (!isPlainEntryName(oldName) || !isPlainEntryName(newName)) return c.json({ error: "invalid name" });
        const files = fileServiceForRequest(c, baseDir);
        const result = await files.rename("default", subdirStr, { oldName, newName }, { reason: reasonFor("rename") });
        return c.json({ ok: true, files: result.files });
      }

      case "move": {
        const names = body.names;
        const destFolder = body.destFolder;
        if (!Array.isArray(names) || names.length === 0 || !destFolder) {
          return deskRouteError(c, "workspace_file_validation_failed", "names[] and destFolder required", 400);
        }
        if (names.includes(destFolder)) {
          return c.json({ error: "cannot move folder into itself" });
        }
        const destDir = path.join(dir, path.basename(destFolder));
        if (!isInsidePath(destDir, dir)) return c.json({ error: "invalid destFolder" });
        if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
          return c.json({ error: "destFolder is not a directory" });
        }
        const files = fileServiceForRequest(c, baseDir);
        const results = [];
        for (const n of names) {
          try {
            await files.move("default", subdirStr, {
              name: path.basename(n),
              destSubdir: path.basename(destFolder),
            }, { reason: reasonFor("move") });
            results.push({ name: n, ok: true });
          } catch (err) {
            results.push({ name: n, error: deskFileActionErrorMessage(err) });
          }
        }
        return c.json({ ok: true, results, files: await files.filesForDirectory("default", subdirStr) });
      }

      case "movePaths": {
        const items = body.items;
        const destSubdir = body.destSubdir || "";
        const currentSubdir = body.currentSubdir || "";
        if (!Array.isArray(items) || items.length === 0) {
          return deskRouteError(c, "workspace_file_validation_failed", "items[] required", 400);
        }
        const destDir = subdirToDir(destSubdir);
        if (!destDir) return c.json({ error: "invalid destSubdir" });
        if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
          return c.json({ error: "destSubdir is not a directory" });
        }

        const files = fileServiceForRequest(c, baseDir);
        const result = await files.movePaths("default", {
          items,
          destSubdir,
          currentSubdir,
          createDestIfMissing: false,
        }, { reason: reasonFor("move_paths") });
        return c.json({
          ok: true,
          results: result.results,
          filesByPath: result.filesByPath,
          files: result.files,
        });
      }

      case "remove": {
        if (!name) return deskRouteError(c, "workspace_file_validation_failed", "name required", 400);
        const files = fileServiceForRequest(c, baseDir);
        const result = await files.safeDelete("default", subdirStr, { name }, { reason: reasonFor("remove") });
        return c.json({ ok: true, trashId: result.trashId, files: result.files });
      }

      default:
        return deskRouteError(c, "unknown_workspace_file_action", `unknown action: ${action}`, 400);
    }
    } catch (err) {
      return c.json({
        error: deskFileActionErrorMessage(err),
        ...(err?.code ? { code: err.code } : {}),
      }, err?.status || 400);
    }
  });

  return route;
}
