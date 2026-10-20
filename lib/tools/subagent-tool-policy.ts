/**
 * subagent-tool-policy.js —— subagent 工具访问策略的唯一决策点（收口）
 *
 * 「subagent 能拿哪些工具、按什么权限档跑」只在这里决定。未来要改方向
 * （甲 拦截 ↔ 乙 剥离）或做性能 A/B，只动这一处（build-to-delete）。
 *
 * 甲 intercept（Codex 式，默认）：给全集工具，限制全在拦截层（classify by mode + subagent 上下文）。
 *   工具对模型始终可见、运行时切只读↔操作不动清单 → 一个 agent 的所有 subagent 共享同一缓存前缀。
 * 乙 strip（Claude Code 式）：按权限档剥离工具清单（白名单）。模型只看见可用工具，但每档一份前缀。
 *
 * 性能 A/B：env LUC_SUBAGENT_TOOL_STRATEGY = "intercept"（默认）| "strip"。
 *
 * 权限档（Codex 式）由两路决定，优先级：显式 access 参数 > 继承父会话档。
 *   - access==="read"  → READ_ONLY（探索/调研/审查：只读，禁改文件、跑命令）
 *   - access==="write" → OPERATE（执行/修改：可操作）——仅当父会话非只读；
 *     父只读时显式 write 抛 SubagentAccessDeniedError（attenuation：子权限不得超过父，
 *     #1614。不静默降级成 read——模型以为能写会行为混乱，必须显式报错给出路）
 *   - 省略 / 非法值     → 继承父会话当前档（见 resolveInheritedMode：subagent 只有两态）
 *
 * 未来方向（暂不做）：approval forwarding——子会话的确认请求（ask/review）冒泡到父 session
 * 问人（Claude Code 有此通道）。目前 subagent 是无人交互的后台任务，只有只读/可操作两态；
 * 若引入 forwarding，resolveInheritedMode 的 ASK 坍缩与本文件的两态假设都要重新设计。
 */
import {
  SESSION_PERMISSION_MODES,
  isReadOnlyPermissionMode,
  normalizeSessionPermissionMode,
} from "../../core/session-permission-mode.ts";

// 乙策略用的精选集（= 收口前 subagent 的现状）。仅 strip 策略下生效。
const STRIP_CUSTOM_TOOLS = ["web_search", "web_fetch", "todo_write", "browser"];
const STRIP_BUILTIN_TOOLS = ["read", "write", "edit", "exec_command", "write_stdin", "grep", "find", "ls"];
const STRIP_BUILTIN_READONLY = ["read", "grep", "find", "ls"];

/** 当前策略：env 覆盖，默认甲（intercept）。便于性能 A/B。 */
export function resolveSubagentToolStrategy() {
  return process.env.LUC_SUBAGENT_TOOL_STRATEGY === "strip" ? "strip" : "intercept";
}

/**
 * 省略 access 时像 Codex 一样继承父会话档。后台任务无法交互确认这件事不在这里坍缩成
 * operate，而是在执行层通过 approvalPolicy:"deny_on_prompt" 返回结构化 unavailable。
 */
function resolveInheritedMode(parentPermissionMode) {
  if (parentPermissionMode == null) return SESSION_PERMISSION_MODES.OPERATE;
  return normalizeSessionPermissionMode(parentPermissionMode);
}

/**
 * attenuation 校验失败（#1614）：父会话只读时请求 access:"write"。
 * 调用方（subagent / subagent_reply 工具）捕获后转成给模型的本地化错误结果。
 */
export class SubagentAccessDeniedError extends Error {
  declare code: string;
  constructor() {
    super(
      "Cannot grant write access: the parent session is read-only, and a subagent's permission may not exceed its parent. "
      + "Switch the session to an operable mode and retry, or re-dispatch with access:\"read\".",
    );
    this.name = "SubagentAccessDeniedError";
    this.code = "SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY";
  }
}

function resolvePermissionMode(access, parentPermissionMode) {
  if (access === "read") return SESSION_PERMISSION_MODES.READ_ONLY;
  if (access === "write") {
    // 子不超父：父档只读时禁止授予写权限（显式报错，不静默降级）。
    if (isReadOnlyPermissionMode(parentPermissionMode)) throw new SubagentAccessDeniedError();
    return resolveInheritedMode(parentPermissionMode);
  }
  return resolveInheritedMode(parentPermissionMode);
}

/**
 * 解析一次 subagent 派单的工具访问策略。
 * @param {{
 *   access?: "read"|"write",       // 显式权限档（Codex 式），优先于继承
 *   parentPermissionMode?: string, // 省略 access 时继承的父会话档（operate/ask/read_only）
 *   strategy?: "intercept"|"strip",
 * }} [opts]
 * @returns {{
 *   strategy: "intercept"|"strip",
 *   customToolFilter: string[]|null,   // null = 不剥离自定义工具（给全集）
 *   builtinToolFilter: string[]|null,  // null = 不剥离内置工具（给全集）
 *   permissionMode: string,            // read → READ_ONLY，write → OPERATE，省略 → 继承
 *   subagentContext: boolean,          // 拦截层据此做固定边界（防自递归、禁越权工具）
 * }}
 * @throws {SubagentAccessDeniedError} access:"write" 且父会话只读（attenuation，#1614）
 */
export function resolveSubagentToolAccess({ access, parentPermissionMode, strategy }: { access?: string; parentPermissionMode?: string; strategy?: string } = {}) {
  const strat = strategy || resolveSubagentToolStrategy();
  const permissionMode = resolvePermissionMode(access, parentPermissionMode);
  const readOnly = permissionMode === SESSION_PERMISSION_MODES.READ_ONLY;

  if (strat === "strip") {
    // 乙：剥离工具清单（只读档再砍到 builtin 只读子集）。
    return {
      strategy: "strip",
      customToolFilter: STRIP_CUSTOM_TOOLS,
      builtinToolFilter: readOnly ? STRIP_BUILTIN_READONLY : STRIP_BUILTIN_TOOLS,
      permissionMode,
      subagentContext: true,
    };
  }

  // 甲（默认）：全集 + 拦截。filter=null → executeIsolated 不剥离，限制全交拦截层。
  return {
    strategy: "intercept",
    customToolFilter: null,
    builtinToolFilter: null,
    permissionMode,
    subagentContext: true,
  };
}
