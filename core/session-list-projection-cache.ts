import fs from "fs/promises";
import path from "path";
import { isSessionJsonlFilename } from "../lib/session-jsonl.ts";
import { readFileLikePaths } from "../shared/link-aware-fs.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { stripSessionReminderBlocks } from "./session-reminders.ts";

const log = createModuleLogger("session-list-cache");

/**
 * Session 文件修订点：`${size}:${mtimeMs}` stat 签名。
 *
 * 这是会话「磁盘真相」的唯一修订标识，三处必须共用同一格式：
 *   1. 本缓存的失效判据（signature）
 *   2. /api/sessions 列表投影的 `revision` 字段
 *   3. /api/sessions/messages 响应的 `revision` 字段
 * web/mobile 端靠对比 2 和 3 决定是否补拉会话内容（issue #1610）。
 */
export function sessionFileRevision(stat) {
  return `${stat.size}:${stat.mtimeMs}`;
}

export class SessionListProjectionCache {
  declare _dirs: Map<string, Map<string, any>>;

  constructor() {
    this._dirs = new Map();
  }

  async list(sessionDir) {
    let files;
    try {
      files = (await readFileLikePaths(sessionDir, { extension: ".jsonl" }))
        .filter((filePath) => isSessionJsonlFilename(path.basename(filePath)));
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }

    const previous = this._dirs.get(sessionDir) || new Map();
    const next = new Map();

    const projections = await Promise.all(files.map(async (filePath) => {
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (err) {
        if (err?.code !== "ENOENT") {
          // 单文件隔离（#414 同族拓扑加固）：EPERM/EIO 等非 ENOENT 错误
          // 只跳过这一个文件，不让整个目录的 list() 调用 reject。
          log.warn(`session projection stat failed for ${filePath}: ${err?.code || ""} ${err?.message || err}`);
        }
        return null;
      }

      const signature = sessionFileRevision(stat);
      const cached = previous.get(filePath);
      if (cached?.signature === signature) {
        next.set(filePath, cached);
        return cloneProjection(cached.projection);
      }

      const projection = await buildSessionProjection(filePath, stat);
      next.set(filePath, { signature, projection });
      return cloneProjection(projection);
    }));

    this._dirs.set(sessionDir, next);
    return projections
      .filter(Boolean)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  invalidate(sessionDir = null) {
    if (sessionDir) this._dirs.delete(sessionDir);
    else this._dirs.clear();
  }
}

async function buildSessionProjection(filePath, stat) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const entries = [];
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines, matching the Pi SDK listing behavior.
      }
    }

    if (!entries.length) return null;
    const header = entries[0];
    if (header?.type !== "session") return null;

    let messageCount = 0;
    let firstMessage = "";
    let name;
    const allMessages = [];

    for (const entry of entries) {
      if (entry?.type === "session_info") {
        name = entry.name?.trim() || undefined;
      }
      if (entry?.type !== "message") continue;
      messageCount += 1;
      const message = entry.message;
      if (!isMessageWithContent(message)) continue;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const textContent = stripSessionReminderBlocks(extractTextContent(message));
      if (!textContent) continue;
      allMessages.push(textContent);
      if (!firstMessage && message.role === "user") {
        firstMessage = textContent;
      }
    }

    return {
      path: filePath,
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name,
      parentSessionPath: header.parentSession,
      created: parseDate(header.timestamp) || new Date(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs),
      modified: getSessionModifiedDate(entries, header, stat.mtime),
      revision: sessionFileRevision(stat),
      messageCount,
      firstMessage,
      allMessagesText: allMessages.join(" "),
    };
  } catch {
    return null;
  }
}

function cloneProjection(projection) {
  if (!projection) return null;
  return {
    ...projection,
    created: projection.created ? new Date(projection.created) : projection.created,
    modified: projection.modified ? new Date(projection.modified) : projection.modified,
  };
}

function isMessageWithContent(message) {
  return !!message && typeof message === "object" && typeof message.role === "string" && "content" in message;
}

function extractTextContent(message) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

function getSessionModifiedDate(entries, header, statsMtime) {
  const lastActivityTime = getLastActivityTime(entries);
  if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
    return new Date(lastActivityTime);
  }
  return parseDate(header?.timestamp) || statsMtime;
}

function getLastActivityTime(entries) {
  let lastActivityTime;
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!isMessageWithContent(message)) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;

    const messageTime = parseTimestamp(message.timestamp);
    if (typeof messageTime === "number") {
      lastActivityTime = Math.max(lastActivityTime ?? 0, messageTime);
      continue;
    }

    const entryTime = parseTimestamp(entry.timestamp);
    if (typeof entryTime === "number") {
      lastActivityTime = Math.max(lastActivityTime ?? 0, entryTime);
    }
  }
  return lastActivityTime;
}

function parseDate(value) {
  const time = parseTimestamp(value);
  return typeof time === "number" ? new Date(time) : null;
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return time;
  }
  return null;
}
