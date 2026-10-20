import fs from "fs";

const DEFAULT_TRANSCRIPT_TAIL_BYTES = 192 * 1024;
const DEFAULT_TRANSCRIPT_ITEMS = 12;
const TEXT_LIMIT = 800;
const TOOL_ARG_KEYS = ["action", "path", "file_path", "command", "url", "query", "pattern", "selector", "appId", "appName", "folder", "label"];

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readArrayGetter(fn, ...args) {
  if (typeof fn !== "function") return [];
  try {
    return asArray(fn(...args));
  } catch {
    return [];
  }
}

function readStringGetter(fn, ...args) {
  if (typeof fn !== "function") return "";
  try {
    const value = fn(...args);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function truncate(value, limit = TEXT_LIMIT) {
  const text = String(value || "").replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\n*/gi, "").trim();
  return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
}

function readSessionTail(sessionPath, maxBytes = DEFAULT_TRANSCRIPT_TAIL_BYTES) {
  if (typeof sessionPath !== "string" || !sessionPath) return "";
  try {
    const stat = fs.statSync(sessionPath);
    if (!stat.isFile() || stat.size <= 0) return "";
    if (stat.size <= maxBytes) return fs.readFileSync(sessionPath, "utf-8");
    const fd = fs.openSync(sessionPath, "r");
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const raw = buffer.toString("utf-8");
      const firstNewline = raw.indexOf("\n");
      return firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function summarizeToolArgs(value) {
  if (!value || typeof value !== "object") return undefined;
  const args: Record<string, any> = {};
  for (const key of TOOL_ARG_KEYS) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) args[key] = truncate(item, 240);
    else if (typeof item === "number" || typeof item === "boolean") args[key] = item;
  }
  return Object.keys(args).length ? args : undefined;
}

function summarizeContent(content) {
  if (typeof content === "string") {
    const text = truncate(content);
    return { ...(text ? { text } : {}) };
  }
  if (!Array.isArray(content)) return {};
  const text = truncate(content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(""));
  const toolUses = content
    .filter((block) => block?.type === "tool_use" || block?.type === "tool-call" || block?.type === "function_call")
    .map((block) => ({
      name: block.name || block.toolName || block.function?.name || "unknown_tool",
      args: summarizeToolArgs(block.input || block.args || block.arguments || block.function?.arguments),
    }))
    .map((item) => (item.args ? item : { name: item.name }));
  return {
    ...(text ? { text } : {}),
    ...(toolUses.length ? { toolUses } : {}),
  };
}

function visibleTranscriptFromSession(sessionPath, maxItems = DEFAULT_TRANSCRIPT_ITEMS) {
  const raw = readSessionTail(sessionPath);
  if (!raw.trim()) return [];
  const items = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "message" || !entry.message) continue;
      const role = entry.message.role;
      if (role !== "user" && role !== "assistant" && role !== "tool") continue;
      const content = summarizeContent(entry.message.content);
      if (!content.text && !content.toolUses) continue;
      items.push({
        role,
        ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
        ...content,
      });
    } catch {
      // Ignore partial or damaged lines in tail reads.
    }
  }
  return items.slice(-maxItems);
}

function resolveAuthorizedFolders(source, sessionPath, ctx) {
  const fromCtx = asArray(ctx?.authorizedFolders);
  if (fromCtx.length) return fromCtx;
  const dynamic = readArrayGetter(source?.getAuthorizedFolders, sessionPath, ctx);
  if (dynamic.length) return dynamic;
  const sessionDynamic = readArrayGetter(source?.getSessionAuthorizedFolders, sessionPath, ctx);
  if (sessionDynamic.length) return sessionDynamic;
  return asArray(source?.authorizedFolders);
}

function resolveWorkspaceFolders(source, sessionPath, ctx) {
  const fromCtx = asArray(ctx?.workspaceFolders);
  if (fromCtx.length) return fromCtx;
  const sessionDynamic = readArrayGetter(source?.getSessionWorkspaceFolders, sessionPath, ctx);
  if (sessionDynamic.length) return sessionDynamic;
  return asArray(source?.workspaceFolders);
}

function resolveCwd(source, sessionPath, ctx, fallback) {
  return firstString(
    ctx?.cwd,
    fallback?.cwd,
    source?.cwd,
    readStringGetter(source?.getSessionCwd, sessionPath, ctx),
  ) || null;
}

export function buildApprovalReviewContext({
  source = {},
  ctx = null,
  sessionPath = null,
  agentId = null,
  fallback = {},
}: any = {}) {
  const visibleTranscript = Array.isArray(ctx?.visibleTranscript)
    ? ctx.visibleTranscript
    : (Array.isArray(source?.visibleTranscript) ? source.visibleTranscript : visibleTranscriptFromSession(sessionPath));
  return {
    sessionPath,
    ...(agentId || ctx?.agentId || source?.agentId ? { agentId: agentId || ctx?.agentId || source?.agentId } : {}),
    permissionContext: source?.permissionContext || null,
    userIntentSummary: firstString(
      ctx?.userIntentSummary,
      source?.userIntentSummary,
      fallback?.userIntentSummary,
    ),
    explicitUserAuthorization: firstString(
      ctx?.explicitUserAuthorization,
      source?.explicitUserAuthorization,
      fallback?.explicitUserAuthorization,
    ),
    cwd: resolveCwd(source, sessionPath, ctx, fallback),
    workspaceFolders: resolveWorkspaceFolders(source, sessionPath, ctx),
    authorizedFolders: resolveAuthorizedFolders(source, sessionPath, ctx),
    knownRemotes: asArray(ctx?.knownRemotes).length ? asArray(ctx?.knownRemotes) : asArray(source?.knownRemotes),
    knownDomains: asArray(ctx?.knownDomains).length ? asArray(ctx?.knownDomains) : asArray(source?.knownDomains),
    recentApprovalHistory: Array.isArray(ctx?.recentApprovalHistory)
      ? ctx.recentApprovalHistory
      : (Array.isArray(source?.recentApprovalHistory) ? source.recentApprovalHistory : []),
    visibleTranscript,
    executionContext: firstString(
      ctx?.executionContext,
      ctx?.bridgeContext?.platform,
      source?.executionContext,
      fallback?.executionContext,
    ),
  };
}
