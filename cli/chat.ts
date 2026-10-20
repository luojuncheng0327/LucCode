import readline from "readline";
import { createTerminalTheme, ansi, paint } from "./terminal-theme.ts";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createCliChatPromptMessage(identity, text) {
  const sessionId = nonEmptyString(identity?.sessionId);
  const sessionPath = nonEmptyString(identity?.sessionPath);
  if (!sessionId || !sessionPath || typeof text !== "string") return null;
  return { type: "prompt", text, sessionId, sessionPath };
}

export function createCliChatAbortMessage(identity) {
  const sessionId = nonEmptyString(identity?.sessionId);
  const sessionPath = nonEmptyString(identity?.sessionPath);
  const streamId = nonEmptyString(identity?.streamId);
  if (!sessionId || !sessionPath || !streamId) return null;
  return { type: "abort", sessionId, sessionPath, streamId };
}

export function cliChatMessageMatchesSession(identity, msg) {
  const sessionId = nonEmptyString(identity?.sessionId);
  const sessionPath = nonEmptyString(identity?.sessionPath);
  const messageSessionId = nonEmptyString(msg?.sessionId);
  const messageSessionPath = nonEmptyString(msg?.sessionPath);
  if (sessionId && messageSessionId && messageSessionId !== sessionId) return false;
  if (sessionPath && messageSessionPath && messageSessionPath !== sessionPath) return false;
  return true;
}

export function reduceCliChatStreamIdentity(current, msg) {
  const state = {
    sessionId: nonEmptyString(current?.sessionId),
    sessionPath: nonEmptyString(current?.sessionPath),
    streamId: nonEmptyString(current?.streamId),
    isStreaming: current?.isStreaming === true,
  };
  if (!cliChatMessageMatchesSession(state, msg)) return state;

  const messageStreamId = nonEmptyString(msg?.streamId);
  if (msg?.type === "abort_rejected") {
    return messageStreamId
      ? { ...state, streamId: messageStreamId, isStreaming: true }
      : state;
  }
  if (msg?.type === "status") {
    if (msg.isStreaming === true && messageStreamId) {
      return { ...state, streamId: messageStreamId, isStreaming: true };
    }
    if (msg.isStreaming === false) {
      if (state.streamId && (!messageStreamId || messageStreamId !== state.streamId)) return state;
      return { ...state, streamId: null, isStreaming: false };
    }
  }
  if (msg?.type === "turn_end") {
    if (state.streamId && (!messageStreamId || messageStreamId !== state.streamId)) return state;
    return { ...state, streamId: null, isStreaming: false };
  }
  if (msg?.type === "error") {
    if (state.streamId && messageStreamId && messageStreamId !== state.streamId) return state;
    return { ...state, streamId: null, isStreaming: false };
  }
  if (messageStreamId) {
    return { ...state, streamId: messageStreamId, isStreaming: true };
  }
  return state;
}

export async function printStatus(client, connection) {
  const [health, identity] = await Promise.all([
    client.health(),
    client.identity().catch(() => null),
  ]);
  const theme = createTerminalTheme(health.agentYuan);
  console.log(`${paint(theme, theme.symbol)} LucCode Server`);
  console.log(`  ${ansi.dim}URL${ansi.reset}       ${connection.baseUrl}`);
  console.log(`  ${ansi.dim}Version${ansi.reset}   ${identity?.version || health.version || "unknown"}`);
  console.log(`  ${ansi.dim}Studio${ansi.reset}    ${identity?.studioLabel || identity?.studioId || "local"}`);
  console.log(`  ${ansi.dim}Agent${ansi.reset}     ${health.agent || "Agent"} · ${theme.yuan} · ${theme.symbol}`);
  console.log(`  ${ansi.dim}Model${ansi.reset}     ${health.model || "not set"}`);
  console.log(`  ${ansi.dim}Auth${ansi.reset}      ${identity?.credentialKind || connection.source || "unknown"}`);
}

export async function printSessions(client, { limit = 20 } = {}) {
  const sessions = await client.sessions();
  if (!sessions.length) {
    console.log(`${ansi.dim}No sessions yet.${ansi.reset}`);
    return [];
  }
  for (const [idx, session] of sessions.slice(0, limit).entries()) {
    console.log(formatSessionLine(session, idx + 1));
  }
  return sessions;
}

export async function startChat(client, connection, opts: { session?: any; target?: any; plain?: boolean } = {}) {
  const ctx = await loadContext(client);
  let theme = createTerminalTheme(ctx.agentYuan);
  let session = await resolveChatSession(client, opts.session || opts.target);
  let sessionPath = session.path;
  let sessionId = session.sessionId || null;
  const ws = client.createWebSocket();
  const plain = opts.plain === true || !process.stdin.isTTY;

  let streaming = false;
  let activeStreamId = null;
  let abortRequestedStreamId = null;
  let currentMood = "";
  let thinkingTimer = null;
  let thinkingFrame = 0;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "",
  });

  function renderHeader() {
    console.log("");
    console.log(`${paint(theme, theme.symbol)} ${ctx.agentName} ${ansi.dim}· ${theme.yuan} · ${connection.baseUrl}${ansi.reset}`);
    console.log(`${ansi.dim}Session · ${session.title || session.firstMessage || session.path}${ansi.reset}`);
    console.log(`${ansi.dim}Type /help for commands.${plain ? " Plain mode is line-oriented." : " Ctrl+C aborts or exits."}${ansi.reset}\n`);
  }

  function prompt() {
    process.stdout.write(`${paint(theme, ctx.userName || "you")} ${ansi.dim}›${ansi.reset} `);
  }

  function startThinking() {
    if (thinkingTimer) return;
    const frames = [
      `${theme.symbol} ${ctx.agentName} 正在思考`,
      `${theme.symbol} ${ctx.agentName} 正在整理上下文`,
      `${theme.symbol} ${ctx.agentName} 正在看工具轨迹`,
    ];
    const tick = () => {
      const text = frames[thinkingFrame++ % frames.length];
      process.stdout.write(`\r${ansi.dim}${text}${".".repeat((thinkingFrame % 3) + 1)}${ansi.reset}\x1b[K`);
    };
    tick();
    thinkingTimer = setInterval(tick, 500);
  }

  function stopThinking() {
    if (!thinkingTimer) return;
    clearInterval(thinkingTimer);
    thinkingTimer = null;
    process.stdout.write("\r\x1b[K");
  }

  async function refreshTheme() {
    const next = await loadContext(client).catch(() => null);
    if (!next) return;
    ctx.agentName = next.agentName;
    ctx.userName = next.userName;
    ctx.agentYuan = next.agentYuan;
    theme = createTerminalTheme(ctx.agentYuan);
  }

  async function switchTo(target) {
    session = await resolveChatSession(client, target);
    sessionPath = session.path;
    sessionId = session.sessionId || null;
    activeStreamId = null;
    abortRequestedStreamId = null;
    streaming = false;
    await refreshTheme();
    console.log(`${ansi.dim}Continued session:${ansi.reset} ${session.title || session.firstMessage || session.path}`);
    prompt();
  }

  async function handleCommand(line) {
    const [cmd, ...parts] = line.slice(1).trim().split(/\s+/);
    if (cmd === "q" || cmd === "quit" || cmd === "exit") {
      closeAndExit(0);
      return;
    }
    if (cmd === "help" || cmd === "h") {
      console.log(`
${paint(theme, "/sessions")}          list recent sessions
${paint(theme, "/continue <n|path>")} continue a session
${paint(theme, "/new")}               create a new session
${paint(theme, "/status")}            show server status
${paint(theme, "/quit")}              exit
`);
      prompt();
      return;
    }
    if (cmd === "sessions") {
      await printSessions(client);
      prompt();
      return;
    }
    if (cmd === "continue") {
      await switchTo(parts.join(" "));
      return;
    }
    if (cmd === "new") {
      const created = await client.newSession();
      session = {
        ...created,
        path: created.path,
        title: null,
        firstMessage: "",
      };
      sessionPath = created.path;
      sessionId = created.sessionId || null;
      activeStreamId = null;
      abortRequestedStreamId = null;
      streaming = false;
      console.log(`${paint(theme, theme.symbol)} New session`);
      prompt();
      return;
    }
    if (cmd === "status") {
      await printStatus(client, connection);
      prompt();
      return;
    }
    console.log(`${ansi.dim}Unknown command: /${cmd}${ansi.reset}`);
    prompt();
  }

  function closeAndExit(code) {
    try { ws.close(); } catch {}
    try { rl.close(); } catch {}
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    process.exit(code);
  }

  ws.on("open", () => {
    renderHeader();
    prompt();
  });

  ws.on("message", async (data) => {
    const msg = safeParse(data.toString());
    if (!msg) return;
    if (msg.type === "app_event" && (
      msg.event?.type === "agent-switched"
      || msg.event?.type === "agent-updated"
    )) {
      await refreshTheme();
      return;
    }
    if (!cliChatMessageMatchesSession({ sessionId, sessionPath }, msg)) return;
    const wasStreaming = streaming;
    const tracked = reduceCliChatStreamIdentity({
      sessionId,
      sessionPath,
      streamId: activeStreamId,
      isStreaming: streaming,
    }, msg);
    activeStreamId = tracked.streamId;
    streaming = tracked.isStreaming;
    switch (msg.type) {
      case "text_delta":
        stopThinking();
        if (!wasStreaming) {
          process.stdout.write("\n");
        }
        process.stdout.write(msg.delta || "");
        break;
      case "mood_start":
        currentMood = "";
        break;
      case "mood_text":
        currentMood += msg.delta || "";
        break;
      case "mood_end":
        if (currentMood.trim()) {
          process.stdout.write(`\n${theme.accent}${ansi.italic}${theme.moodLabel}${ansi.reset} ${ansi.dim}${currentMood.trim()}${ansi.reset}\n`);
        }
        currentMood = "";
        break;
      case "thinking_start":
        startThinking();
        break;
      case "thinking_end":
        stopThinking();
        break;
      case "tool_start":
        stopThinking();
        process.stdout.write(`\n${theme.accent}◇${ansi.reset} ${ansi.dim}${msg.name || "tool"}${ansi.reset}`);
        break;
      case "tool_end":
        process.stdout.write(msg.success === false ? ` ${ansi.red}failed${ansi.reset}\n` : ` ${ansi.green}done${ansi.reset}\n`);
        break;
      case "turn_end":
        if (streaming) return;
        stopThinking();
        abortRequestedStreamId = null;
        process.stdout.write("\n");
        prompt();
        break;
      case "error":
        if (streaming) return;
        stopThinking();
        abortRequestedStreamId = null;
        process.stdout.write(`\n${ansi.red}${msg.message || "error"}${ansi.reset}\n`);
        prompt();
        break;
      case "status":
        if (!streaming) {
          stopThinking();
          abortRequestedStreamId = null;
        }
        break;
      case "abort_rejected":
        abortRequestedStreamId = null;
        process.stdout.write(`\n${ansi.yellow}Stop request ignored because the active stream changed.${ansi.reset}\n`);
        break;
      default:
        break;
    }
  });

  ws.on("close", () => {
    stopThinking();
    console.log(`\n${ansi.dim}Disconnected.${ansi.reset}`);
    closeAndExit(0);
  });

  ws.on("error", (err) => {
    stopThinking();
    console.error(`\n${ansi.red}${err.message}${ansi.reset}`);
  });

  rl.on("line", async (input) => {
    const line = input.trim();
    if (!line) {
      prompt();
      return;
    }
    if (streaming) return;
    try {
      if (line.startsWith("/")) {
        await handleCommand(line);
        return;
      }
      const message = createCliChatPromptMessage({ sessionId, sessionPath }, line);
      if (!message) throw new Error("Session identity unavailable; reconnect or choose another session.");
      ws.send(JSON.stringify(message));
    } catch (err) {
      console.log(`${ansi.red}${err.message}${ansi.reset}`);
      prompt();
    }
  });

  readline.emitKeypressEvents(process.stdin, rl);
  if (!plain && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    const requestAbort = () => {
      const message = createCliChatAbortMessage({ sessionId, sessionPath, streamId: activeStreamId });
      if (!message) {
        process.stdout.write(`\n${ansi.yellow}Stop unavailable until the active stream identity is known.${ansi.reset}\n`);
        return false;
      }
      if (abortRequestedStreamId === message.streamId) return true;
      ws.send(JSON.stringify(message));
      abortRequestedStreamId = message.streamId;
      process.stdout.write(`\n${ansi.dim}Stop requested…${ansi.reset}\n`);
      return true;
    };
    process.stdin.on("keypress", (_str, key) => {
      if (!key) return;
      if (key.name === "escape" && streaming) {
        requestAbort();
      }
      if (key.ctrl && key.name === "c") {
        if (streaming) {
          requestAbort();
        } else {
          closeAndExit(0);
        }
      }
    });
  }
}

async function loadContext(client) {
  const [health, agentsResult] = await Promise.all([
    client.health(),
    client.agents().catch(() => ({ agents: [] })),
  ]);
  const agents = Array.isArray(agentsResult.agents) ? agentsResult.agents : [];
  const current = agents.find((agent) => agent.id === health.agentId)
    || agents.find((agent) => agent.name === health.agent)
    || agents[0]
    || null;
  return {
    agentId: health.agentId || current?.id || null,
    agentName: health.agent || current?.name || "Luc",
    agentYuan: health.agentYuan || current?.yuan || "luc",
    userName: health.user || "you",
  };
}

async function resolveChatSession(client, target) {
  if (target) {
    const sessions = await client.sessions();
    const found = selectSession(sessions, target);
    if (!found) throw new Error(`Session not found: ${target}`);
    await client.switchSession(found.path);
    return found;
  }

  const sessions = await client.sessions();
  if (sessions[0]) {
    await client.switchSession(sessions[0].path);
    return sessions[0];
  }
  const created = await client.newSession();
  return { ...created, path: created.path, title: null, firstMessage: "" };
}

export function selectSession(sessions, target) {
  if (!target) return sessions[0] || null;
  const trimmed = String(target).trim();
  const maybeIndex = Number.parseInt(trimmed, 10);
  if (String(maybeIndex) === trimmed && maybeIndex > 0) {
    return sessions[maybeIndex - 1] || null;
  }
  return sessions.find((session) => session.path === trimmed) || null;
}

export function formatSessionLine(session, index) {
  const title = session.title || session.firstMessage || "Untitled";
  const agent = session.agentName || session.agentId || "Agent";
  const modified = session.modified ? new Date(session.modified).toLocaleString() : "";
  return `${ansi.dim}${String(index).padStart(2, " ")}.${ansi.reset} ${title.slice(0, 72)} ${ansi.dim}· ${agent}${modified ? ` · ${modified}` : ""}${ansi.reset}`;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
