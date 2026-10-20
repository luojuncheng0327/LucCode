export function createApiResourceOperationContext({
  requestContext = null,
  requestId = null,
  sessionId = null,
  sessionPath = null,
  reason = null,
  principal = null,
} = {}) {
  const authPrincipal = principal && typeof principal === "object"
    ? principal
    : requestContext?.authPrincipal || {};
  const resolvedSessionId = stringOrNull(sessionId ?? authPrincipal.sessionId);
  const resolvedSessionPath = stringOrNull(sessionPath ?? authPrincipal.sessionPath);
  const resolvedRequestId = stringOrNull(requestId ?? authPrincipal.requestId);
  return {
    source: "api",
    ...(reason ? { reason } : {}),
    sessionId: resolvedSessionId,
    sessionPath: resolvedSessionPath,
    requestId: resolvedRequestId,
    principal: {
      kind: "api",
      userId: stringOrNull(requestContext?.userId ?? authPrincipal.userId),
      studioId: stringOrNull(requestContext?.studioId ?? authPrincipal.studioId),
      sessionId: resolvedSessionId,
      sessionPath: resolvedSessionPath,
      connectionKind: stringOrNull(requestContext?.connectionKind ?? authPrincipal.connectionKind),
      credentialKind: stringOrNull(requestContext?.credentialKind ?? authPrincipal.credentialKind),
      requestId: resolvedRequestId,
    },
  };
}

export function requestIdFromHono(c) {
  return stringOrNull(c?.req?.header?.("x-request-id")) || stringOrNull(c?.req?.header?.("x-correlation-id"));
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}
