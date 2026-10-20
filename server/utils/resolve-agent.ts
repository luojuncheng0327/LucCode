/**
 * Resolve the target agent from a request.
 *
 * A request says which agent it is about, and this is the only way to find out.
 * There used to be a second version that fell back to whichever agent the
 * server was focused on when the request did not name one; with two clients
 * open on two different agents that guess was sometimes the other client's
 * agent, so a read could describe the wrong agent and a write could land on it.
 * It is gone, and tests/focus-fallback-agent-resolution.test.ts keeps it gone.
 *
 * A route whose agent is genuinely optional passes null onward rather than
 * substituting one.
 */

/** 强制要求显式 agentId，不做 fallback */
export function resolveAgentStrict(engine, c) {
  const explicit = c.req.query("agentId") || c.req.param("agentId");
  if (!explicit) {
    throw new AgentNotFoundError("(missing agentId)");
  }
  const found = engine.getAgent(explicit);
  if (!found) throw new AgentNotFoundError(explicit);
  return found;
}

export class AgentNotFoundError extends Error {
  declare status: number;
  declare agentId: any;
  constructor(id) {
    super(`agent "${id}" not found`);
    this.name = "AgentNotFoundError";
    this.status = 404;
    this.agentId = id;
  }
}
