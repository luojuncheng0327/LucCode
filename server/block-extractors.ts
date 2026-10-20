/**
 * block-extractors.js — Content Block 统一提取注册表
 *
 * 从 toolResult.details 中提取 content blocks。
 * 关键约束：extractor 只依赖 details（和 toolResult.content），
 * 不依赖 toolCall.args，因为 sessions.js 中 Pi SDK 存储的
 * toolResult 消息没有 .toolCall 属性。
 */

import path from "path";
import { t } from "../lib/i18n.ts";
import { materializeExecutorIdentity } from "../lib/subagent-executor-metadata.ts";
import { buildAutomationSuggestionBlock } from "./suggestion-blocks.ts";

export const BLOCK_EXTRACTORS = {
  // COMPAT(present_files, remove no earlier than v0.133):
  // 旧 session 可能仍有 present_files 结果，新 session 只注册 stage_files。
  stage_files: (details) => {
    const files = details.files || [];
    if (!files.length && details.filePath) {
      files.push({ filePath: details.filePath, label: details.label, ext: details.ext || "" });
    }
    return files.map(f => ({
      type: "file",
      ...sessionFileFields(f),
      filePath: f.filePath,
      label: f.label,
      ext: f.ext || "",
    }));
  },

  create_artifact: (details) => {
    if (!details.content) return null;
    const artifactFile = details.artifactFile || details.sessionFile || details.file || details;
    return [{
      type: "artifact",
      artifactId: details.artifactId,
      artifactType: details.type,
      title: details.title,
      content: details.content,
      language: details.language,
      ...sessionFileFields(artifactFile),
    }];
  },

  browser: (details, toolResult) => {
    if (details.action !== "screenshot") return null;
    const screenshotFile = details.screenshotFile || (details.fileId || details.id ? details : null);
    if (screenshotFile) {
      return [{
        type: "file",
        ...sessionFileFields(screenshotFile),
        filePath: screenshotFile.filePath,
        label: screenshotFile.label || screenshotFile.displayName || screenshotFile.filename || "browser screenshot",
        ext: screenshotFile.ext || "png",
      }];
    }
    const imgBlock = toolResult?.content?.find(c => c.type === "image");
    const data = imgBlock?.data || details.thumbnail;
    if (!data) return null;
    return [{
      type: "screenshot",
      base64: data,
      mimeType: imgBlock?.mimeType || details.mimeType || "image/jpeg",
    }];
  },

  "media_generate-image": (details) => extractMediaGenerationBlocks(details, "image"),

  "media_generate-video": (details) => extractMediaGenerationBlocks(details, "video"),

  computer: (details) => {
    const confirmation = details.confirmation;
    if (details.action !== "start" || confirmation?.kind !== "computer_app_approval") return null;
    const block = buildComputerAppApprovalBlock(confirmation);
    return block ? [block] : null;
  },

  install_skill: (details) => {
    if (!details.skillName) return null;
    const installedFile = details.installedFile || null;
    return [{
      type: "skill",
      skillName: details.skillName,
      skillFilePath: details.skillFilePath || "",
      ...(details.installedSkillSource ? { installedSkillSource: details.installedSkillSource } : {}),
      ...(installedFile?.fileId || installedFile?.id ? { fileId: installedFile.fileId || installedFile.id } : {}),
      ...(installedFile ? { installedFile } : {}),
    }];
  },

  cron: (details) => {
    let jobData = details.jobData;
    if (!jobData && details.job) {
      // COMPAT(v0.98): 老 session 没有 jobData 字段，从 job 对象重建。v0.98 后可删
      const j = details.job;
      jobData = { type: j.type, schedule: j.schedule, prompt: j.prompt, label: j.label, model: j.model };
    }
    if (!jobData) return null;
    const status = details.action === "pending_add"
      ? "pending"
      : details.confirmed === false
      ? "rejected"
      : (details.action === "cancelled" ? "rejected" : "approved");
    return [buildAutomationSuggestionBlock({ confirmId: details.confirmId || "", jobData, status })];
  },

  automation: (details) => {
    if (!["pending_add", "pending_update"].includes(details.action) || !details.jobData) return null;
    return [buildAutomationSuggestionBlock({
      suggestionId: details.suggestionId || "",
      suggestionShortCode: details.suggestionShortCode || "",
      jobData: details.jobData,
      operation: details.operation === "update" ? "update" : "create",
      status: "pending",
    })];
  },

  session: (details) => {
    if (!details?.suggestionId) return null;
    if (details.kind !== "session_send_draft" && details.kind !== "session_create_draft") return null;
    return [{
      type: "suggestion_card",
      kind: details.kind,
      suggestionId: details.suggestionId,
      status: "pending",
      title: details.kind === "session_send_draft"
        ? (details.target?.sessionTitle || details.target?.sessionId || "Session message")
        : (details.target?.agentName || details.target?.agentId || "New session"),
      description: details.draft?.message || details.draft?.firstMessage || "",
      target: details.target || undefined,
      detail: { kind: details.kind, draft: details.draft || {} },
      actions: [{ id: "view", kind: "open" }],
    }];
  },

  subagent: (details) => {
    if (!details.taskId) return null;
    const executor = materializeExecutorIdentity(details, undefined);
    const requestedAgentId = details.requestedAgentId || details.agentId || null;
    const requestedAgentName = details.requestedAgentNameSnapshot || details.agentName || requestedAgentId || null;
    return [{
      type: "subagent",
      taskId: details.taskId,
      task: details.task || "",
      taskTitle: details.taskTitle || "",
      agentId: executor?.agentId || null,
      agentName: executor?.agentName || null,
      requestedAgentId,
      requestedAgentName,
      executorAgentId: details.executorAgentId || executor?.agentId || null,
      executorAgentNameSnapshot: details.executorAgentNameSnapshot || executor?.agentName || null,
      sessionId: details.sessionId || null,
      streamKey: details.sessionPath || "",
      streamStatus: details.streamStatus || "running",
      summary: details.summary || null,
      label: details.label || details.reuseInstance || null,
    }];
  },

  // workflow inline 概览块（聊天流工具卡）：只放「名 + 状态 + 时长」概览，
  // 详细节点分布在右侧 WorkflowCard（信息架构：inline 概览 / 右侧分布）。
  // 不设 streamKey —— 概览块不展开实时流，区别于 subagent。
  workflow: (details) => {
    if (!details.taskId) return null;
    return [{
      type: "workflow",
      taskId: details.taskId,
      taskTitle: details.workflow || "",
      streamStatus: details.streamStatus || "running",
      summary: details.summary || null,
      startedAt: details.startedAt ?? null,
      finishedAt: details.finishedAt ?? null,
    }];
  },

  show_card: (details) => {
    if (!details?.code) return null;
    return [{
      type: "interactive_card",
      cardId: details.cardId || "",
      title: details.title || "",
      code: details.code,
    }];
  },

  update_settings: (details) => {
    if (details.settingsUpdate) {
      return [{
        type: "settings_update",
        update: details.settingsUpdate,
      }];
    }
    if (!details.settingKey) return null;
    const status = details.confirmed === "timeout"
      ? "timeout"
      : (details.confirmed === false ? "rejected" : "confirmed");
    return [{
      type: "settings_confirm",
      confirmId: "",
      settingKey: details.settingKey,
      cardType: details.cardType || "list",
      currentValue: details.currentValue || "",
      proposedValue: details.proposedValue || "",
      label: details.label || details.settingKey,
      status,
    }];
  },
};

(BLOCK_EXTRACTORS as any).present_files = BLOCK_EXTRACTORS.stage_files; // legacy alias, see note above

function buildComputerAppApprovalBlock(confirmation) {
  const approval = confirmation?.approval;
  if (!approval?.providerId || !approval?.appId) return null;
  const appName = approval.appName || approval.appId;
  return {
    type: "session_confirmation",
    confirmId: confirmation.confirmId || "",
    kind: "computer_app_approval",
    surface: "input",
    status: confirmation.status || "pending",
    title: t("approval.computerApp.title"),
    body: t("approval.computerApp.body"),
    subject: {
      label: appName,
      detail: `${approval.providerId} · ${approval.appId}`,
    },
    severity: "elevated",
    actions: {
      confirmLabel: t("approval.confirm"),
      rejectLabel: t("approval.reject"),
    },
    payload: { approval },
  };
}

function sessionFileFields(file) {
  if (!file || typeof file !== "object") return {};
  const fileId = file.fileId || file.id || null;
  return {
    ...(fileId ? { fileId } : {}),
    ...(file.filePath ? { filePath: file.filePath } : {}),
    ...(file.label ? { label: file.label } : {}),
    ...(file.ext !== undefined ? { ext: file.ext } : {}),
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.size !== undefined ? { size: file.size } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
    ...(file.resource ? { resource: file.resource } : {}),
  };
}

function extractMediaGenerationBlocks(details, fallbackKind) {
  const media = details?.mediaGeneration;
  if (!media || typeof media !== "object") return null;
  const tasks = Array.isArray(media.tasks) ? media.tasks : [];
  const kind = media.kind || fallbackKind || "image";
  const blocks = tasks
    .map((task) => {
      const taskId = typeof task === "string" ? task : task?.taskId;
      if (!taskId) return null;
      return {
        type: "media_generation",
        taskId,
        kind,
        ...(media.batchId ? { batchId: media.batchId } : {}),
        ...(media.prompt ? { prompt: media.prompt } : {}),
        status: "pending",
      };
    })
    .filter(Boolean);
  return blocks.length ? blocks : null;
}

function resultSessionFileBlocks(result, taskId, block) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const sessionFiles = Array.isArray(result.sessionFiles) ? result.sessionFiles : [];
  return sessionFiles
    .map((file) => sessionFileToContentBlock(file, {
      replacesTaskId: taskId,
      ...(block?.afterIndex !== undefined ? { afterIndex: block.afterIndex } : {}),
      ...(block?.sourceIndex !== undefined ? { sourceIndex: block.sourceIndex } : {}),
    }))
    .filter(Boolean);
}

function sessionFileToContentBlock(file, extra = undefined) {
  if (!file || typeof file !== "object") return null;
  const filePath = file.filePath || file.realPath || null;
  if (!filePath) return null;
  const fileId = file.fileId || file.id || null;
  const label = file.label || file.displayName || file.filename || path.basename(filePath);
  const ext = file.ext ?? path.extname(filePath || label).toLowerCase().replace(/^\./, "");
  return {
    type: "file",
    ...(extra || {}),
    ...(fileId ? { fileId } : {}),
    filePath,
    label,
    ext,
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
    ...(file.resource ? { resource: file.resource } : {}),
  };
}

function mediaGenerationFallbackBlock(block, result) {
  const status = result?.status === "aborted" ? "aborted" : "failed";
  return {
    ...block,
    status,
    ...(result?.reason ? { reason: result.reason } : {}),
  };
}

function mediaGenerationReplacementBlocks(block, result) {
  if (!result) return [block];
  if (result.status === "success" || result.status === "resolved") {
    const fileBlocks = resultSessionFileBlocks(result.result, block.taskId, block);
    return fileBlocks.length ? fileBlocks : [mediaGenerationFallbackBlock(block, {
      status: "failed",
      reason: t("deferred.mediaNoDisplayableFiles"),
    })];
  }
  if (result.status === "failed" || result.status === "aborted") {
    return [mediaGenerationFallbackBlock(block, result)];
  }
  return [block];
}

function mediaKindFromDeferredType(type) {
  if (type === "video-generation") return "video";
  if (type === "image-generation") return "image";
  return "image";
}

export function resolveMediaGenerationBlocks(blocks, results = new Map(), standaloneResults = []) {
  const resolved = [];
  const consumedTaskIds = new Set();
  const resultMap = results && typeof results.get === "function" ? results : new Map();
  const mediaInterludesByTask = new Map();
  const emittedInterludeIds = new Set();

  for (const block of blocks || []) {
    if (block?.type !== "interlude" || !block.taskId || !resultMap.has(block.taskId)) continue;
    if (!mediaInterludesByTask.has(block.taskId)) mediaInterludesByTask.set(block.taskId, []);
    mediaInterludesByTask.get(block.taskId).push(block);
  }

  const pushInterludesForTask = (taskId) => {
    const interludes = mediaInterludesByTask.get(taskId) || [];
    for (const interlude of interludes) {
      const key = interlude.id || `${interlude.taskId}:${interlude.status || ""}:${interlude.text || ""}`;
      if (emittedInterludeIds.has(key)) continue;
      emittedInterludeIds.add(key);
      resolved.push(interlude);
    }
  };

  for (const block of blocks || []) {
    if (block?.type === "interlude" && block.taskId && resultMap.has(block.taskId)) {
      continue;
    }
    if (block?.type === "media_generation" && block.taskId && resultMap.has(block.taskId)) {
      const result = resultMap.get(block.taskId);
      consumedTaskIds.add(block.taskId);
      pushInterludesForTask(block.taskId);
      for (const replacement of mediaGenerationReplacementBlocks(block, result)) {
        resolved.push(replacement);
      }
      continue;
    }
    resolved.push(block);
  }

  for (const result of standaloneResults || []) {
    if (!result?.taskId || consumedTaskIds.has(result.taskId)) continue;
    consumedTaskIds.add(result.taskId);
    const syntheticBlock = {
      type: "media_generation",
      taskId: result.taskId,
      kind: mediaKindFromDeferredType(result.type),
      status: "pending",
      ...(result.afterIndex !== undefined ? { afterIndex: result.afterIndex } : {}),
      ...(result.sourceIndex !== undefined ? { sourceIndex: result.sourceIndex } : {}),
    };
    pushInterludesForTask(result.taskId);
    for (const replacement of mediaGenerationReplacementBlocks(syntheticBlock, result)) {
      resolved.push(replacement);
    }
  }

  for (const taskId of mediaInterludesByTask.keys()) {
    pushInterludesForTask(taskId);
  }

  return resolved;
}

function extractPluginCard(details) {
  if (!details?.card?.pluginId) return null;
  const c = details.card;
  const {
    // COMPAT(v0.127, remove no earlier than v0.133):
    // 文件归属必须走 SessionFile / details.media，card 只保留展示参数。
    file: _file,
    files: _files,
    sessionFile: _sessionFile,
    sourceFile: _sourceFile,
    ...safeCard
  } = c;
  return { type: "plugin_card", card: { ...safeCard, type: safeCard.type || "iframe" } };
}

export function extractBlocks(toolName, details, toolResult) {
  const blocks = [];
  const extractor = BLOCK_EXTRACTORS[toolName];
  if (extractor) {
    const result = extractor(details || {}, toolResult);
    if (result) blocks.push(...result);
  }
  const card = extractPluginCard(details);
  if (card) blocks.push(card);
  return blocks;
}

/**
 * Drops plugin_card blocks whose owning plugin is not currently installed
 * (e.g. a historical session recorded by a since-retired plugin, or a
 * plugin the user has since uninstalled). Applied at the consuming side
 * (routes), which has access to pluginManager -- this module stays a pure
 * toolResult -> blocks transform with no plugin-manager dependency of its
 * own. `isPluginInstalled` is expected to fail open (see
 * pluginInstalledPredicate below) so a caller without plugin-manager access
 * never silently hides a real card.
 */
export function dropUninstalledPluginCards(blocks, isPluginInstalled?: ((pluginId: any) => boolean) | null) {
  if (typeof isPluginInstalled !== "function") return blocks;
  return blocks.filter((b) => b?.type !== "plugin_card" || isPluginInstalled(b.card?.pluginId));
}

/**
 * Builds the `isPluginInstalled` predicate for dropUninstalledPluginCards
 * from an engine reference. Fails open (reports "installed") when
 * pluginManager itself is unavailable, so a degraded/mocked engine never
 * causes a real card to be silently dropped.
 */
export function pluginInstalledPredicate(engine) {
  return (pluginId) => !engine?.pluginManager || Boolean(engine.pluginManager.getPlugin?.(pluginId));
}
