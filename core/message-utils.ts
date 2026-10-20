/**
 * 消息工具函数 — 跨模块共享的消息处理工具
 *
 * 从 sessions route 提取，供 route 层与 plugin 系统共用。
 */
import fs from "fs/promises";
import path from "path";
import { isToolCallBlock, getToolArgs } from "./llm-utils.ts";
import { SessionManager } from "../lib/pi-sdk/index.ts";
import { isSessionJsonlFilename } from "../lib/session-jsonl.ts";
import { DEFERRED_RESULT_RECORD_TYPE } from "../lib/deferred-result-notification.ts";
import {
  AGENT_REVIEW_RECORD_TYPE,
  MESSAGE_ORIGIN_RECORD_TYPE,
  MESSAGE_PRESENTATION_RECORD_TYPE,
} from "./desktop-session-submit.ts";
import { SESSION_COLLAB_DECISION_RECORD_TYPE } from "../lib/session-collab/decision-record.ts";
import {
  TURN_INPUT_CONSUMPTION_EVENT_TYPE,
  TURN_INPUT_PRESENTATION_EVENT_TYPE,
} from "../lib/turn-input-presentation.ts";
import { repairOversizedSessionEntriesInFile } from "./session-jsonl-file.ts";
import { isAssistantCommentaryTextBlock } from "../shared/text-signature.ts";
import { TOOL_ARG_SUMMARY_KEYS, summarizeToolArgs } from "../shared/tool-arg-summary.ts";
import { projectSessionMessageForDisplay } from "./session-reminders.ts";
import { isKnownLegacyLucToolFailure } from "../shared/tool-outcome.ts";
export { TOOL_ARG_SUMMARY_KEYS };

const SESSION_TAIL_READ_THRESHOLD = 256 * 1024;
const ATTACHED_IMAGE_MARKER_RE = /\[attached_image:\s*[^\]]+\]/g;

/** 从文本中提取并剥离 <think>/<thinking> 标签 */
export function stripThinkTags(raw) {
  const thinkParts = [];
  const text = raw.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\n*/g, (_, inner) => {
    thinkParts.push(inner.trim());
    return "";
  });
  return { text, thinkContent: thinkParts.join("\n") };
}

/**
 * 从 Pi SDK 的 content 块数组中提取纯文本 + thinking + tool_use 调用
 * content 可能是 string 或 [{type: "text", text: "..."}, {type: "thinking", thinking: "..."}, ...]
 * 返回 { text, thinking, toolUses, images }
 */
export function extractTextContent(content, { stripThink = false } = {}) {
  if (typeof content === "string") {
    if (stripThink) {
      const { text, thinkContent } = stripThinkTags(content);
      return { text, thinking: thinkContent, toolUses: [], images: [] };
    }
    return { text: content, thinking: "", toolUses: [], images: [] };
  }
  if (!Array.isArray(content)) return { text: "", thinking: "", toolUses: [], images: [] };
  const rawText = content
    .filter(block => block.type === "text" && block.text && !isAssistantCommentaryTextBlock(block))
    .map(block => block.text)
    .join("");
  const images = content
    .filter(block => block.type === "image" && (block.data || block.source?.data))
    .map(block => ({ data: block.data || block.source.data, mimeType: block.mimeType || block.source?.media_type || "image/png" }));
  const { text, thinkContent } = stripThink ? stripThinkTags(rawText) : { text: rawText, thinkContent: "" };
  const thinking = [
    thinkContent,
    ...content
      .filter(block => block.type === "thinking" && block.thinking)
      .map(block => block.thinking),
  ].filter(Boolean).join("\n");
  const toolUses = content
    .filter(isToolCallBlock)
    .map(block => {
      const params = getToolArgs(block);
      const args = summarizeToolArgs(params);
      return {
        id: typeof block.id === "string" && block.id ? block.id : undefined,
        name: block.name,
        ...(args ? { args } : {}),
      };
    });
  return { text, thinking, toolUses, images };
}

export function contentHasThinkingBlock(content, { stripThink = false } = {}) {
  if (typeof content === "string") {
    if (!stripThink) return false;
    return /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/.test(content);
  }
  if (!Array.isArray(content)) return false;
  return content.some(block => block?.type === "thinking");
}

export function filterUnreferencedInlineImages(text, images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const markerCount = String(text || "").match(ATTACHED_IMAGE_MARKER_RE)?.length || 0;
  if (markerCount <= 0) return images;
  if (markerCount >= images.length) return [];
  return images.slice(markerCount);
}

/**
 * 优先从 session JSONL 读取完整历史，并在返回边界移除模型专用的 Reminder 展示内容。
 * engine.messages 可能只是当前上下文窗口，切回页面时会导致旧消息缺失。
 * 读文件失败时再退回内存态，避免历史接口直接空白。
 */
export async function loadSessionHistoryMessages(engine, explicitPath) {
  const sessionPath = explicitPath;
  if (!sessionPath) return [];

  try {
    if (await looksLikePiSessionFile(sessionPath)) {
      repairOversizedSessionEntriesInFile(sessionPath);
      const manager = typeof engine?.openSessionManagerAtCurrentBranch === "function"
        ? engine.openSessionManagerAtCurrentBranch(sessionPath, path.dirname(sessionPath))
        : SessionManager.open(sessionPath, path.dirname(sessionPath));
      const branch = manager.getBranch();
      const messages = [];
      for (const entry of branch) {
        const message = historyMessageFromEntry(entry);
        if (message) messages.push(message);
      }
      return messages.map(projectSessionMessageForDisplay);
    }
  } catch {
    // 旧文件或损坏文件继续走兼容读取，不让历史页直接空白。
  }

  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    const messages = [];

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const message = historyMessageFromEntry(entry);
        if (message) messages.push(message);
      } catch {
        // 跳过损坏行
      }
    }

    if (messages.length > 0) return messages.map(projectSessionMessageForDisplay);
  } catch {
    // 文件读取失败
  }

  return [];
}

function historyMessageFromEntry(entry) {
  if (entry?.type === "message" && entry.message) {
    const message = entry.message.role === "toolResult"
      && entry.message.isError !== true
      && isKnownLegacyLucToolFailure(entry.message)
      ? { ...entry.message, isError: true }
      : { ...entry.message };
    if (entry.id) message.id = entry.id;
    if (entry.timestamp) message.timestamp = entry.timestamp;
    return message;
  }
  if (entry?.type === "custom_message" && entry.customType) {
    const message: Record<string, any> = {
      role: "custom",
      customType: entry.customType,
      content: entry.content || "",
      display: entry.display,
      ...(entry.details !== undefined ? { details: entry.details } : {}),
    };
    if (entry.id) message.id = entry.id;
    if (entry.timestamp) message.timestamp = entry.timestamp;
    return message;
  }
  if (
    entry?.type === "custom" &&
    (
      entry.customType === DEFERRED_RESULT_RECORD_TYPE
      || entry.customType === TURN_INPUT_PRESENTATION_EVENT_TYPE
      || entry.customType === TURN_INPUT_CONSUMPTION_EVENT_TYPE
      || entry.customType === MESSAGE_ORIGIN_RECORD_TYPE
      || entry.customType === AGENT_REVIEW_RECORD_TYPE
      || entry.customType === MESSAGE_PRESENTATION_RECORD_TYPE
      || entry.customType === SESSION_COLLAB_DECISION_RECORD_TYPE
    )
  ) {
    const message: Record<string, any> = {
      role: "custom",
      customType: entry.customType,
      data: entry.data,
      display: false,
    };
    if (entry.id) message.id = entry.id;
    if (entry.timestamp) message.timestamp = entry.timestamp;
    return message;
  }
  return null;
}

/** origin custom 条目注释其后第一条 user 消息（契约见 desktop-session-submit recordMessageOriginEntry）。返回过滤掉 origin 条目的新数组。 */
export function annotateOriginMessages(messages) {
  const out = [];
  let pendingOrigin = null;
  for (const m of messages || []) {
    if (m?.role === "custom" && m.customType === MESSAGE_ORIGIN_RECORD_TYPE) {
      pendingOrigin = m.data || null;
      continue;
    }
    if (m?.role === "custom" && (
      m.customType === AGENT_REVIEW_RECORD_TYPE
      || m.customType === MESSAGE_PRESENTATION_RECORD_TYPE
    )) {
      continue;
    }
    if (m?.role === "user" && pendingOrigin?.origin) {
      out.push({
        ...m,
        origin: pendingOrigin.origin,
        ...(typeof pendingOrigin.displayText === "string" ? { displayText: pendingOrigin.displayText } : {}),
      });
      pendingOrigin = null;
      continue;
    }
    if (m?.role === "user") { pendingOrigin = null; }
    out.push(m);
  }
  return out;
}

/**
 * 草稿卡确认状态持久化（灰测修复 C，契约见 lib/session-collab/decision-record.ts）：
 * 从原始消息流里收集决策 custom 条目，按 suggestionId 建索引，供
 * overlaySessionCollabDecision 覆盖 suggestion_card block 的 status。
 * 同一 suggestionId 出现多条决策时后者覆盖前者（消息流本身有序，正常不会发生）。
 */
export function collectSessionCollabDecisions(messages) {
  const map = new Map();
  for (const m of messages || []) {
    if (m?.role !== "custom" || m.customType !== SESSION_COLLAB_DECISION_RECORD_TYPE) continue;
    const suggestionId = m.data?.suggestionId;
    if (typeof suggestionId === "string" && suggestionId) map.set(suggestionId, m.data);
  }
  return map;
}

/**
 * 用决策记录覆盖 suggestion_card block 的 status（+ resultSessionId），
 * 让重开 session 后草稿卡不再回弹 pending。非 suggestion_card 或未命中决策
 * 的 block 原样返回（不拷贝，避免无意义的引用变更）。
 */
export function overlaySessionCollabDecision(block, decisionsBySuggestionId) {
  if (!block || block.type !== "suggestion_card" || !block.suggestionId) return block;
  const decision = decisionsBySuggestionId?.get?.(block.suggestionId);
  if (!decision) return block;
  return {
    ...block,
    status: decision.status,
    ...(decision.resultSessionId ? { resultSessionId: decision.resultSessionId } : {}),
  };
}

async function looksLikePiSessionFile(sessionPath) {
  const fh = await fs.open(sessionPath, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf-8", 0, bytesRead).split("\n")[0]?.trim();
    if (!firstLine) return false;
    const header = JSON.parse(firstLine);
    return header?.type === "session" && typeof header.id === "string";
  } finally {
    await fh.close();
  }
}

async function readSessionTailUtf8(filePath, maxBytes = SESSION_TAIL_READ_THRESHOLD) {
  const stat = await fs.stat(filePath);
  if (!stat.size) return "";
  if (stat.size <= maxBytes) {
    return await fs.readFile(filePath, "utf-8");
  }

  const start = Math.max(0, stat.size - maxBytes);
  const fh = await fs.open(filePath, "r");
  try {
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    let raw = buf.toString("utf-8");
    const firstNewline = raw.indexOf("\n");
    if (firstNewline === -1) return "";
    return raw.slice(firstNewline + 1);
  } finally {
    await fh.close();
  }
}

/**
 * 从 session JSONL 尾部推断最后一条 assistant 文本摘要。
 *
 * 这里故意保持和 sessions route 旧语义一致：
 * - 只看物理文件尾部最近的 assistant message
 * - 若最近 assistant 没有文本，则返回 null，不继续向前找更早的 assistant
 *
 * 这样可以把整文件 read+split 降成有界尾读，同时不改变现有 UI 的终态判断规则。
 */
export async function loadLatestAssistantSummaryFromSessionFile(sessionPath, options: { maxBytes?: number; summaryLimit?: number } = {}) {
  if (!sessionPath) return null;
  const maxBytes = options.maxBytes ?? SESSION_TAIL_READ_THRESHOLD;
  const summaryLimit = options.summaryLimit ?? 200;

  try {
    const raw = await readSessionTailUtf8(sessionPath, maxBytes);
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const lines = trimmed.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const msg = entry?.message;
        if (entry?.type !== "message" || msg?.role !== "assistant") continue;
        const { text } = extractTextContent(msg.content, { stripThink: true });
        return text ? text.slice(0, summaryLimit) : null;
      } catch {
        // 跳过损坏行，继续向前扫描
      }
    }
  } catch {
    // 文件读取失败
  }

  return null;
}

export function relativePathInsideBase(targetPath, baseDir) {
  if (typeof targetPath !== "string" || typeof baseDir !== "string") return null;
  if (!targetPath || !baseDir) return null;

  const resolved = path.resolve(targetPath);
  const base = path.resolve(baseDir);
  const rel = path.relative(base, resolved);
  if (rel === "") return "";
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * 校验 sessionPath 是否在合法范围内，防止路径穿越
 * baseDir 可以是 sessionDir（单 agent）或 agentsDir（跨 agent）
 */
export function isValidSessionPath(sessionPath, baseDir) {
  return relativePathInsideBase(sessionPath, baseDir) !== null;
}

function desktopSessionParts(sessionPath, agentsDir) {
  const rel = relativePathInsideBase(sessionPath, agentsDir);
  if (rel === null) return false;
  const parts = rel.split(path.sep);
  if (!parts[0] || !parts[1]) return false;
  return parts;
}

function isJsonlFileName(name) {
  return isSessionJsonlFilename(name);
}

/**
 * Active desktop sessions are the only paths allowed to run model turns or
 * receive background delivery: `agents/{id}/sessions/*.jsonl`.
 */
export function isActiveDesktopSessionPath(sessionPath, agentsDir) {
  const parts = desktopSessionParts(sessionPath, agentsDir);
  if (!parts || parts.length !== 3) return false;
  if (parts[1] !== "sessions") return false;
  return isJsonlFileName(parts[2]);
}

/**
 * Archived desktop sessions are readable/restorable lifecycle objects:
 * `agents/{id}/sessions/archived/*.jsonl`. They are not runnable.
 */
export function isArchivedDesktopSessionPath(sessionPath, agentsDir) {
  const parts = desktopSessionParts(sessionPath, agentsDir);
  if (!parts || parts.length !== 4) return false;
  if (parts[1] !== "sessions" || parts[2] !== "archived") return false;
  return isJsonlFileName(parts[3]);
}

export function isDesktopSessionPath(sessionPath, agentsDir) {
  return isActiveDesktopSessionPath(sessionPath, agentsDir)
    || isArchivedDesktopSessionPath(sessionPath, agentsDir);
}

/**
 * Backward-compatible name used by older call sites. It is intentionally
 * active-only now; archived sessions must go through restore/read/delete flows.
 */
export function isActiveSessionPath(sessionPath, agentsDir) {
  return isActiveDesktopSessionPath(sessionPath, agentsDir);
}
