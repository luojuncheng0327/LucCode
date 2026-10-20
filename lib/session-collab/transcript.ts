// 把 loadSessionHistoryMessages 的原始消息数组转成省 token 的紧凑纯文本页。
// 回合定义：一条 user 消息开启一个回合，吸收其后所有 assistant/toolResult 直到下一条 user。
import { extractTextContent } from "../../core/message-utils.ts";
import { stripSessionReminderBlocks } from "../../core/session-reminders.ts";

const TOOL_RESULT_MAX = 120;
const ARG_SUMMARY_MAX = 60;

export interface TranscriptMeta {
  sessionId: string;
  title: string | null;
  agentId: string | null;
  agentName: string | null;
  isStreaming: boolean;
}

export interface TranscriptPage {
  header: string;
  body: string;
  cursor: string | null; // 下一页游标；null = 已到最早回合
  totalTurns: number;
}

function firstLine(text: unknown, max: number): string {
  const line = String(text ?? "").split(/\r?\n/).find((l) => l.trim()) || "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

// extractTextContent 里 toolUses[].args 已经是 summarizeToolArgs 白名单过滤后的对象
// （见 shared/tool-arg-summary.ts），这里只负责把它压成单行摘要，不重新做字段筛选。
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  try {
    return firstLine(JSON.stringify(args), ARG_SUMMARY_MAX);
  } catch {
    return "";
  }
}

function imagePlaceholders(count: number): string {
  return count > 0 ? " " + Array(count).fill("[image]").join(" ") : "";
}

function renderMessage(message: any, meta: TranscriptMeta): string[] {
  if (message?.role === "user") {
    const { text, images } = extractTextContent(message.content, { stripThink: false });
    const visibleText = stripSessionReminderBlocks(text);
    return [`[user] ${visibleText.trim()}${imagePlaceholders(images.length)}`];
  }
  if (message?.role === "assistant") {
    const { text, toolUses, images } = extractTextContent(message.content, { stripThink: true });
    const lines: string[] = [];
    for (const tool of toolUses || []) {
      lines.push(`⚙ ${tool.name}(${summarizeArgs(tool.args)})`);
    }
    const body = String(text ?? "").trim();
    if (body || images.length) {
      lines.push(`[${meta.agentName || meta.agentId || "assistant"}] ${body}${imagePlaceholders(images.length)}`);
    }
    return lines;
  }
  if (message?.role === "toolResult") {
    const { text, images } = extractTextContent(message.content, { stripThink: false });
    const line = firstLine(text, TOOL_RESULT_MAX);
    const placeholder = imagePlaceholders(images.length).trim();
    const combined = [line, placeholder].filter(Boolean).join(" ");
    return combined ? [`  → ${combined}`] : [];
  }
  return []; // custom 等一律不进正文
}

function splitTurns(messages: any[]): any[][] {
  const turns: any[][] = [];
  let current: any[] | null = null;
  for (const m of messages) {
    if (m?.role === "custom") continue;
    if (m?.role === "user") {
      current = [m];
      turns.push(current);
    } else if (current) {
      current.push(m);
    } else {
      current = [m];
      turns.push(current);
    }
  }
  return turns;
}

export function buildCompactTranscript(
  messages: any[],
  opts: { meta: TranscriptMeta; cursor?: string | null; count?: number },
): TranscriptPage {
  const meta = opts.meta;
  const count = Number.isInteger(opts.count) && (opts.count as number) > 0 ? (opts.count as number) : 10;
  const turns = splitTurns(Array.isArray(messages) ? messages : []);
  const total = turns.length;

  let endExclusive = total;
  if (opts.cursor != null && opts.cursor !== "") {
    const match = /^t(\d+)$/.exec(String(opts.cursor));
    const parsed = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > total) {
      throw new Error(`invalid cursor "${opts.cursor}"; valid range: t0..t${total}`);
    }
    endExclusive = parsed;
  }
  const startInclusive = Math.max(0, endExclusive - count);
  const pageTurns = turns.slice(startInclusive, endExclusive);

  const header = [
    `session ${meta.sessionId}`,
    meta.title ? `“${meta.title}”` : null,
    `agent ${meta.agentName || meta.agentId || "unknown"}`,
    meta.isStreaming ? "(streaming)" : null,
    `turns ${startInclusive + 1}-${endExclusive}/${total}`,
  ].filter(Boolean).join(" · ");

  const body = pageTurns
    .map((turn) => turn.flatMap((m) => renderMessage(m, meta)).join("\n"))
    .filter(Boolean)
    .join("\n---\n");

  return {
    header,
    body,
    cursor: startInclusive > 0 ? `t${startInclusive}` : null,
    totalTurns: total,
  };
}
