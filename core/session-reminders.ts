/**
 * Renders internal reminder blocks for changes hidden by a session's frozen
 * prompt/tool snapshot. The block remains in model JSONL; server-owned display
 * projections remove it, with the desktop parser retained as defense in depth.
 *
 * The renderer is pure with respect to session state. It returns an immutable
 * receipt, and callers apply that receipt only after the prompt/steer operation
 * has accepted the rendered message.
 */

import type {
  EnvChangeEntry,
  EnvChangeLedger,
  MemoryFactsPayload,
} from "./env-change-ledger.ts";

import { estimateTextTokens } from "../lib/llm/estimate-text-tokens.ts";

export const REMINDER_BLOCK_PREFIX = "[luc_reminder";
export const REMINDER_BLOCK_END = "[/luc_reminder]";

/**
 * Reference blocks carry material the model needs to read once, such as the
 * listing of tools a session deferred. They are a different shape of thing from
 * the reminder broadcasts below: a broadcast is a short notice about something
 * that changed, while a reference block is a body of text whose whole value is
 * being complete. So they get their own envelope and their own budget, and the
 * 300 character broadcast limit does not apply to them.
 *
 * Both are removed from user-visible text by the same projection.
 */
export const REFERENCE_BLOCK_PREFIX = "[luc_reference]";
export const REFERENCE_BLOCK_END = "[/luc_reference]";

const REFERENCE_BUDGET_CONTEXT_FRACTION = 0.05;
const REFERENCE_BUDGET_MAX_TOKENS = 20000;
const REFERENCE_BUDGET_FALLBACK_TOKENS = 2000;

/**
 * A reference block may spend five percent of the model's context, capped at
 * twenty thousand tokens. The cap matters more than the fraction: on a very
 * large window, five percent is more than any listing needs, and the space is
 * worth more to the conversation.
 */
export function resolveReferenceBudgetTokens(contextWindowTokens: unknown): number {
  const window = typeof contextWindowTokens === "number" && Number.isFinite(contextWindowTokens)
    ? contextWindowTokens
    : 0;
  if (window <= 0) return REFERENCE_BUDGET_FALLBACK_TOKENS;
  return Math.max(1, Math.min(
    Math.floor(window * REFERENCE_BUDGET_CONTEXT_FRACTION),
    REFERENCE_BUDGET_MAX_TOKENS,
  ));
}

/**
 * Renders a reference block, trimming only if the body exceeds its own budget.
 * Callers are expected to have sized the content already (the tool catalog
 * picks a listing tier against this same budget); this is the backstop.
 */
export function renderReferenceBlock({
  text,
  budgetTokens,
}: {
  text: string;
  budgetTokens: number;
}): string {
  const body = typeof text === "string" ? text.trim() : "";
  if (!body) return "";
  const budget = typeof budgetTokens === "number" && Number.isFinite(budgetTokens) && budgetTokens > 0
    ? Math.floor(budgetTokens)
    : REFERENCE_BUDGET_FALLBACK_TOKENS;
  let rendered = body;
  if (estimateTextTokens(body) > budget) {
    // estimateTextTokens is chars/4, so the budget converts back directly.
    rendered = `${body.slice(0, Math.max(1, budget * 4 - 1))}…`;
  }
  return `${REFERENCE_BLOCK_PREFIX}\n${rendered}\n${REFERENCE_BLOCK_END}`;
}

// 当前块头是静态的；`at <时间戳>` 是历史 JSONL 里的旧块头，剥离端必须继续认
const REMINDER_HEADER_LINE_RE = /^\[luc_reminder(?: at \d{4}-\d{2}-\d{2} \d{2}:\d{2})?\]$/;

/**
 * Whole-line forms of the two markers the submit path prepends to a prompt so
 * the model can see which files came with the message. They live here, next to
 * the envelope projection, so every consumer that needs "what did the user
 * actually type" reads one definition instead of keeping its own copy.
 */
export const ATTACHMENT_MARKER_RE = /^\[(attached_(?:image|video|audio):[^\]]+)\]\s*$/;
export const SESSION_FILE_MARKER_RE = /^\[SessionFile\]\s+\{.*\}\s*$/;

const BLOCK_BODY_CHAR_LIMIT = 300;

/**
 * Removes model-only reminder blocks from user-visible session text.
 *
 * Historical JSONL stores reminder input inside the user message because the
 * model must observe it. Display/export consumers must use this projection
 * rather than exposing that internal input. An exact header without a closing
 * line is removed through end-of-text so a truncated JSONL entry fails closed.
 */
export function stripSessionReminderBlocks(value: unknown): string {
  if (typeof value !== "string" || !value) return typeof value === "string" ? value : "";

  const visibleLines: string[] = [];
  let insideReminder = false;
  let insideReference = false;
  let dropSeparatorAfterReminder = false;

  for (const line of value.split(/\r?\n/)) {
    if (insideReference) {
      if (line === REFERENCE_BLOCK_END) {
        insideReference = false;
        dropSeparatorAfterReminder = true;
      }
      continue;
    }
    if (insideReminder) {
      if (line === REMINDER_BLOCK_END) {
        insideReminder = false;
        dropSeparatorAfterReminder = true;
      }
      continue;
    }
    // Like the reminder envelope, an unterminated reference block is dropped
    // through end of text so a truncated JSONL entry fails closed.
    if (line === REFERENCE_BLOCK_PREFIX) {
      insideReference = true;
      continue;
    }
    if (REMINDER_HEADER_LINE_RE.test(line)) {
      insideReminder = true;
      continue;
    }
    if (dropSeparatorAfterReminder && line === "") continue;
    dropSeparatorAfterReminder = false;
    visibleLines.push(line);
  }

  while (visibleLines.at(-1) === "") visibleLines.pop();
  return visibleLines.join("\n");
}

/**
 * The text the user actually typed, with everything the submit path prepended
 * removed: the model-only envelopes above, plus the attachment and session-file
 * markers that stand in for the files carried alongside the message.
 *
 * Consumers that summarize, title, or otherwise reason about the user's own
 * words compose this instead of reading the raw prompt, so a new envelope shape
 * only has to be taught to the projections above to be honored everywhere.
 */
export function visiblePromptText(value: unknown): string {
  const withoutBlocks = stripSessionReminderBlocks(value);
  if (!withoutBlocks) return "";
  return withoutBlocks
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !ATTACHMENT_MARKER_RE.test(trimmed) && !SESSION_FILE_MARKER_RE.test(trimmed);
    })
    .join("\n")
    .trim();
}

/** Projects a persisted message for display without mutating the JSONL truth. */
export function projectSessionMessageForDisplay(message: any): any {
  if (!message || message.role !== "user") return message;
  if (typeof message.content === "string") {
    const content = stripSessionReminderBlocks(message.content);
    return content === message.content ? message : { ...message, content };
  }
  if (!Array.isArray(message.content)) return message;

  let changed = false;
  const content = message.content.map((block: any) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const text = stripSessionReminderBlocks(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? { ...message, content } : message;
}

export interface ReminderSessionEntry {
  reminderEnvCursor: number;
  reminderEnvStartSeq: number;
  reminderCompactionRevision: number;
  reminderConsumedCompactionRevision: number;
  reminderAcceptedUnavailableToolNames: string[];
  reminderUnavailableRevision: number;
  /** Set once the session has been handed its deferred-tool listing. */
  reminderReferenceDelivered?: boolean;
  /** The catalog shape this session has already been told about. */
  reminderAcceptedCatalogFingerprint?: string | null;
  reminderAcceptedCatalogNames?: string[];
}

export interface SessionReminderReceipt {
  readonly throughSeq: number;
  readonly compactionRevision: number;
  readonly unavailableToolNames: readonly string[];
  readonly baseUnavailableRevision: number;
  readonly consumeBlockState: boolean;
  /**
   * Present only when this render is handing over reference material. Sessions
   * that never defer tools keep the exact receipt shape they always had.
   */
  readonly deliverReference?: boolean;
  /** Present only when this render broadcasts a catalog change. */
  readonly catalogFingerprint?: string;
  readonly catalogNames?: readonly string[];
}

export interface RenderedSessionReminderBlock {
  readonly block: string;
  readonly receipt: SessionReminderReceipt;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function memoryFactsEntries(entries: EnvChangeEntry[]): EnvChangeEntry[] {
  return entries.filter((entry) => entry.type === "memory_facts");
}

function entriesVisibleToAgent(entries: EnvChangeEntry[], recipientAgentId: string): EnvChangeEntry[] {
  return entries.filter((entry) => entry.scope.agentId === recipientAgentId);
}

function formatMemoryFactsLine(payload: Readonly<MemoryFactsPayload>, isZh: boolean): string {
  const lines = payload.addedLines.join(isZh ? "；" : "; ");
  return isZh ? `记忆新增事实：${lines}` : `New memory facts recorded: ${lines}`;
}

function formatCompactionLine(isZh: boolean): string {
  return isZh
    ? "上下文已压缩，早期对话已被总结"
    : "Context has been compacted; earlier turns were summarized";
}

function normalizeUnavailableToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function formatUnavailableToolsLine(names: readonly string[], isZh: boolean): string {
  return isZh
    ? `以下会话工具当前不可用：${names.join("、")}`
    : `These session tools are currently unavailable: ${names.join(", ")}`;
}

function selectUnavailableToolBatch(names: readonly string[], isZh: boolean): string[] {
  const batch: string[] = [];
  for (const name of names) {
    const candidate = [...batch, name];
    const line = `- ${formatUnavailableToolsLine(candidate, isZh)}`;
    if (line.length > BLOCK_BODY_CHAR_LIMIT) break;
    batch.push(name);
  }
  return batch;
}

export function collectReminderBlock({
  sessionEntry,
  ledger,
  recipientAgentId,
  isZh,
  unavailableToolNames = [],
  referenceText = "",
  referenceBudgetTokens = 0,
  catalogBroadcast = null,
}: {
  sessionEntry: ReminderSessionEntry;
  ledger: EnvChangeLedger;
  recipientAgentId: string;
  isZh: boolean;
  unavailableToolNames?: string[];
  /** Reference material to hand over once, such as a deferred-tool listing. */
  referenceText?: string;
  referenceBudgetTokens?: number;
  /**
   * A catalog change the session has not been told about yet. Its lines go
   * through the ordinary broadcast channel, character limit and all: the
   * session is being told something moved, not handed a new listing.
   */
  catalogBroadcast?: { lines: string[]; fingerprint: string; names: string[] } | null;
}): RenderedSessionReminderBlock | null {
  const normalizedRecipientAgentId = typeof recipientAgentId === "string" ? recipientAgentId.trim() : "";
  if (!normalizedRecipientAgentId) {
    throw new TypeError("collectReminderBlock requires a non-empty recipientAgentId");
  }
  const throughSeq = ledger.maxSeq();
  const compactionRevision = nonNegativeInteger(sessionEntry.reminderCompactionRevision);
  const consumedCompactionRevision = nonNegativeInteger(sessionEntry.reminderConsumedCompactionRevision);
  const hasPendingCompaction = compactionRevision > consumedCompactionRevision;
  const envCursor = hasPendingCompaction
    ? nonNegativeInteger(sessionEntry.reminderEnvStartSeq)
    : nonNegativeInteger(sessionEntry.reminderEnvCursor);
  const entries = entriesVisibleToAgent(
    ledger.entriesAfter(envCursor, throughSeq),
    normalizedRecipientAgentId,
  );
  const lines: string[] = [];
  const acceptedUnavailableToolNames = normalizeUnavailableToolNames(
    sessionEntry.reminderAcceptedUnavailableToolNames,
  );
  const unavailableRevision = nonNegativeInteger(sessionEntry.reminderUnavailableRevision);
  const currentUnavailableToolNames = normalizeUnavailableToolNames(unavailableToolNames);
  const acceptedUnavailableSet = new Set(acceptedUnavailableToolNames);
  const currentUnavailableSet = new Set(currentUnavailableToolNames);
  const newUnavailableToolNames = currentUnavailableToolNames.filter(
    (name) => !acceptedUnavailableSet.has(name),
  );
  const stillAcceptedUnavailableToolNames = acceptedUnavailableToolNames.filter(
    (name) => currentUnavailableSet.has(name),
  );
  const renderedUnavailableToolNames = selectUnavailableToolBatch(newUnavailableToolNames, isZh);
  const nextAcceptedUnavailableToolNames = normalizeUnavailableToolNames([
    ...stillAcceptedUnavailableToolNames,
    ...renderedUnavailableToolNames,
  ]);
  const hasNewOutage = renderedUnavailableToolNames.length > 0;
  const availabilityTransition = !sameNames(
    acceptedUnavailableToolNames,
    nextAcceptedUnavailableToolNames,
  );

  if (hasNewOutage) {
    lines.push(`- ${formatUnavailableToolsLine(renderedUnavailableToolNames, isZh)}`);
  }
  const broadcastLines = Array.isArray(catalogBroadcast?.lines) ? catalogBroadcast.lines : [];
  for (const line of broadcastLines) lines.push(`- ${line}`);
  if (hasPendingCompaction) lines.push(`- ${formatCompactionLine(isZh)}`);
  for (const entry of memoryFactsEntries(entries)) {
    lines.push(`- ${formatMemoryFactsLine(entry.payload as Readonly<MemoryFactsPayload>, isZh)}`);
  }

  // The listing is delivered exactly once per session. Re-sending it would
  // repeat a large body of text the model has already read, and the whole point
  // of deferring was to stop paying for tool descriptions twice.
  const pendingReference = sessionEntry.reminderReferenceDelivered !== true
    && typeof referenceText === "string"
    && referenceText.trim().length > 0;

  if (lines.length === 0 && !availabilityTransition && !pendingReference) return null;

  let body = lines.join("\n");
  if (body.length > BLOCK_BODY_CHAR_LIMIT) {
    if (hasNewOutage) {
      const outageLine = lines[0];
      const remainingBody = lines.slice(1).join("\n");
      const remainingLimit = BLOCK_BODY_CHAR_LIMIT - outageLine.length - 1;
      body = remainingLimit > 1 && remainingBody
        ? `${outageLine}\n${remainingBody.slice(0, remainingLimit - 1)}…`
        : outageLine;
    } else {
      body = `${body.slice(0, BLOCK_BODY_CHAR_LIMIT - 1)}…`;
    }
  }

  const receipt = Object.freeze({
    throughSeq,
    compactionRevision,
    unavailableToolNames: Object.freeze([...nextAcceptedUnavailableToolNames]),
    baseUnavailableRevision: unavailableRevision,
    consumeBlockState: lines.length > 0,
    ...(pendingReference ? { deliverReference: true } : {}),
    ...(broadcastLines.length > 0 && catalogBroadcast
      ? {
          catalogFingerprint: catalogBroadcast.fingerprint,
          catalogNames: Object.freeze([...catalogBroadcast.names]),
        }
      : {}),
  });
  const reminderBlock = lines.length > 0
    // 块头不带时间戳：reminder 不投递时间，模型需要当前时间时调用 current_status(time)
    ? `${REMINDER_BLOCK_PREFIX}]\n${body}\n${REMINDER_BLOCK_END}`
    : "";
  const referenceBlock = pendingReference
    ? renderReferenceBlock({ text: referenceText, budgetTokens: referenceBudgetTokens })
    : "";
  return Object.freeze({
    // The listing comes first: it is context for everything after it, and a
    // later broadcast is appended rather than rewriting what was already sent.
    block: [referenceBlock, reminderBlock].filter(Boolean).join("\n\n"),
    receipt,
  });
}

/** Applies only the state range represented by a previously rendered receipt. */
export function applyReminderConsumption({
  sessionEntry,
  receipt,
}: {
  sessionEntry: ReminderSessionEntry;
  receipt: SessionReminderReceipt;
}): void {
  if (
    !receipt
    || !Number.isFinite(receipt.throughSeq)
    || !Number.isFinite(receipt.compactionRevision)
    || !Array.isArray(receipt.unavailableToolNames)
    || !Number.isFinite(receipt.baseUnavailableRevision)
    || typeof receipt.consumeBlockState !== "boolean"
  ) {
    throw new TypeError("applyReminderConsumption requires a valid reminder receipt");
  }

  if (receipt.deliverReference === true) {
    sessionEntry.reminderReferenceDelivered = true;
  }

  if (typeof receipt.catalogFingerprint === "string" && receipt.catalogFingerprint) {
    sessionEntry.reminderAcceptedCatalogFingerprint = receipt.catalogFingerprint;
    sessionEntry.reminderAcceptedCatalogNames = Array.isArray(receipt.catalogNames)
      ? [...receipt.catalogNames]
      : [];
  }

  if (receipt.consumeBlockState) {
    sessionEntry.reminderEnvCursor = Math.max(
      nonNegativeInteger(sessionEntry.reminderEnvCursor),
      nonNegativeInteger(receipt.throughSeq),
    );
    const currentRevision = nonNegativeInteger(sessionEntry.reminderCompactionRevision);
    sessionEntry.reminderConsumedCompactionRevision = Math.max(
      nonNegativeInteger(sessionEntry.reminderConsumedCompactionRevision),
      Math.min(nonNegativeInteger(receipt.compactionRevision), currentRevision),
    );
  }

  const currentUnavailableRevision = nonNegativeInteger(
    sessionEntry.reminderUnavailableRevision,
  );
  if (currentUnavailableRevision === nonNegativeInteger(receipt.baseUnavailableRevision)) {
    const accepted = normalizeUnavailableToolNames(
      sessionEntry.reminderAcceptedUnavailableToolNames,
    );
    const next = normalizeUnavailableToolNames(receipt.unavailableToolNames);
    if (!sameNames(accepted, next)) {
      sessionEntry.reminderAcceptedUnavailableToolNames = next;
      sessionEntry.reminderUnavailableRevision = currentUnavailableRevision + 1;
    }
  }
}
