// WS 入站消息的 session/agent 身份唯一解析边界。
// 每个消息分支曾各自拼凑身份（查内存 map、读 msg 字段兜底），不变量散落在
// 分支里自守，加一个分支就漏一个。现在 dispatcher 在分发前解析一次，
// handler 只消费结果，禁止再读 msg.agentId 或自查 session 归属。
//
// 权威序：manifest currentLocator / ownership 为准，msg 携带的 path 只是
// 遗留定位器（无 manifest 的旧会话读时兼容），msg.agentId 只在服务端完全
// 不认识这个会话（草稿）时生效。
//
// 失败分级：
//   internal_contract           —— 调用方连身份都没带，是前端 bug，走通用文案
//   session_identity_mismatch   —— sessionId 与 sessionPath 指向不同会话
//   session_identity_unresolved —— 身份给了但映射不到当前 locator，或归属查询本身失败
//
// 三处查询都可能因为存储损坏抛错，一律记 warn 后再决定怎么降级——静默降级会让
// 存储故障看起来像"这个会话本来就这样"。定位类查询（路径反查、manifest）失败按
// 缺失处理仍可继续；归属查询失败必须整条拒掉，见下面 fail-closed 的注释。
import { createModuleLogger } from "../../lib/debug-log.ts";

const log = createModuleLogger("ws-session-context");

type WsSessionContextOk = {
  ok: true;
  sessionId: string | null;   // 无 manifest 的遗留路径会话为 null
  sessionPath: string;        // manifest currentLocator 优先
  agentId: string | null;     // ownership 权威；草稿会话取客户端显式值
  agentIdSource: "ownership" | "client" | "none";
  agentDeleted: boolean;
};
type WsSessionContextErr = {
  ok: false;
  code: "internal_contract" | "session_identity_mismatch" | "session_identity_unresolved";
  message: string;
  sessionId: string | null;
  sessionPath: string | null;
};

function normalized(value: any): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveWsSessionContext(
  engine: any,
  msg: any,
  { requireManifestLocator = false }: { requireManifestLocator?: boolean } = {},
): WsSessionContextOk | WsSessionContextErr {
  const requestedSessionId = normalized(msg?.sessionId);
  const rawPath = normalized(msg?.sessionPath);

  if (!requestedSessionId && !rawPath) {
    return {
      ok: false,
      code: "internal_contract",
      message: "session identity required",
      sessionId: null,
      sessionPath: null,
    };
  }

  let pathSessionId: string | null = null;
  if (rawPath) {
    try {
      pathSessionId = normalized(engine.getSessionIdForPath?.(rawPath));
    } catch (err: any) {
      log.warn(`getSessionIdForPath failed for ${rawPath}: ${err?.message || err}`);
      pathSessionId = null;
    }
  }
  if (requestedSessionId && pathSessionId && requestedSessionId !== pathSessionId) {
    return {
      ok: false,
      code: "session_identity_mismatch",
      message: "sessionId and sessionPath refer to different sessions",
      sessionId: requestedSessionId,
      sessionPath: rawPath,
    };
  }

  const sessionId = requestedSessionId || pathSessionId;
  let manifestPath: string | null = null;
  if (sessionId) {
    try {
      manifestPath = normalized(engine.getSessionManifest?.(sessionId)?.currentLocator?.path);
    } catch (err: any) {
      log.warn(`getSessionManifest failed for ${sessionId}: ${err?.message || err}`);
      manifestPath = null;
    }
  }
  // 客户端显式带了 sessionId 又带了 path 时，两者必须落在同一份 manifest 上。
  // manifest 缺失也算 mismatch：显式 id 主张的会话服务端拿不出对应定位，
  // 沿用既有的拒绝语义。
  if (requestedSessionId && rawPath && (!manifestPath || manifestPath !== rawPath)) {
    return {
      ok: false,
      code: "session_identity_mismatch",
      message: "sessionId and sessionPath refer to different sessions",
      sessionId: requestedSessionId,
      sessionPath: rawPath,
    };
  }

  const sessionPath = manifestPath || (requireManifestLocator ? null : rawPath);
  if (!sessionPath) {
    return {
      ok: false,
      code: "session_identity_unresolved",
      message: "Unable to resolve current session locator",
      sessionId,
      sessionPath: null,
    };
  }

  let ownership: any = null;
  try {
    ownership = engine.resolveSessionOwnership?.({ sessionId, sessionPath }) || null;
  } catch (err: any) {
    // 查不出归属 ≠ 没有归属。没有归属是草稿，可以让客户端说了算；查询失败是存储故障，
    // 这时候采信客户端的 agentId 等于连"这个 agent 已删除"的门禁一起放行了，
    // 所以整条请求拒掉，让调用方看到错误而不是拿到一个猜出来的身份。
    log.warn(`resolveSessionOwnership failed for ${sessionId || sessionPath}: ${err?.message || err}`);
    return {
      ok: false,
      code: "session_identity_unresolved",
      message: "Unable to resolve session ownership",
      sessionId,
      sessionPath,
    };
  }
  const ownerAgentId = normalized(ownership?.agentId);
  const clientAgentId = normalized(msg?.agentId);
  const agentId = ownerAgentId || clientAgentId;
  return {
    ok: true,
    sessionId,
    sessionPath,
    agentId,
    agentIdSource: ownerAgentId ? "ownership" : clientAgentId ? "client" : "none",
    agentDeleted: ownership?.agentDeleted === true,
  };
}
