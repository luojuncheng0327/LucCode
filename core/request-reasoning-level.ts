/**
 * What reasoning level a request on a session carries.
 *
 * A live request and the compaction request for the same session ride one
 * provider cache prefix. If the two disagree about whether reasoning is on, or
 * at which level, the prefix diverges and the cache is silently lost: the
 * request still succeeds, it just costs a cold prefix and nothing reports it.
 * So the decision lives here once, and every path that needs an answer asks
 * this module rather than deciding for itself.
 *
 * Each caller still assembles its own inputs — the live pipeline reads the
 * session context and the user's preference, a compaction reads the level it is
 * compacting at — but the inputs meet in one place.
 *
 * The model's own reasoning capability is deliberately not consulted. The
 * provider modules already decide what a model that cannot reason does with a
 * requested level, and they do it for the live request too; second-guessing
 * them here is exactly how the two paths came apart.
 */

/** The thinking level the session is running at, or null when it says nothing. */
export function readSessionThinkingLevel(ctx) {
  try {
    const level = ctx?.sessionManager?.buildSessionContext?.()?.thinkingLevel;
    return typeof level === "string" ? level : null;
  } catch {
    return null;
  }
}

/**
 * The shared decision. The session's own level wins; the preference fills in
 * when the session has nothing to say, and overrides a session sitting at
 * "high" when the user asked for more than "high" is able to express.
 *
 * @param {{ sessionThinkingLevel?: string|null, preferenceThinkingLevel?: string|null }} levels
 * @returns {string|null} the reasoning level the request carries
 */
export function resolveRequestReasoningLevel({
  sessionThinkingLevel = null,
  preferenceThinkingLevel = null,
}: { sessionThinkingLevel?: string | null; preferenceThinkingLevel?: string | null } = {}) {
  const preferenceRequestsMax = preferenceThinkingLevel === "xhigh" || preferenceThinkingLevel === "max";
  return preferenceRequestsMax && sessionThinkingLevel === "high"
    ? preferenceThinkingLevel
    : (sessionThinkingLevel || preferenceThinkingLevel);
}

/**
 * The live pipeline's assembly: session context plus the user's preference,
 * with the model's own default standing in for an unset preference.
 */
export function resolveRequestReasoningLevelForContext(models, prefs, ctx) {
  const defaultThinkingLevel = typeof models.getModelDefaultThinkingLevel === "function"
    ? models.getModelDefaultThinkingLevel(ctx?.model || null, prefs.getThinkingLevel())
    : prefs.getThinkingLevel();
  return resolveRequestReasoningLevel({
    sessionThinkingLevel: readSessionThinkingLevel(ctx),
    preferenceThinkingLevel: models.resolveThinkingLevel(defaultThinkingLevel),
  });
}
