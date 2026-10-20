import type { ToolCall } from '../stores/chat-types';

type ToolCallVisibilityInput = Pick<ToolCall, 'name' | 'args'>;

const CARD_BACKED_TOOL_NAMES = new Set([
  'luc_card_guide',
  'show_card',
  'media_generate-image',
  'media_generate-video',
  'workflow',
  'install_skill',
  'update_settings',
]);

const CARD_BACKED_AUTOMATION_ACTIONS = new Set([
  'create',
  'update',
  'add_notify',
  'add_plugin_action',
  'pending_add',
  'pending_update',
]);

function toolAction(tool: ToolCallVisibilityInput): string | null {
  const action = tool.args?.action;
  return typeof action === 'string' ? action : null;
}

export function isToolCallHiddenFromProcessUi(tool: ToolCallVisibilityInput): boolean {
  if (tool.name === 'subagent') return true;
  if (tool.name === 'stage_files') return true;
  if (CARD_BACKED_TOOL_NAMES.has(tool.name)) return true;
  if (tool.name === 'automation') return CARD_BACKED_AUTOMATION_ACTIONS.has(toolAction(tool) || '');
  if (tool.name === 'browser') return toolAction(tool) === 'screenshot';
  return false;
}
