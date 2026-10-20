// session 工具的用法手册。"?" 与参数校验报错共用同一份文本（报错即文档），
// 禁止在工具里另写第二份措辞。
export const SESSION_TOOL_ACTION_USAGE: Record<string, string> = {
  list: [
    'action:"list" — List formal desktop sessions.',
    "Optional: query (keyword; matches title first, then content).",
    "Each line: sessionId · title · agent · model · lastActive · streaming?",
    "Hidden subagent sessions are not listed, but read accepts their sessionId.",
  ].join("\n"),
  read: [
    'action:"read" — Progressive read of one session. Required: sessionId.',
    'mode:"summary" (default): returns the existing rolling summary only; never generates one.',
    'If no summary exists you get an explicit notice — switch to mode:"transcript".',
    'mode:"transcript": compact text, newest turns first page; tool calls folded to one line;',
    "media replaced by placeholders. Optional: count (turns per page, default 10),",
    "cursor (from previous page result) to read older turns.",
  ].join("\n"),
  send: [
    'action:"send" — Send a message to another session. Required: sessionId, message.',
    "This does NOT deliver immediately: it creates a draft card the user can edit,",
    "confirm, or ignore. Delivery is attributed to you as the agent (not the user).",
    "To learn whether the target replied, call read on that session later.",
    "Sending to the current session is rejected.",
  ].join("\n"),
  create: [
    'action:"create" — Create a formal desktop session for an agent and send the first message.',
    "Required: agent (agent id), message. Optional: model (provider/id), title.",
    "Creates a draft card first; the user can edit target agent, model, and message before confirming.",
  ].join("\n"),
};

export function sessionToolHandbook(): string {
  return [
    "# session tool",
    "Cross-session collaboration: list/read other sessions, send messages, create sessions.",
    "Reads are side-effect free. send/create only produce a confirmation card; the user",
    "may edit or reject it. All identity is by sessionId (never file paths).",
    "",
    SESSION_TOOL_ACTION_USAGE.list,
    "",
    SESSION_TOOL_ACTION_USAGE.read,
    "",
    SESSION_TOOL_ACTION_USAGE.send,
    "",
    SESSION_TOOL_ACTION_USAGE.create,
  ].join("\n");
}

export function sessionToolUsageError(action: string, reason: string): string {
  const usage = SESSION_TOOL_ACTION_USAGE[action];
  return usage ? `${reason}\n\n${usage}` : `${reason}\n\n${sessionToolHandbook()}`;
}
