export function getAutomationExecutor(job) {
  if (job?.executor?.kind) return job.executor;
  return {
    kind: "agent_session",
    agentId: job?.actorAgentId || job?.legacyRef?.agentId || null,
    prompt: job?.prompt || "",
    model: job?.model,
    executionContext: job?.executionContext || null,
  };
}
