import { projectKnownLegacyToolFailures } from "../../shared/tool-outcome.ts";

const adaptedAgents = new WeakSet<object>();

/**
 * Pi treats a normally returned tool value as success. Luc tools carry an
 * explicit isError bit on the returned value, so promote it before Pi's
 * existing extension hook observes the result.
 */
export function installToolOutcomeAdapter(session: any): void {
  const agent = session?.agent;
  if (!agent || adaptedAgents.has(agent)) return;

  const previousAfterToolCall = agent.afterToolCall;
  agent.afterToolCall = async (context: any, signal?: AbortSignal) => {
    const explicitFailure = context?.result?.isError === true;
    const promotedContext = explicitFailure && context?.isError !== true
      ? { ...context, isError: true }
      : context;
    const patch = typeof previousAfterToolCall === "function"
      ? await previousAfterToolCall(promotedContext, signal)
      : undefined;

    if (!explicitFailure) return patch;
    if (patch) {
      return {
        ...patch,
        isError: patch.isError ?? true,
      };
    }
    return {
      content: promotedContext.result?.content,
      details: promotedContext.result?.details,
      isError: true,
    };
  };

  const previousTransformContext = agent.transformContext;
  agent.transformContext = async (messages: unknown, signal?: AbortSignal) => {
    const transformed = typeof previousTransformContext === "function"
      ? await previousTransformContext(messages, signal)
      : messages;
    return projectKnownLegacyToolFailures(transformed);
  };
  adaptedAgents.add(agent);
}
