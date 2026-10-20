import { promises as fsp } from "fs";
import path from "path";
import { parseChannel } from "./channel-store.ts";

export type ConversationExportOptions = {
  filePath: string;
  type: "channel" | "dm";
  conversationId: string;
  displayName?: string;
  ownerAgentId?: string;
  peerAgentId?: string;
  now?: Date;
};

export type ConversationExportResult = {
  markdown: string;
  filename: string;
  mediaType: "text/markdown; charset=utf-8";
  encoding: "utf-8";
  messageCount: number;
};

function ensureTrailingNewline(content: string) {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function inlineCode(value: string) {
  const normalized = value.replace(/[\r\n]+/g, " ");
  const longestRun = Math.max(0, ...Array.from(normalized.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${normalized}${fence}`;
}

function safeFilenamePart(value: string) {
  const part = value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return part || "conversation";
}

function archiveFilename(options: ConversationExportOptions, generatedAt: Date) {
  if (Number.isNaN(generatedAt.getTime())) throw new TypeError("now must be a valid Date");
  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  const identity = options.type === "dm"
    ? `${safeFilenamePart(options.ownerAgentId || "agent")}-${safeFilenamePart(options.peerAgentId || options.conversationId)}`
    : safeFilenamePart(options.displayName || options.conversationId);
  return `luc-${options.type}-${identity}-${stamp}.md`;
}

export async function buildConversationMarkdownExport(options: ConversationExportOptions): Promise<ConversationExportResult> {
  if (!options.filePath || !options.conversationId) {
    throw new TypeError("filePath and conversationId are required");
  }
  const now = options.now || new Date();
  const stat = await fsp.stat(options.filePath);
  if (!stat.isFile()) throw new Error("conversation record is not a file");
  const content = await fsp.readFile(options.filePath, "utf-8");
  const parsed = parseChannel(content);
  const displayName = options.displayName || String(parsed.meta.name || options.conversationId);
  const lines = [
    `# ${options.type === "dm" ? "Direct Message" : "Group Chat"}: ${displayName}`,
    "",
    `Exported at: ${now.toISOString()}`,
    `Conversation ID: ${inlineCode(options.conversationId)}`,
  ];

  if (options.type === "dm") {
    lines.push(`Participants: ${inlineCode(options.ownerAgentId || "unknown")} ↔ ${inlineCode(options.peerAgentId || "unknown")}`);
  }

  lines.push("", "## Conversation record", "", ensureTrailingNewline(content));
  return {
    markdown: ensureTrailingNewline(lines.join("\n")),
    filename: archiveFilename(options, now),
    mediaType: "text/markdown; charset=utf-8",
    encoding: "utf-8",
    messageCount: parsed.messages.length,
  };
}
