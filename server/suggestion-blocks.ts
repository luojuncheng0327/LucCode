function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function buildAutomationSuggestionBlock({
  confirmId = "",
  suggestionId = "",
  suggestionShortCode = "",
  jobData,
  operation = "create",
  status = "pending",
}: {
  confirmId?: string;
  suggestionId?: string;
  suggestionShortCode?: string;
  jobData: Record<string, unknown>;
  operation?: "create" | "update";
  status?: "pending" | "approved" | "rejected";
}) {
  const executor = asRecord(jobData.executor);
  const agentId = text(jobData.actorAgentId) || text(executor.agentId);
  const prompt = text(jobData.prompt);
  const title = text(jobData.label) || prompt.slice(0, 50) || "Automation draft";
  return {
    type: "suggestion_card",
    kind: "automation_draft",
    ...(confirmId ? { confirmId } : {}),
    ...(suggestionId ? { suggestionId } : {}),
    ...(suggestionShortCode ? { suggestionShortCode } : {}),
    status,
    operation,
    title,
    description: prompt,
    target: agentId ? { type: "agent", id: agentId } : undefined,
    detail: {
      kind: "automation_draft",
      operation,
      jobData,
    },
    actions: [
      { id: "view", kind: "open" },
    ],
  };
}
