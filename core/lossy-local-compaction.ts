import { computeSessionLineageMetadata } from "../lib/session-jsonl.ts";

export type LossyLocalCompactionSummarySource = {
  summary?: string | null;
  cursor?: {
    coveredLeafId?: string | null;
    lineageHash?: string | null;
  } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  resetAt?: string | null;
} | null;

type OmissionCounts = {
  toolResults: number;
  toolCalls: number;
  thinkingBlocks: number;
  nonTextBlocks: number;
  otherEntries: number;
};

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textFromMessage(message: any, omitted: OmissionCounts): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";

  const text: string[] = [];
  for (const block of message.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      text.push(block.text);
      continue;
    }
    if (block?.type === "toolCall" || block?.type === "tool_call") {
      omitted.toolCalls += 1;
      continue;
    }
    if (block?.type === "thinking" || block?.type === "reasoning") {
      omitted.thinkingBlocks += 1;
      continue;
    }
    omitted.nonTextBlocks += 1;
  }
  return text.join("\n");
}

function renderTranscript(entries: any[], omitted: OmissionCounts): string {
  const sections: string[] = [];
  for (const entry of entries) {
    if (entry?.type === "message") {
      const role = entry.message?.role;
      if (role === "toolResult" || role === "tool_result") {
        omitted.toolResults += 1;
        continue;
      }
      if (role !== "user" && role !== "assistant") {
        omitted.otherEntries += 1;
        continue;
      }
      const text = textFromMessage(entry.message, omitted);
      if (!text) continue;
      sections.push(`### ${role === "user" ? "User" : "Assistant"}\n${text}`);
      continue;
    }
    if (entry?.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
      sections.push(`### Earlier Compaction Checkpoint\n${entry.summary}`);
      continue;
    }
    omitted.otherEntries += 1;
  }
  return sections.join("\n\n");
}

function summaryCursorIndex(entries: any[], source: LossyLocalCompactionSummarySource): number | null {
  const cursor = source?.cursor;
  if (!cursor || typeof cursor.lineageHash !== "string" || !cursor.lineageHash) return null;

  const lineage = computeSessionLineageMetadata(entries);
  const coveredLeafId = cursor.coveredLeafId ?? null;
  const expectedHash = coveredLeafId === null
    ? lineage.rootLineageHash
    : lineage.prefixHashes[coveredLeafId];
  if (!expectedHash || expectedHash !== cursor.lineageHash) return null;
  if (coveredLeafId === null) return -1;
  const index = entries.findIndex((entry) => entry?.id === coveredLeafId);
  return index >= 0 ? index : null;
}

function fileDetails(fileOps: any) {
  const read = fileOps?.read instanceof Set ? fileOps.read : new Set(fileOps?.read || []);
  const written = fileOps?.written instanceof Set ? fileOps.written : new Set(fileOps?.written || []);
  const edited = fileOps?.edited instanceof Set ? fileOps.edited : new Set(fileOps?.edited || []);
  const modified = new Set([...written, ...edited]);
  return {
    readFiles: [...read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

/**
 * Rebuild a compaction checkpoint without inference or network access.
 *
 * The recent tail remains represented by Pi's exact firstKeptEntryId. The
 * checkpoint only projects the older region, removing both halves of tool
 * transactions as well as hidden reasoning so provider tool protocols cannot
 * be left half-open.
 */
export function createLossyLocalCompactionResult({
  branchEntries,
  preparation,
  summarySource = null,
}: {
  branchEntries: any[];
  preparation: any;
  summarySource?: LossyLocalCompactionSummarySource;
}) {
  if (!Array.isArray(branchEntries)) {
    throw new Error("Instant local compaction requires the current session branch");
  }
  if (!preparation || typeof preparation !== "object") {
    throw new Error("Instant local compaction requires Pi's compaction preparation");
  }

  const entries = branchEntries.filter((entry) => entry?.type !== "session");
  const firstKeptEntryId = typeof preparation.firstKeptEntryId === "string"
    ? preparation.firstKeptEntryId
    : "";
  const keptIndex = entries.findIndex((entry) => entry?.id === firstKeptEntryId);
  if (!firstKeptEntryId || keptIndex <= 0) {
    throw new Error("Instant local compaction could not prove the retained-tail boundary");
  }

  const omitted: OmissionCounts = {
    toolResults: 0,
    toolCalls: 0,
    thinkingBlocks: 0,
    nonTextBlocks: 0,
    otherEntries: 0,
  };
  const sourceSummary = typeof summarySource?.summary === "string"
    ? summarySource.summary.trim()
    : "";
  const cursorIndex = summaryCursorIndex(entries, summarySource);
  const resetAt = parseTimestamp(summarySource?.resetAt);
  const summaryUpdatedAt = parseTimestamp(summarySource?.updatedAt ?? summarySource?.createdAt);
  const summaryIsAfterReset = resetAt === null
    || (summaryUpdatedAt !== null && summaryUpdatedAt > resetAt);
  const useRollingSummary = !!sourceSummary
    && cursorIndex !== null
    && cursorIndex < keptIndex
    && summaryIsAfterReset;

  const sections = [
    "# Instant Simple Compaction Checkpoint",
    "This checkpoint was rebuilt locally without a model request. Tool calls, tool results, hidden reasoning, and non-text payloads from the reconstructed region were omitted. The recent tail after this checkpoint remains verbatim.",
  ];

  if (useRollingSummary && resetAt !== null) {
    const beforeReset = entries
      .slice(0, (cursorIndex as number) + 1)
      .filter((entry) => {
        const timestamp = parseTimestamp(entry?.timestamp ?? entry?.message?.timestamp);
        return timestamp === null || timestamp <= resetAt;
      });
    const earlierTranscript = renderTranscript(beforeReset, omitted);
    if (earlierTranscript) {
      sections.push("## Earlier Transcript Before Memory Reset", earlierTranscript);
    }
  }

  if (useRollingSummary) {
    sections.push("## Existing Rolling Session Summary", sourceSummary);
  }

  const continuationStart = useRollingSummary ? (cursorIndex as number) + 1 : 0;
  const continuation = renderTranscript(entries.slice(continuationStart, keptIndex), omitted);
  if (continuation) {
    sections.push(
      useRollingSummary ? "## Verbatim Text After the Rolling Summary" : "## Reconstructed Verbatim Text",
      continuation,
    );
  }

  sections.push(
    "## In Progress",
    "- Continue the active task from this checkpoint and the unchanged recent tail.",
    "## Next Steps",
    "1. Follow the newest retained user message and do not repeat completed work.",
  );

  return {
    summary: sections.join("\n\n"),
    firstKeptEntryId,
    tokensBefore: Number(preparation.tokensBefore) || 0,
    details: {
      ...fileDetails(preparation.fileOps),
      strategy: "lossy_local",
      source: useRollingSummary ? "rolling_summary" : "branch_text",
      zeroModelRequest: true,
      rollingSummaryCoveredLeafId: useRollingSummary
        ? summarySource?.cursor?.coveredLeafId ?? null
        : null,
      omitted,
    },
  };
}
