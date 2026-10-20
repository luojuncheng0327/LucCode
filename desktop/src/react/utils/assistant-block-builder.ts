import type { ContentBlock, ToolCall } from '../stores/chat-types';
import { renderMarkdown } from './markdown';
import { parseCardFromContent, parseMoodFromContent } from './message-parser';

interface AssistantBlockInput {
  content: string;
  thinking?: string | null;
  toolCalls?: Array<{
    id?: string;
    toolCallId?: string;
    name: string;
    args?: Record<string, unknown>;
    status?: 'succeeded' | 'failed' | 'unknown';
    success?: boolean;
    error?: string;
  }> | null;
  extraBlocks?: ContentBlock[] | null;
  includeTextSource?: boolean;
}

export function buildAssistantBlocksFromContent({
  content,
  thinking = null,
  toolCalls = null,
  extraBlocks = null,
  includeTextSource = false,
}: AssistantBlockInput): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (thinking !== null && thinking !== undefined) {
    blocks.push({ type: 'thinking', content: thinking, sealed: true });
  }

  const { mood, yuan, text: afterMood } = parseMoodFromContent(content || '');
  if (mood && yuan) {
    blocks.push({ type: 'mood', yuan, text: mood });
  }

  if (toolCalls?.length) {
    blocks.push({
      type: 'tool_group',
      tools: toolCalls.map<ToolCall>((tc) => ({
        id: tc.id || tc.toolCallId || undefined,
        name: tc.name,
        args: tc.args,
        done: true,
        success: tc.status === 'succeeded' || (tc.status === undefined && tc.success !== false),
        status: tc.status || (tc.success === false ? 'failed' : 'succeeded'),
        ...(tc.error ? { error: tc.error } : {}),
      })),
      collapsed: toolCalls.length > 1,
    });
  }

  const { cards, text: mainText } = parseCardFromContent(afterMood);
  if (mainText) {
    blocks.push({
      type: 'text',
      html: renderMarkdown(mainText),
      ...(includeTextSource ? { source: mainText } : {}),
    });
  }

  for (const card of cards) {
    blocks.push({ type: 'plugin_card', card });
  }

  if (extraBlocks?.length) {
    blocks.push(...extraBlocks);
  }

  return blocks;
}
