import type { ChatListItem, ChatMessage, ContentBlock, ToolCall } from '../../stores/chat-types';
import { isToolCallHiddenFromProcessUi } from '../../utils/tool-call-visibility';

export interface ProcessFoldStats {
  toolCount: number;
  thinkingCount: number;
  unsuccessfulCount: number;
}

export interface SourceTranscriptRenderItem {
  type: 'source';
  item: ChatListItem;
  originalIndex: number;
}

export interface ProcessFoldMessage {
  item: Extract<ChatListItem, { type: 'message' }>;
  originalIndex: number;
}

export interface ProcessFoldRenderItem {
  type: 'process_fold';
  id: string;
  items: ProcessFoldMessage[];
  originalIndex: number;
  stats: ProcessFoldStats;
}

export type TranscriptRenderItem = SourceTranscriptRenderItem | ProcessFoldRenderItem;

export type ProcessFoldTranslator = (key: string, vars?: Record<string, string | number>) => string;

const MIN_PROCESS_MESSAGES_TO_FOLD = 3;
const PROCESS_NARRATION_TEXT_LIMIT = 100;

function isAssistantMessage(item: ChatListItem): item is Extract<ChatListItem, { type: 'message' }> {
  return item.type === 'message' && item.data.role === 'assistant';
}

function hasVisibleToolCallsShape(block: ContentBlock): block is Extract<ContentBlock, { type: 'tool_group' }> {
  return block.type === 'tool_group' && Array.isArray(block.tools);
}

function hasRenderableTextShape(block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> {
  return block.type === 'text' && (typeof block.html === 'string' || typeof block.source === 'string');
}

function isProcessBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'thinking' | 'tool_group' }> {
  return block.type === 'thinking' || hasVisibleToolCallsShape(block);
}

function isProcessNarrationBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'thinking' | 'tool_group' | 'text' }> {
  return block.type === 'thinking' || hasVisibleToolCallsShape(block) || hasRenderableTextShape(block);
}

function visibleToolCalls(block: Extract<ContentBlock, { type: 'tool_group' }>): ToolCall[] {
  return Array.isArray(block.tools) ? block.tools.filter((tool) => !isToolCallHiddenFromProcessUi(tool)) : [];
}

function visibleBlocks(message: ChatMessage): ContentBlock[] {
  return (message.blocks || []).filter((block) =>
    block.type !== 'session_confirmation' || block.surface !== 'input',
  );
}

export function isProcessOnlyAssistantMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  const blocks = visibleBlocks(message);
  if (blocks.length === 0) return false;
  return blocks.every(isProcessBlock);
}

function textBlocks(message: ChatMessage): Extract<ContentBlock, { type: 'text' }>[] {
  return visibleBlocks(message).filter((block): block is Extract<ContentBlock, { type: 'text' }> => (
    hasRenderableTextShape(block)
  ));
}

function htmlToPlainText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function messageTextLength(message: ChatMessage): number {
  return textBlocks(message).reduce((sum, block) => {
    const text = block.source ?? htmlToPlainText(block.html);
    return sum + text.replace(/\s+/g, ' ').trim().length;
  }, 0);
}

function hasText(message: ChatMessage): boolean {
  return textBlocks(message).length > 0;
}

function isShortProcessNarrationMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  const blocks = visibleBlocks(message);
  if (blocks.length === 0 || !hasText(message)) return false;
  if (!blocks.every(isProcessNarrationBlock)) return false;
  return messageTextLength(message) <= PROCESS_NARRATION_TEXT_LIMIT;
}

function turnInputEntryId(message: ChatMessage): string | null {
  return typeof message.turnInputEntryId === 'string' && message.turnInputEntryId.trim()
    ? message.turnInputEntryId.trim()
    : null;
}

function crossesTurnInputBoundary(current: string | null, next: string | null): boolean {
  return current !== next && (current !== null || next !== null);
}

function protectedFinalTextIndexes(items: ChatListItem[]): Set<number> {
  const protectedIndexes = new Set<number>();
  let latestAssistantTextIndex = -1;
  let activeTurnInputEntryId: string | null = null;

  const protectLatestText = () => {
    if (latestAssistantTextIndex >= 0) protectedIndexes.add(latestAssistantTextIndex);
    latestAssistantTextIndex = -1;
  };

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.type !== 'message') continue;

    if (item.data.role === 'user') {
      protectLatestText();
      activeTurnInputEntryId = null;
      continue;
    }

    if (item.data.role === 'assistant') {
      const nextTurnInputEntryId = turnInputEntryId(item.data);
      if (crossesTurnInputBoundary(activeTurnInputEntryId, nextTurnInputEntryId)) {
        protectLatestText();
      }
      activeTurnInputEntryId = nextTurnInputEntryId;
      if (hasText(item.data)) latestAssistantTextIndex = i;
    }
  }

  protectLatestText();
  return protectedIndexes;
}

function isFoldableProcessAssistantMessage(message: ChatMessage, isProtectedFinalText: boolean): boolean {
  if (isProcessOnlyAssistantMessage(message)) return true;
  if (isProtectedFinalText) return false;
  return isShortProcessNarrationMessage(message);
}

function collectStats(messages: ProcessFoldMessage[]): ProcessFoldStats {
  let toolCount = 0;
  let thinkingCount = 0;
  let unsuccessfulCount = 0;

  for (const entry of messages) {
    for (const block of entry.item.data.blocks || []) {
      if (block.type === 'thinking') {
        thinkingCount += 1;
        continue;
      }
      if (block.type !== 'tool_group') continue;
      const tools = visibleToolCalls(block);
      toolCount += tools.length;
      unsuccessfulCount += tools.filter((tool) => tool.done && !tool.success).length;
    }
  }

  return { toolCount, thinkingCount, unsuccessfulCount };
}

function lastUserIndex(items: ChatListItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type === 'message' && item.data.role === 'user') return i;
  }
  return -1;
}

function foldId(messages: ProcessFoldMessage[]): string {
  const first = messages[0]?.item.data.id || 'start';
  const last = messages[messages.length - 1]?.item.data.id || first;
  return `process-fold-${first}-${last}`;
}

function sourceItem(item: ChatListItem, originalIndex: number): SourceTranscriptRenderItem {
  return { type: 'source', item, originalIndex };
}

export function buildTranscriptRenderItems(
  items: ChatListItem[],
  options: { isStreaming: boolean },
): TranscriptRenderItem[] {
  const rendered: TranscriptRenderItem[] = [];
  const latestUserIndex = lastUserIndex(items);
  const protectedTextIndexes = protectedFinalTextIndexes(items);

  for (let i = 0; i < items.length;) {
    const item = items[i];
    if (!isAssistantMessage(item) || !isFoldableProcessAssistantMessage(item.data, protectedTextIndexes.has(i))) {
      rendered.push(sourceItem(item, i));
      i += 1;
      continue;
    }

    const segment: ProcessFoldMessage[] = [];
    let cursor = i;
    let segmentTurnInputEntryId = turnInputEntryId(item.data);
    while (cursor < items.length) {
      const candidate = items[cursor];
      if (
        !isAssistantMessage(candidate)
        || !isFoldableProcessAssistantMessage(candidate.data, protectedTextIndexes.has(cursor))
      ) {
        break;
      }
      const candidateTurnInputEntryId = turnInputEntryId(candidate.data);
      if (
        segment.length > 0
        && crossesTurnInputBoundary(segmentTurnInputEntryId, candidateTurnInputEntryId)
      ) {
        break;
      }
      segment.push({ item: candidate, originalIndex: cursor });
      segmentTurnInputEntryId = candidateTurnInputEntryId;
      cursor += 1;
    }

    const isCurrentTrailingTurn = options.isStreaming && i > latestUserIndex;
    if (segment.length < MIN_PROCESS_MESSAGES_TO_FOLD || isCurrentTrailingTurn) {
      for (const entry of segment) rendered.push(sourceItem(entry.item, entry.originalIndex));
      i = cursor;
      continue;
    }

    rendered.push({
      type: 'process_fold',
      id: foldId(segment),
      items: segment,
      originalIndex: i,
      stats: collectStats(segment),
    });
    i = cursor;
  }

  return rendered;
}

function fallbackTranslate(key: string, vars?: Record<string, string | number>): string {
  const table: Record<string, string> = {
    'processFold.summary': '✨ {name}忙活了一阵子',
    'processFold.tools': '{n} 个工具',
    'processFold.thinking': '{n} 次思考',
    'processFold.unsuccessful': '{n} 次尝试未成功',
  };
  return interpolate(table[key] || key, vars);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name) => String(vars?.[name] ?? ''));
}

export function buildProcessFoldSummary(
  stats: ProcessFoldStats,
  agentName: string,
  translate: ProcessFoldTranslator = fallbackTranslate,
): string {
  const parts = [translate('processFold.summary', { name: agentName })];
  if (stats.toolCount > 0) parts.push(translate('processFold.tools', { n: stats.toolCount }));
  if (stats.thinkingCount > 0) parts.push(translate('processFold.thinking', { n: stats.thinkingCount }));
  if (stats.unsuccessfulCount > 0) parts.push(translate('processFold.unsuccessful', { n: stats.unsuccessfulCount }));
  return parts.join(' · ');
}
