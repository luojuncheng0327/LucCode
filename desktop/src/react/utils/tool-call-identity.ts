import type { ToolCall } from '../stores/chat-types';

type ToolCallLikeEvent = {
  id?: unknown;
  toolCallId?: unknown;
  name?: unknown;
  args?: Record<string, unknown>;
};

export function normalizeToolCallId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function toolCallIdFromEvent(event: ToolCallLikeEvent): string | undefined {
  return normalizeToolCallId(event.id) ?? normalizeToolCallId(event.toolCallId);
}

export function toolCallFromStartEvent(event: ToolCallLikeEvent): ToolCall {
  const id = toolCallIdFromEvent(event);
  return {
    ...(id ? { id } : {}),
    name: typeof event.name === 'string' ? event.name : '',
    args: event.args,
    done: false,
    success: false,
  };
}

export function findOpenToolIndex(tools: ToolCall[], event: ToolCallLikeEvent): number {
  const id = toolCallIdFromEvent(event);
  if (id) {
    const exact = tools.findIndex((tool) => !tool.done && normalizeToolCallId(tool.id) === id);
    if (exact >= 0) return exact;

    // COMPAT: an in-flight stream from an older renderer may have created the
    // tool without an id before the matching end event arrives after upgrade.
    const legacy = tools.findIndex((tool) => !tool.done && !normalizeToolCallId(tool.id) && tool.name === event.name);
    if (legacy >= 0) return legacy;
    return -1;
  }

  return tools.findIndex((tool) => tool.name === event.name && !tool.done);
}
