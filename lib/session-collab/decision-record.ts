// 草稿卡决策的持久化记录：写入源 session JSONL 的 custom entry，
// /sessions/messages 重建 blocks 时按 suggestionId 覆盖 suggestion_card 的 status。
export const SESSION_COLLAB_DECISION_RECORD_TYPE = "luc-session-collab-decision";

export interface SessionCollabDecision {
  suggestionId: string;
  status: "approved" | "rejected";
  resultSessionId?: string | null; // create 成功时已建会话 id
  timestamp: number;
}

export function buildSessionCollabDecision(input: {
  suggestionId: string;
  status: "approved" | "rejected";
  resultSessionId?: string | null;
}): SessionCollabDecision {
  return {
    suggestionId: String(input.suggestionId),
    status: input.status === "approved" ? "approved" : "rejected",
    ...(input.resultSessionId ? { resultSessionId: input.resultSessionId } : {}),
    timestamp: Date.now(),
  };
}
