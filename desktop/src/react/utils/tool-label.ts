/**
 * 工具行文案解析。
 *
 * 进程区每条工具调用只有这一个取值点，键形如 `tool.<工具名>.<相位>`。
 * 工具名对不上就静默落到兜底文案，运行时不报错，所以内置名单和语言包的一致性
 * 由 tests/tool-label-coverage.test.ts 对账守住。
 */

import type { ToolCall } from '../stores/chat-types';

export type ToolPhase = 'running' | 'done' | 'failed';
export type ToolStatus = NonNullable<ToolCall['status']>;

/** 这两个工具复用别的工具的文案。 */
export const TOOL_LABEL_ALIASES: Record<string, string> = {
  exec_command: 'bash',
  write_stdin: 'terminal',
};

/**
 * session 一个工具管三件不同的事，一套文案盖不住：read/list 是查看别的会话，
 * send/create 只是拟了一张待确认的草稿卡，那一刻消息还没发出去。用一套
 * "联系上了"的说法会在卡片还等着确认的时候就宣布结果。
 */
export const SESSION_ACTION_LABEL_KEYS: Record<string, string> = {
  send: 'session_send',
  create: 'session_create',
};

function labelKeyFor(name: string, args?: Record<string, unknown>): string {
  const aliased = TOOL_LABEL_ALIASES[name];
  if (aliased) return aliased;
  if (name === 'session') {
    const action = typeof args?.action === 'string' ? args.action : '';
    return SESSION_ACTION_LABEL_KEYS[action] ?? 'session';
  }
  return name;
}

/**
 * 一方工具名。插件工具由 PluginManager 注册成 `<pluginId>_<tool>`，MCP 工具是
 * `mcp_<tool>`，都不在这张表里，因此查不到专属文案时能落到插件兜底而不是通用兜底。
 *
 * 不走"剥掉前缀再查一次"那条捷径：第三方插件里叫 read / write 的工具会直接撞上
 * 内置工具的文案，把别人干的事说成是读写本地文件。
 *
 * 后端哪天在工具调用事件里带上 pluginId，这张表连同 isExternalTool 就能整块删掉。
 */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read', 'write', 'edit', 'grep', 'find', 'ls', 'bash', 'terminal', 'materialize',
  'exec_command', 'write_stdin',
  'search_memory', 'pin_memory', 'unpin_memory', 'recall_experience', 'record_experience',
  'web_search', 'web_fetch', 'todo_write', 'automation', 'stage_files', 'file', 'channel',
  'browser', 'computer', 'install_skill', 'notify', 'stop_task', 'update_settings',
  'session_folders', 'subagent', 'subagent_reply', 'subagent_close', 'workflow',
  'check_pending_tasks', 'loop_control', 'current_status', 'session',
  'luc_card_guide', 'show_card',
  'channel_read_context', 'channel_reply', 'channel_pass',
  'create_artifact', 'dm',
]);

export function isExternalTool(name: string): boolean {
  return !BUILTIN_TOOL_NAMES.has(name) && name.includes('_');
}

function resolveToolCopy(key: string, phase: ToolPhase, vars: Record<string, string>): string | null {
  const path = `tool.${key}.${phase}`;
  const value = window.t?.(path, vars);
  return value && value !== path ? value : null;
}

export function getToolLabel(
  name: string,
  phase: ToolPhase,
  agentName: string,
  args?: Record<string, unknown>,
): string {
  const vars = { name: agentName };
  const key = labelKeyFor(name, args);
  return resolveToolCopy(key, phase, vars)
    ?? (isExternalTool(name) ? resolveToolCopy('_plugin', phase, vars) : null)
    ?? resolveToolCopy('_fallback', phase, vars)
    ?? name;
}

/**
 * session 工具的目标会话，用来填工具行右侧那格。
 *
 * 只认 args 里的 sessionId，再从按 sessionId 索引的容器里查，不从当前焦点推导归属。
 * 查不到（会话已归档或不在列表里）返回 null，由调用方退回 id 短尾，不猜。
 */
export interface SessionTargetState {
  sessions?: Array<{ sessionId?: string | null; title?: string | null; agentName?: string | null }>;
  sessionLocatorsById?: Record<string, { path: string | null }>;
}

function targetSessionId(args?: Record<string, unknown>): string | null {
  const raw = args?.sessionId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export function sessionToolTargetName(
  state: SessionTargetState,
  args?: Record<string, unknown>,
): string | null {
  // create 还没有目标会话，args 里给的是要派给谁
  if (args?.action === 'create') {
    const agent = args?.agent;
    return typeof agent === 'string' && agent.trim() ? agent.trim() : null;
  }
  const sessionId = targetSessionId(args);
  if (!sessionId) return null;
  const found = (state.sessions || []).find((item) => item?.sessionId === sessionId);
  if (!found) return null;
  const parts = [found.agentName, found.title].filter((v): v is string => Boolean(v && v.trim()));
  return parts.length ? parts.join(' · ') : null;
}

export function sessionToolTargetPath(
  state: SessionTargetState,
  args?: Record<string, unknown>,
): string | null {
  if (args?.action === 'create') return null;
  const sessionId = targetSessionId(args);
  if (!sessionId) return null;
  return state.sessionLocatorsById?.[sessionId]?.path || null;
}

/** unknown 归到 done：工具已经不转了，说"正在忙碌"会一直挂着。 */
export function phaseForStatus(status: ToolStatus): ToolPhase {
  if (status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  return 'done';
}
