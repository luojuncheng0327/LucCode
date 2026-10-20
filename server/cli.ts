/**
 * cli.js — 终端交互界面
 *
 * 服务器启动后自动附加。通过 WebSocket 与本机 server 通信，
 * 和 Electron 前端走完全一样的协议。
 */
import readline from "readline";
import WebSocket from "ws";
import { t } from "../lib/i18n.ts";
import { safeParseJSON } from "../shared/safe-parse.ts";

// ── 终端颜色 ──
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
};

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createCliAbortMessage(identity) {
  const sessionId = nonEmptyString(identity?.sessionId);
  const sessionPath = nonEmptyString(identity?.sessionPath);
  const streamId = nonEmptyString(identity?.streamId);
  if (!sessionId || !sessionPath || !streamId) return null;
  return { type: "abort", sessionId, sessionPath, streamId };
}

export function cliMessageMatchesSession(identity, msg) {
  const sessionId = nonEmptyString(identity?.sessionId);
  const sessionPath = nonEmptyString(identity?.sessionPath);
  const messageSessionId = nonEmptyString(msg?.sessionId);
  const messageSessionPath = nonEmptyString(msg?.sessionPath);
  if (messageSessionId && messageSessionId !== sessionId) return false;
  if (messageSessionPath && messageSessionPath !== sessionPath) return false;
  return true;
}

export function reduceCliStreamIdentity(current, msg) {
  const state = {
    sessionId: nonEmptyString(current?.sessionId),
    sessionPath: nonEmptyString(current?.sessionPath),
    streamId: nonEmptyString(current?.streamId),
    isStreaming: current?.isStreaming === true,
  };
  if (!cliMessageMatchesSession(state, msg)) return state;
  const messageStreamId = nonEmptyString(msg?.streamId);
  if (msg?.type === "status") {
    if (msg.isStreaming === true && messageStreamId) {
      return { ...state, streamId: messageStreamId, isStreaming: true };
    }
    if (msg.isStreaming === false) {
      if (state.streamId && (!messageStreamId || state.streamId !== messageStreamId)) return state;
      return { ...state, streamId: null, isStreaming: false };
    }
  }
  if (msg?.type === "turn_end") {
    if (state.streamId && (!messageStreamId || state.streamId !== messageStreamId)) return state;
    return { ...state, streamId: null, isStreaming: false };
  }
  if (messageStreamId) {
    return { ...state, streamId: messageStreamId, isStreaming: true };
  }
  return state;
}

/**
 * 从 /api/agents 的返回里挑出这个终端会话当前所在的 agent —— `agent switch`
 * 改的就是这个标记。挑出来之后所有 per-agent 请求都点名带上它的 id，不靠服务端
 * 替我们猜。列表为空时返回 null，让调用方自己决定怎么说，而不是凑一个出来。
 */
export function pickCliAgent(agents) {
  const list = Array.isArray(agents) ? agents : [];
  return list.find((a) => a?.isCurrent)
    || list.find((a) => a?.isPrimary)
    || list[0]
    || null;
}

/**
 * 判断 /api/agents 返回的某一条是不是"当前"这个 agent。标记在每个条目自己身上，
 * 返回体没有顶层的 currentAgentId 字段可读。
 */
export function isCurrentCliAgent(agent) {
  return agent?.isCurrent === true;
}

export function startCLI({ port, token, agentName, userName }) {
  const wsUrl = `ws://127.0.0.1:${port}/ws?token=${token}`;
  const apiBase = `http://127.0.0.1:${port}`;

  let ws = null;
  let isStreaming = false;
  let hasPrintedTurnOutput = false;
  let currentMood = "";
  let inMood = false;
  let inThinking = false;
  let sessionId = null;
  let sessionPath = null;
  let activeStreamId = null;

  // ── HTTP 工具 ──
  async function api(path, opts: any = {}) {
    const headers = { "Authorization": `Bearer ${token}`, ...opts.headers };
    if (opts.body && typeof opts.body === "object") {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${apiBase}${path}`, { ...opts, headers });
    return res.json();
  }

  // ── WebSocket ──
  function connect() {
    ws = new WebSocket(wsUrl);

    ws.on("open", async () => {
      // 获取当前 session 或创建新 session
      try {
        const sessions = await api("/api/sessions");
        if (sessions.length > 0) {
          sessionId = sessions[0].sessionId || null;
          sessionPath = sessions[0].path;
        } else {
          const data = await api("/api/sessions/new", { method: "POST" });
          sessionId = data.sessionId || null;
          sessionPath = data.path || null;
        }
      } catch (err) {
        console.error(`${c.red}${t("cli.error", { msg: err.message })}${c.reset}`);
      }
      showPrompt();
    });

    ws.on("message", (data) => {
      const msg = safeParseJSON(data.toString(), null);
      if (!msg) return;
      handleMessage(msg);
    });

    ws.on("close", () => {
      console.log(`
${c.dim}${t("cli.disconnected")}${c.reset}`);
      process.exit(0);
    });

    ws.on("error", (err) => {
      console.error(`${c.red}${t("cli.wsError", { msg: err.message })}${c.reset}`);
    });
  }

  // ── 消息处理 ──
  function handleMessage(msg) {
    if (!cliMessageMatchesSession({ sessionId, sessionPath }, msg)) return;
    const tracked = reduceCliStreamIdentity({
      sessionId,
      sessionPath,
      streamId: activeStreamId,
      isStreaming,
    }, msg);
    activeStreamId = tracked.streamId;
    if (msg.type === "status" || msg.type === "turn_end" || msg.streamId) {
      isStreaming = tracked.isStreaming;
    }
    if (msg.type === "turn_end" && tracked.isStreaming) return;
    switch (msg.type) {
      case "text_delta":
        if (!hasPrintedTurnOutput) {
          process.stdout.write("\n");
          hasPrintedTurnOutput = true;
        }
        isStreaming = true;
        process.stdout.write(msg.delta);
        break;

      case "mood_start":
        inMood = true;
        currentMood = "";
        break;

      case "mood_text":
        currentMood += msg.delta;
        break;

      case "mood_end":
        inMood = false;
        // 灰色显示 mood
        if (currentMood.trim()) {
          process.stdout.write(`${c.gray}${c.italic}`);
          for (const line of currentMood.trim().split("\n")) {
            process.stdout.write(`  ${line}\n`);
          }
          process.stdout.write(`${c.reset}`);
        }
        currentMood = "";
        break;

      case "thinking_start":
        inThinking = true;
        process.stdout.write(`${c.dim}  thinking...${c.reset}`);
        break;

      case "thinking_delta":
        // 不显示内容，只保持提示
        break;

      case "thinking_end":
        inThinking = false;
        // 清除 "thinking..." 行
        process.stdout.write("\r\x1b[K");
        break;

      case "tool_start":
        process.stdout.write(`\n${c.dim}  ⚙ ${msg.name}${c.reset}`);
        break;

      case "tool_end":
        if (msg.success === false) {
          process.stdout.write(` ${c.red}✗${c.reset}`);
        }
        process.stdout.write("\n");
        break;

      case "turn_end":
        isStreaming = false;
        activeStreamId = null;
        hasPrintedTurnOutput = false;
        process.stdout.write("\n");
        showPrompt();
        break;

      case "error":
        process.stdout.write(`
${c.red}${t("cli.error", { msg: msg.message })}${c.reset}
`);
        isStreaming = false;
        activeStreamId = null;
        hasPrintedTurnOutput = false;
        showPrompt();
        break;

      case "session_title":
        // 静默，不显示
        break;

      case "status":
        // 静默
        break;
    }
  }

  // ── 输入 ──
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "",
  });

  function showPrompt() {
    process.stdout.write(`${c.cyan}${userName}${c.reset} ${c.dim}›${c.reset} `);
  }

  function abortActiveStream() {
    const message = createCliAbortMessage({ sessionId, sessionPath, streamId: activeStreamId });
    if (!message || !ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  // 监听 ESC 键中断生成
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    // 自己处理按键，同时喂给 readline
    process.stdin.on("data", (key) => {
      const keyStr = key.toString();

      // ESC
      if (keyStr === "\x1b" && isStreaming) {
        if (!abortActiveStream()) return;
        process.stdout.write(`
${c.dim}${t("cli.interrupted")}${c.reset}
`);
        isStreaming = false;
        inThinking = false;
        hasPrintedTurnOutput = false;
        showPrompt();
        return;
      }

      // Ctrl+C
      if (keyStr === "\x03") {
        if (isStreaming) {
          if (!abortActiveStream()) return;
          isStreaming = false;
          inThinking = false;
          hasPrintedTurnOutput = false;
          process.stdout.write(`
${c.dim}${t("cli.interrupted")}${c.reset}
`);
          showPrompt();
        } else {
          console.log(`
${c.dim}${t("cli.goodbye")}${c.reset}`);
          process.exit(0);
        }
        return;
      }

      // Ctrl+D
      if (keyStr === "\x04") {
        console.log(`
${c.dim}${t("cli.goodbye")}${c.reset}`);
        process.exit(0);
      }

      // 其他按键喂给 readline
      rl.write(key);
    });
  }

  rl.on("line", async (input) => {
    const line = input.trim();
    if (!line) {
      showPrompt();
      return;
    }

    // 如果正在流式输出，忽略
    if (isStreaming) return;

    // 斜杠命令
    if (line.startsWith("/")) {
      await handleCommand(line);
      return;
    }

    // 发送消息
    if (!sessionId || !sessionPath) return;
    ws.send(JSON.stringify({ type: "prompt", text: line, sessionId, sessionPath }));
  });

  // ── 斜杠命令 ──
  async function handleCommand(line) {
    const [cmd, ...args] = line.slice(1).split(/\s+/);

    switch (cmd) {
      case "help":
      case "h":
        console.log(`
${c.bold}${t("cli.helpTitle")}${c.reset}
  ${c.cyan}/model${c.reset}              ${t("cli.helpModel")}
  ${c.cyan}/model set${c.reset}          ${t("cli.helpModelSet")}
  ${c.cyan}/config${c.reset}             ${t("cli.helpConfig")}
  ${c.cyan}/session new${c.reset}        ${t("cli.helpSessionNew")}
  ${c.cyan}/session list${c.reset}       ${t("cli.helpSessionList")}
  ${c.cyan}/agent${c.reset}              ${t("cli.helpAgent")}
  ${c.cyan}/agent list${c.reset}         ${t("cli.helpAgentList")}
  ${c.cyan}/agent switch <id>${c.reset}  ${t("cli.helpAgentSwitch")}
  ${c.cyan}/jian${c.reset}               ${t("cli.helpJian")}
  ${c.cyan}/jian <subdir>${c.reset}      ${t("cli.helpJianSub")}
  ${c.cyan}/ls${c.reset}                 ${t("cli.helpLs")}
  ${c.cyan}/ls <subdir>${c.reset}        ${t("cli.helpLsSub")}
  ${c.cyan}/cat <path>${c.reset}         ${t("cli.helpCat")}
  ${c.cyan}/help${c.reset}               ${t("cli.helpHelp")}
  ${c.dim}ESC${c.reset}                 ${t("cli.helpEsc")}
  ${c.dim}Ctrl+C${c.reset}              ${t("cli.helpCtrlC")}
`);
        showPrompt();
        break;

      case "model": {
        if (args[0] === "set") {
          const data = await api("/api/models");
          const models = data.models || [];
          if (!models.length) {
            console.log(`${c.yellow}${t("cli.noModels")}${c.reset}`);
            showPrompt();
            return;
          }
          console.log(`\n${c.bold}${t("cli.availableModels")}${c.reset}`);
          models.forEach((m, i) => {
            const current = m.isCurrent ? ` ${c.green}${t("cli.currentModel")}${c.reset}` : "";
            console.log(`  ${c.dim}${i + 1}.${c.reset} ${m.name}${current}`);
          });
          process.stdout.write(`\n${t("cli.selectModel")}`);
          rl.once("line", async (answer) => {
            const idx = parseInt(answer.trim()) - 1;
            if (idx >= 0 && idx < models.length) {
              await api("/api/models/set", {
                method: "POST",
                body: { modelId: models[idx].id, provider: models[idx].provider },
              });
              console.log(`${c.green}${t("cli.modelSwitched", { name: models[idx].name })}${c.reset}`);
            } else {
              console.log(`${c.dim}${t("cli.cancelled")}${c.reset}`);
            }
            showPrompt();
          });
          return;
        }
        const data = await api("/api/health");
        console.log(`${c.dim}${t("cli.currentModelLabel")}${c.reset} ${data.model || t("cli.noModel")}`);
        showPrompt();
        break;
      }

      case "config": {
        // Locale 和用户名是全局偏好；agent 的名字、缘、模型写在某个 agent
        // 自己的配置里，所以先问清楚这个终端在哪个 agent 上，再点名去要它的
        // 配置。用户名由 per-agent 读接口按全局值注入，这里跟着一起拿。
        const [globalConfig, agentList] = await Promise.all([
          api("/api/config"),
          api("/api/agents"),
        ]);
        const activeAgent = pickCliAgent(agentList.agents);
        const agentConfig = activeAgent
          ? await api(`/api/agents/${encodeURIComponent(activeAgent.id)}/config`)
          : {};
        console.log(`\n${c.bold}${t("cli.currentConfig")}${c.reset}`);
        console.log(`  ${c.dim}Agent:${c.reset}  ${agentConfig.agent?.name || "Luc"}`);
        console.log(`  ${c.dim}Yuan:${c.reset}   ${agentConfig.agent?.yuan || "luc"}`);
        console.log(`  ${c.dim}User:${c.reset}   ${agentConfig.user?.name || "User"}`);
        console.log(`  ${c.dim}Locale:${c.reset} ${globalConfig.locale || "en"}`);
        console.log(`  ${c.dim}Model:${c.reset}  ${agentConfig.api?.model || t("cli.notSet")}`);
        console.log();
        showPrompt();
        break;
      }

      case "session": {
        if (args[0] === "new") {
          const newData = await api("/api/sessions/new", { method: "POST" });
          if (newData.path && newData.sessionId) {
            sessionPath = newData.path;
            sessionId = newData.sessionId;
            activeStreamId = null;
            isStreaming = false;
            hasPrintedTurnOutput = false;
          }
          console.log(`${c.green}${t("cli.sessionCreated")}${c.reset}`);
          showPrompt();
        } else if (args[0] === "list") {
          const sessions = await api("/api/sessions");
          if (!sessions.length) {
            console.log(`${c.dim}${t("cli.noSessions")}${c.reset}`);
          } else {
            console.log(`\n${c.bold}${t("cli.sessionList")}${c.reset}`);
            for (const s of sessions.slice(0, 15)) {
              const title = s.title || s.firstMessage || t("cli.untitled");
              const date = s.modified ? new Date(s.modified).toLocaleDateString() : "";
              console.log(`  ${c.dim}${date}${c.reset}  ${title.slice(0, 60)}`);
            }
            console.log();
          }
          showPrompt();
        } else {
          console.log(`${c.dim}${t("cli.sessionUsage")}${c.reset}`);
          showPrompt();
        }
        break;
      }

      case "agent": {
        if (args[0] === "list") {
          const data = await api("/api/agents");
          console.log(`\n${c.bold}${t("cli.agentList")}${c.reset}`);
          for (const a of data.agents || []) {
            const current = isCurrentCliAgent(a) ? ` ${c.green}${t("cli.currentModel")}${c.reset}` : "";
            console.log(`  ${c.dim}${a.id}${c.reset}  ${a.name}${current}`);
          }
          console.log();
          showPrompt();
        } else if (args[0] === "switch" && args[1]) {
          const result = await api("/api/agents/switch", {
            method: "POST",
            body: { id: args[1] },
          });
          if (result.error) {
            console.log(`${c.red}${result.error}${c.reset}`);
          } else {
            agentName = result.agentName || args[1];
            console.log(`${c.green}${t("cli.agentSwitched", { name: agentName })}${c.reset}`);
          }
          showPrompt();
        } else {
          const data = await api("/api/health");
          console.log(`${c.dim}${t("cli.currentAgent")}${c.reset} ${data.agent || agentName}`);
          showPrompt();
        }
        break;
      }

      case "jian": {
        const subdir = args.join(" ");
        const query = subdir ? `?subdir=${encodeURIComponent(subdir)}` : "";
        const data = await api(`/api/desk/jian${query}`);
        if (data.content) {
          console.log(`\n${c.dim}── ${t("cli.jianTitle")}${subdir ? ` (${subdir})` : ""} ──${c.reset}`);
          console.log(data.content);
        } else {
          console.log(`${c.dim}${t("cli.jianEmpty")}${c.reset}`);
        }
        showPrompt();
        break;
      }

      case "ls": {
        const subdir = args.join(" ");
        const query = subdir ? `?subdir=${encodeURIComponent(subdir)}` : "";
        const data = await api(`/api/desk/files${query}`);
        if (data.error) {
          console.log(`${c.red}${data.error}${c.reset}`);
        } else if (!data.files?.length) {
          console.log(`${c.dim}${t("cli.dirEmpty")}${c.reset}`);
        } else {
          console.log(`\n${c.dim}${data.basePath}${subdir ? "/" + data.subdir : ""}${c.reset}`);
          for (const f of data.files) {
            const icon = f.isDir ? "📁" : "  ";
            const size = f.isDir ? "" : `  ${c.dim}${formatSize(f.size)}${c.reset}`;
            console.log(`  ${icon} ${f.name}${size}`);
          }
          console.log();
        }
        showPrompt();
        break;
      }

      case "cat": {
        const filePath = args.join(" ");
        if (!filePath) {
          console.log(`${c.dim}${t("cli.catUsage")}${c.reset}`);
          showPrompt();
          return;
        }
        try {
          const res = await fetch(`${apiBase}/api/fs/read?path=${encodeURIComponent(filePath)}`, {
            headers: { "Authorization": `Bearer ${token}` },
          });
          if (res.ok) {
            const text = await res.text();
            console.log(`\n${c.dim}── ${filePath} ──${c.reset}`);
            console.log(text);
          } else {
            console.log(`${c.red}${t("cli.catFailed", { status: res.status })}${c.reset}`);
          }
        } catch (err) {
          console.log(`${c.red}${t("cli.error", { msg: err.message })}${c.reset}`);
        }
        showPrompt();
        break;
      }

      default:
        console.log(`${c.dim}${t("cli.unknownCommand", { cmd })}${c.reset}`);
        showPrompt();
    }
  }

  // ── 启动 ──
  console.log(`\n${c.bold}${agentName}${c.reset} ${c.dim}CLI${c.reset}`);
  console.log(`${c.dim}${t("cli.inputHelp")}${c.reset}\n`);
  connect();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}
