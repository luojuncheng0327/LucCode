import { normalizePrincipal } from "../../core/security-principal.ts";
import {
  PluginSurfaceSessionError,
  verifyPluginSurfaceSession,
} from "../../core/plugin-surface-session-service.ts";
import {
  PLUGIN_SURFACE_SESSION_HEADER,
  PLUGIN_SURFACE_SESSION_QUERY,
} from "../../packages/plugin-protocol/src/index.ts";

export { PluginSurfaceSessionError };
export { PLUGIN_SURFACE_SESSION_HEADER, PLUGIN_SURFACE_SESSION_QUERY };

const CONNECTION_TRUST_STATES = Object.freeze({
  local: "local",
  lan: "lan",
  custom_remote: "tunnel",
});

/**
 * 尝试用 plugin surface session 凭证认证一个 /api/plugins/:pluginId/* 请求。
 *
 * 仅作为 HTTP 入口鉴权的后备：bearer / web session 凭证优先，只有主鉴权以
 * missing_credential 拒绝（凭证缺席）时才查 surface session（header 优先，
 * query 其次）——主凭证存在但无效（invalid_credential 等）时不得运行本后备，
 * 否则无效 bearer 会被附带的 surface token 静默掩盖；该 gate 由
 * server/http/request-principal.ts 强制。surface 凭证缺席返回 null（调用方
 * 维持原有 missing_credential 拒绝）；surface 凭证存在但无效抛
 * PluginSurfaceSessionError（调用方转 403 + 专属错误码，可定位）。
 *
 * 认证成功铸造 plugin principal：kind "plugin"、pluginId 绑定路径上的插件、
 * credentialKind "plugin_surface_session"、无任何 studio scope。该 principal
 * 只会被 route-security 的 plugin_route 策略放行到该插件自己的代理路径。
 */
export function authenticatePluginSurfaceRequest(c, engine, { connectionKind = null } = {}) {
  const routePath = new URL(c.req.url).pathname;
  const pluginId = pluginIdFromProxyPath(routePath);
  if (!pluginId) return null;
  const token = c.req.header(PLUGIN_SURFACE_SESSION_HEADER)
    || c.req.query(PLUGIN_SURFACE_SESSION_QUERY)
    || null;
  if (!token) return null;
  if (!engine?.luccodeHome) {
    throw new PluginSurfaceSessionError("plugin surface session storage unavailable", {
      code: "plugin_surface_session_unavailable",
      status: 500,
    });
  }
  const session = verifyPluginSurfaceSession({
    lucHome: engine.luccodeHome,
    pluginId,
    token,
  });
  return normalizePrincipal({
    kind: "plugin",
    pluginId: session.pluginId,
    credentialId: session.sessionId,
    credentialKind: "plugin_surface_session",
    connectionKind,
    trustState: CONNECTION_TRUST_STATES[connectionKind] || "unknown",
    scopes: [],
  });
}

function pluginIdFromProxyPath(routePath) {
  const match = /^\/api\/plugins\/([^/]+)\/.+$/.exec(String(routePath || ""));
  if (!match) return null;
  try {
    const pluginId = decodeURIComponent(match[1]);
    return pluginId || null;
  } catch {
    return null;
  }
}
