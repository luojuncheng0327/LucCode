export const SESSION_PERMISSION_MODES = Object.freeze({
  AUTO: "auto",
  OPERATE: "operate",
  ASK: "ask",
  READ_ONLY: "read_only",
});

export const SESSION_APPROVAL_POLICIES = Object.freeze({
  INTERACTIVE: "interactive",
  DENY_ON_PROMPT: "deny_on_prompt",
  NEVER: "never",
});

export const DEFAULT_SESSION_PERMISSION_MODE = SESSION_PERMISSION_MODES.AUTO;
const BRIDGE_PERMISSION_MODE_VALUES = new Set([
  SESSION_PERMISSION_MODES.AUTO,
  SESSION_PERMISSION_MODES.OPERATE,
  SESSION_PERMISSION_MODES.READ_ONLY,
]);
const AUTOMATION_PERMISSION_MODE_VALUES = BRIDGE_PERMISSION_MODE_VALUES;

const INFORMATION_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "current_status",
  "search_memory",
  "recall_experience",
]);

const SIDE_EFFECT_TOOLS = new Set([
  "bash",
  "exec_command",
  "write_stdin",
  "write",
  "edit",
  "computer",
  "automation",
  "cron",
  "dm",
  "channel",
  "install_skill",
  "update_settings",
  "todo_write",
  "stage_files",
  "subagent",
  "workflow",
  "notify",
  "record_experience",
  "pin_memory",
  "unpin_memory",
]);

const AUTO_REVIEW_TOOLS = new Set([
  "automation",
  "browser",
  "channel",
  "dm",
  "notify",
  "pin_memory",
  "record_experience",
  "stage_files",
  "terminal",
  "write_stdin",
  "unpin_memory",
  "update_settings",
]);

// subagent 上下文固定边界（与 permission mode 无关）：哪怕 operate 也拦。收口在拦截层而非剥离——
// subagent 工具对模型仍可见，调用时被拦（Codex 式甲），保证缓存前缀统一。未来加禁用工具加到这里。
// 范畴：① 防自递归与间接扇出；② 长期记忆（subagent 不碰）；③ agent 一生/对外副作用。
// 不含 computer（有独立全局开关兜底）、search_memory/recall_experience（只读记忆，允许查）。
const SUBAGENT_BLOCKED_TOOLS = new Set([
  // ① 扇出
  "subagent",          // 防自递归
  "workflow",          // 间接扇出
  "session",           // 跨 session 扇出（触发别的 session 跑回合）
  // ② 长期记忆（与「subagent 不带长期记忆」原则一致：可读不可写）
  "pin_memory",
  "unpin_memory",
  "record_experience",
  // ③ agent 生命周期 / 对外副作用
  "automation",
  "cron",
  "channel",
  "dm",
  "notify",
  "install_skill",
  "update_settings",
  "session_folders",
  "loop_control",      // 循环归主会话管，子代理不得约闹钟/收束循环
]);

// session 工具（跨 session 协作）：读侧零副作用；send/create 的 execute 只产草稿卡，
// 真正副作用发生在用户点击确认卡之后——卡即权限关卡（spec 决策 3），
// 故不进 AUTO_REVIEW（LLM 审查双重把关且非确定，灰测已实证会误拒）。
const SESSION_COLLAB_READ_ACTIONS = new Set(["?", "list", "read"]);

const FILE_READ_ACTIONS = new Set([
  "stat",
]);

const DECLARED_READ_KINDS = new Set([
  "read",
  "readonly",
  "read_only",
]);

const DECLARED_AUTO_ALLOW_KINDS = new Set([
  "plugin_output",
  "session_file_output",
]);

const EXTERNAL_ROUTINE_TARGET_TYPES = new Set([
  "url",
  "browser_tab",
  "channel",
  "channel_draft",
  "agent",
  "notification_route",
]);

export function normalizeSessionPermissionMode(raw) {
  if (typeof raw === "string") return normalizeSessionPermissionMode({ permissionMode: raw });
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.AUTO) return SESSION_PERMISSION_MODES.AUTO;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.OPERATE) return SESSION_PERMISSION_MODES.OPERATE;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.ASK) return SESSION_PERMISSION_MODES.ASK;
  if (raw?.permissionMode === SESSION_PERMISSION_MODES.READ_ONLY) return SESSION_PERMISSION_MODES.READ_ONLY;
  if (raw?.accessMode === "operate") return SESSION_PERMISSION_MODES.OPERATE;
  if (raw?.accessMode === "read_only") return SESSION_PERMISSION_MODES.READ_ONLY;
  if (raw?.planMode === true) return SESSION_PERMISSION_MODES.READ_ONLY;
  return DEFAULT_SESSION_PERMISSION_MODE;
}

export function normalizeBridgePermissionMode(raw) {
  const source = typeof raw === "string" ? raw : raw?.permissionMode;
  if (BRIDGE_PERMISSION_MODE_VALUES.has(source)) return source;
  if (raw?.readOnly === true) return SESSION_PERMISSION_MODES.READ_ONLY;
  return SESSION_PERMISSION_MODES.AUTO;
}

export function normalizeAutomationPermissionMode(raw) {
  const source = typeof raw === "string" ? raw : raw?.permissionMode;
  if (AUTOMATION_PERMISSION_MODE_VALUES.has(source)) return source;
  return SESSION_PERMISSION_MODES.AUTO;
}

export function normalizeSessionApprovalPolicy(raw) {
  const source = typeof raw === "string" ? raw : raw?.approvalPolicy;
  if (source === SESSION_APPROVAL_POLICIES.INTERACTIVE) return SESSION_APPROVAL_POLICIES.INTERACTIVE;
  if (source === SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT) return SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT;
  if (source === SESSION_APPROVAL_POLICIES.NEVER) return SESSION_APPROVAL_POLICIES.NEVER;
  return SESSION_APPROVAL_POLICIES.INTERACTIVE;
}

export function resolveSessionApprovalPolicy({ mode, approvalPolicy, allowHumanApproval }: { mode?: any; approvalPolicy?: any; allowHumanApproval?: any } = {}) {
  const normalizedMode = normalizeSessionPermissionMode(mode);
  if (normalizedMode === SESSION_PERMISSION_MODES.OPERATE) return SESSION_APPROVAL_POLICIES.NEVER;
  if (normalizedMode === SESSION_PERMISSION_MODES.AUTO) return SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT;
  if (approvalPolicy != null) return normalizeSessionApprovalPolicy(approvalPolicy);
  if (allowHumanApproval === false) return SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT;
  return SESSION_APPROVAL_POLICIES.INTERACTIVE;
}

export function legacyAccessModeFromPermissionMode(mode) {
  return normalizeSessionPermissionMode(mode) === SESSION_PERMISSION_MODES.READ_ONLY ? "read_only" : "operate";
}

export function isReadOnlyPermissionMode(mode) {
  return normalizeSessionPermissionMode(mode) === SESSION_PERMISSION_MODES.READ_ONLY;
}

// 拦截分层（#1614）：deny 必须标明是哪一层拦的 + 怎么解锁，让模型/用户能自助走出去。
//   - subagent_blocklist：subagent 固定边界（任何档位都不可用）
//   - subagent_access：subagent 只读档（出路：access:"write" 重派 + 父会话可操作）
//   - conversation：conversation tool mode（出路：会话设置面板切到 write）
//   - session：普通会话只读档，如 plan 模式（出路：切换会话权限档）
function blocked(toolName, { code = "ACTION_BLOCKED_BY_READ_ONLY", message, layer = "session" }: { code?: string; message?: string; layer?: string } = {}) {
  return {
    action: "deny",
    code,
    message: message || `${toolName} is blocked in read-only mode.`,
    details: { toolName, layer },
  };
}

function blockedByReadOnly(toolName, context) {
  if (context?.isSubagent) {
    return blocked(toolName, {
      layer: "subagent_access",
      message: `${toolName} is blocked: this subagent runs in read-only mode. `
        + `For write access, re-dispatch the subagent with access:"write" — this requires the parent session to be in an operable (non read-only) mode; a subagent's permission can never exceed its parent session.`,
    });
  }
  if (context?.surface === "conversation") {
    return blocked(toolName, {
      layer: "conversation",
      message: `${toolName} is blocked: this conversation's tool permission is read-only. `
        + `The user can switch this conversation to write mode in its conversation settings panel.`,
    });
  }
  return blocked(toolName, {
    layer: "session",
    message: `${toolName} is blocked: this session is in read-only mode. `
      + `Switch the session permission mode out of read-only (e.g. leave plan mode) to use this tool.`,
  });
}

function prompt(toolName) {
  return {
    action: "prompt",
    kind: "tool_action_approval",
    details: { toolName },
  };
}

function review(toolName) {
  return {
    action: "review",
    kind: "tool_action_approval",
    details: { toolName },
  };
}

function declaredToolSessionPermission(context) {
  const value = context?.toolSessionPermission || context?.sessionPermission;
  return value && typeof value === "object" ? value : null;
}

function hasDeclaredPermissionBoundary(permission) {
  if (!permission) return false;
  return permission.readOnly === true
    || typeof permission.kind === "string"
    || permission.auto === "allow"
    || permission.auto === "review";
}

function isDeclaredReadOnly(permission) {
  if (!permission) return false;
  if (permission.readOnly === true) return true;
  return typeof permission.kind === "string" && DECLARED_READ_KINDS.has(permission.kind);
}

function isDeclaredAutoAllow(permission) {
  if (!permission) return false;
  if (permission.auto === "allow") return true;
  if (permission.auto === "review") return false;
  return typeof permission.kind === "string" && DECLARED_AUTO_ALLOW_KINDS.has(permission.kind);
}

function classifyDeclaredToolPermission(mode, toolName, context) {
  const permission = declaredToolSessionPermission(context);
  if (!hasDeclaredPermissionBoundary(permission)) return null;
  if (isDeclaredReadOnly(permission)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.OPERATE) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly(toolName, context);
  if (mode === SESSION_PERMISSION_MODES.AUTO) {
    return isDeclaredAutoAllow(permission) ? { action: "allow" } : review(toolName);
  }
  return prompt(toolName);
}

function classifyResolvedToolInvocation(mode, toolName, context) {
  const invocation = context?.toolInvocation;
  if (!invocation || typeof invocation !== "object") return null;
  if (invocation.kind === "read") return { action: "allow" };
  const routineIsHostPreAuthorized =
    invocation.kind === "routine"
    && Array.isArray(context?.preAuthorizedRoutineCapabilities)
    && context.preAuthorizedRoutineCapabilities.includes(invocation.capability);
  if (routineIsHostPreAuthorized) {
    return { action: "allow" };
  }
  // Session-scoped pre-authorization, granted by an explicit user decision
  // earlier in this same session. Unlike the routine list above this is
  // kind-agnostic: a "review" descriptor is precisely what the user was asked
  // about, so honouring the grant only for routine work would make it useless.
  // The capability string is the whole key, so a grant never widens past the
  // exact invocation it was issued for.
  const invocationIsSessionPreAuthorized =
    typeof invocation.capability === "string"
    && !!invocation.capability
    && Array.isArray(context?.preAuthorizedInvocationCapabilities)
    && context.preAuthorizedInvocationCapabilities.includes(invocation.capability);
  if (invocationIsSessionPreAuthorized) {
    return { action: "allow" };
  }
  if (mode === SESSION_PERMISSION_MODES.OPERATE) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly(toolName, context);
  // Codex-style Auto: actions already contained by the current workspace and
  // hard safety policy are routine work, so they continue without a reviewer.
  // Only boundary-crossing actions use automatic approval review.
  if (invocation.kind === "routine") {
    if (
      context?.isPluginTool === true
      || EXTERNAL_ROUTINE_TARGET_TYPES.has(invocation.target?.type)
    ) {
      return mode === SESSION_PERMISSION_MODES.AUTO
        ? review(toolName)
        : prompt(toolName);
    }
    return mode === SESSION_PERMISSION_MODES.AUTO
      ? { action: "allow" }
      : prompt(toolName);
  }
  if (mode === SESSION_PERMISSION_MODES.AUTO) {
    return review(toolName);
  }
  return prompt(toolName);
}

function classifyExecCommandAction(mode, params, context) {
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("exec_command", context);
  if (params?.tty === true) {
    if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("exec_command");
  }
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("exec_command");
  return { action: "allow" };
}

function classifySessionFoldersAction(mode, action, context) {
  if (action === "list") return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("session_folders", context);
  return { action: "allow" };
}

function classifyFileAction(mode, action, context) {
  if (FILE_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("file", context);
  if (mode === SESSION_PERMISSION_MODES.ASK) return prompt("file");
  return { action: "allow" };
}

function classifySessionCollabAction(mode, action, context) {
  if (SESSION_COLLAB_READ_ACTIONS.has(action)) return { action: "allow" };
  if (mode === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly("session", context);
  return { action: "allow" };
}

export function classifySessionPermission({ mode, toolName, params, context }: { mode?: any; toolName?: any; params?: any; context?: any } = {}) {
  let normalized = normalizeSessionPermissionMode(mode);
  const name = typeof toolName === "string" ? toolName : "";
  if (!name) return { action: "allow" };
  // subagent 上下文固定边界（与 mode 无关，优先于其它判定）：防自递归 + 禁越权工具。
  if (context?.isSubagent && SUBAGENT_BLOCKED_TOOLS.has(name)) {
    return blocked(name, {
      code: "ACTION_BLOCKED_IN_SUBAGENT",
      layer: "subagent_blocklist",
      message: `${name} is not available inside a subagent. `
        + `This tool is always blocked in subagent context regardless of access level; perform this action from the parent session instead.`,
    });
  }
  const resolvedInvocation = classifyResolvedToolInvocation(normalized, name, context);
  if (resolvedInvocation) return resolvedInvocation;
  const declared = classifyDeclaredToolPermission(normalized, name, context);
  if (declared) return declared;
  if (INFORMATION_TOOLS.has(name)) return { action: "allow" };
  if (name === "exec_command") return classifyExecCommandAction(normalized, params, context);
  if (name === "session_folders") return classifySessionFoldersAction(normalized, params?.action, context);
  if (name === "file") return classifyFileAction(normalized, params?.action, context);
  if (name === "session") return classifySessionCollabAction(normalized, params?.action, context);
  if (name === "computer") {
    if (normalized === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly(name, context);
    return { action: "allow" };
  }
  if (normalized === SESSION_PERMISSION_MODES.OPERATE) return { action: "allow" };
  if (normalized === SESSION_PERMISSION_MODES.READ_ONLY) return blockedByReadOnly(name, context);
  if (normalized === SESSION_PERMISSION_MODES.AUTO) {
    if (AUTO_REVIEW_TOOLS.has(name)) return review(name);
    if (SIDE_EFFECT_TOOLS.has(name)) return { action: "allow" };
    return review(name);
  }
  if (SIDE_EFFECT_TOOLS.has(name)) return prompt(name);
  return prompt(name);
}
