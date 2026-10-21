import { Buffer } from "node:buffer";
import process from "node:process";
import { CodemodeSandbox, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import {
  CODEMODE_LIMITS,
  CODEMODE_PROTOCOL_VERSION,
  CodeModeProtocolError,
  ByteBudget,
  encodeProtocolFrame,
  isJsonValue,
  isMessageType,
  isSafePositiveId,
  ProtocolFrameDecoder,
  writeProtocolBuffer,
} from "../codemode/protocol.mjs";

const decoder = new ProtocolFrameDecoder();
const outboundBudget = new ByteBudget();
const stderrLimit = CODEMODE_LIMITS.stderrBytes;
const reservedGlobals = new Set(["tools", "ALL_TOOLS", "console", "text", "image", "exit", "globalThis", "store", "load"]);
let stderrBytes = 0;
let started = false;
let terminal = false;
let sandbox;
const pending = new Map();
let nextCallId = 1;
let callsMade = 0;
let resourceLimit = false;
let closePromise;
let writeTail = Promise.resolve();

function diagnostic(message) {
  if (stderrBytes >= stderrLimit) return;
  let text = message instanceof Error ? `${message.name}: ${message.message}` : String(message);
  if (Buffer.byteLength(text) > stderrLimit - stderrBytes) {
    let limited = "";
    for (const char of text) {
      if (Buffer.byteLength(limited + char) > stderrLimit - stderrBytes - 1) break;
      limited += char;
    }
    text = limited;
  }
  const line = `${text}\n`;
  stderrBytes += Buffer.byteLength(line);
  process.stderr.write(line);
}

function send(message) {
  const frame = encodeProtocolFrame({ protocolVersion: CODEMODE_PROTOCOL_VERSION, ...message });
  outboundBudget.consume(frame.length);
  const write = writeTail.then(() => writeProtocolBuffer(process.stdout, frame));
  writeTail = write;
  return write;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validateStart(message) {
  if (!isMessageType(message, ["start"]) || !onlyKeys(message, ["type", "protocolVersion", "code", "tools", "globals", "timeoutMs"])) {
    throw new CodeModeProtocolError("Expected one valid start frame.");
  }
  if (typeof message.code !== "string" || Buffer.byteLength(message.code) > CODEMODE_LIMITS.sourceBytes) {
    throw new CodeModeProtocolError("Codemode source is invalid or exceeds 128 KiB.", "CODEMODE_RESOURCE_LIMIT");
  }
  if (!Number.isInteger(message.timeoutMs) || message.timeoutMs < 1 || message.timeoutMs > CODEMODE_LIMITS.timeoutMaxMs) {
    throw new CodeModeProtocolError("Codemode timeout is invalid.");
  }
  if (!Array.isArray(message.tools) || !Array.isArray(message.globals)) throw new CodeModeProtocolError("Tool and global metadata must be arrays.");

  const toolNames = new Set();
  const identifiers = new Map();
  for (const item of message.tools) {
    if (!isRecord(item) || !onlyKeys(item, ["name", "description"]) || typeof item.name !== "string" || item.name.length === 0
      || (item.description !== undefined && typeof item.description !== "string")) throw new CodeModeProtocolError("Invalid tool metadata.");
    if (toolNames.has(item.name)) throw new CodeModeProtocolError(`Duplicate tool name: ${item.name}.`);
    toolNames.add(item.name);
    const identifier = toCodemodeIdentifier(item.name);
    const prior = identifiers.get(identifier);
    if (prior !== undefined) throw new CodeModeProtocolError(`Tool names ${JSON.stringify(prior)} and ${JSON.stringify(item.name)} normalize to the same guest identifier.`, "CODEMODE_RESOURCE_LIMIT");
    if (Object.hasOwn(Object.prototype, identifier)) throw new CodeModeProtocolError(`Tool name ${JSON.stringify(item.name)} normalizes to a reserved guest property.`, "CODEMODE_PROTOCOL");
    identifiers.set(identifier, item.name);
  }

  const globalNames = new Set();
  const globalRoots = new Set();
  for (const item of message.globals) {
    if (!isRecord(item) || !onlyKeys(item, ["name", "description", "spread"]) || typeof item.name !== "string" || item.name.length === 0
      || (item.description !== undefined && typeof item.description !== "string")
      || (item.spread !== undefined && typeof item.spread !== "boolean")) throw new CodeModeProtocolError("Invalid global metadata.");
    const parts = item.name.split(".");
    if (parts.length > 2 || !parts.every((part) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) || reservedGlobals.has(parts[0])) {
      throw new CodeModeProtocolError(`Global name ${JSON.stringify(item.name)} is invalid or reserved.`);
    }
    if (globalNames.has(item.name)) throw new CodeModeProtocolError(`Duplicate global name: ${item.name}.`);
    if (toolNames.has(item.name)) throw new CodeModeProtocolError(`Tool/global name collision: ${item.name}.`);
    globalNames.add(item.name);
    if (parts.length === 2) globalRoots.add(parts[0]);
  }
  for (const item of message.globals) {
    const parts = item.name.split(".");
    if (parts.length === 1 && globalRoots.has(parts[0])) throw new CodeModeProtocolError(`Global ${JSON.stringify(item.name)} conflicts with a namespace.`);
  }
  return { code: message.code, timeoutMs: message.timeoutMs, tools: message.tools, globals: message.globals };
}

function failAndExit(error, code = 1) {
  if (terminal) return;
  terminal = true;
  diagnostic(error);
  void closeSandbox().finally(() => {
    process.exitCode = code;
    process.stdin.pause();
    process.stdin.destroy();
  });
}

function finishNormally() {
  terminal = true;
  process.exitCode = 0;
  process.stdin.pause();
  process.stdin.destroy();
}

function closeSandbox() {
  if (!closePromise) closePromise = sandbox ? sandbox.close().catch((error) => diagnostic(error)) : Promise.resolve();
  return closePromise;
}

function abortPending() {
  for (const item of pending.values()) {
    item.signal.removeEventListener("abort", item.onAbort);
    item.reject(new Error("Codemode execution ended."));
  }
  pending.clear();
}

function makeExecutor(target, meta) {
  return {
    name: meta.name,
    description: meta.description,
    ...(target === "global" && meta.spread !== undefined ? { spread: meta.spread } : {}),
    execute(args, { signal }) {
      if (terminal) return Promise.reject(new Error("Codemode worker is closing."));
      if (callsMade >= CODEMODE_LIMITS.callsPerRun) {
        resourceLimit = true;
        void closeSandbox();
        return Promise.reject(new Error("Codemode exceeded the per-run host-call limit."));
      }
      callsMade++;
      const id = nextCallId++;
      if (!Number.isSafeInteger(id)) {
        resourceLimit = true;
        void closeSandbox();
        return Promise.reject(new Error("Codemode call id space was exhausted."));
      }
      if (args !== undefined && !isJsonValue(args, CODEMODE_LIMITS.frameBytes)) {
        resourceLimit = true;
        void closeSandbox();
        return Promise.reject(new Error("Codemode host-call arguments exceed the protocol limit."));
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          pending.delete(id);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Codemode host call aborted."));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        pending.set(id, { resolve, reject, signal, onAbort });
        signal.addEventListener("abort", onAbort, { once: true });
        const message = {
          type: "call",
          id,
          target,
          name: meta.name,
          ...(args === undefined ? {} : { args }),
        };
        void send(message).catch((error) => {
          pending.delete(id);
          signal.removeEventListener("abort", onAbort);
          reject(error);
          failAndExit(error);
        });
      });
    },
  };
}

function handleReply(message) {
  if (!isMessageType(message, ["reply"]) || !onlyKeys(message, ["type", "protocolVersion", "id", "ok", "value", "error"])
    || !isSafePositiveId(message.id) || typeof message.ok !== "boolean") throw new CodeModeProtocolError("Invalid host reply frame.");
  const entry = pending.get(message.id);
  if (!entry) throw new CodeModeProtocolError("Host replied to an unknown or duplicate call id.");
  pending.delete(message.id);
  entry.signal.removeEventListener("abort", entry.onAbort);
  if (message.ok) {
    if (Object.hasOwn(message, "error") || (Object.hasOwn(message, "value") && !isJsonValue(message.value, CODEMODE_LIMITS.frameBytes))) {
      throw new CodeModeProtocolError("Host reply value is invalid or over limit.", "CODEMODE_RESOURCE_LIMIT");
    }
    entry.resolve(message.value);
    return;
  }
  if (typeof message.error !== "string" || Buffer.byteLength(message.error) > 4096 || Object.hasOwn(message, "value")) {
    throw new CodeModeProtocolError("Host reply error is invalid or over limit.");
  }
  entry.reject(new Error(message.error));
}

async function run(message) {
  if (started) throw new CodeModeProtocolError("Worker accepts exactly one start frame.");
  const config = validateStart(message);
  started = true;
  const tools = config.tools.map((meta) => makeExecutor("tool", meta));
  const globals = config.globals.map((meta) => makeExecutor("global", meta));
  sandbox = new CodemodeSandbox({
    timeoutMs: config.timeoutMs,
    memoryLimitBytes: CODEMODE_LIMITS.guestHeapBytes,
    tools,
    globals,
  });
  const result = await sandbox.execute(config.code, { timeoutMs: config.timeoutMs });
  await closeSandbox();
  if (terminal) return;
  abortPending();
  if (resourceLimit) {
    await send({ type: "result", ok: false, output: [], calls: [], error: { code: "resource_limit", message: "Codemode exceeded a configured per-run resource limit." } });
    finishNormally();
    return;
  }
  const output = Array.isArray(result.output) ? result.output : [];
  const calls = Array.isArray(result.calls) ? result.calls : [];
  if (calls.length > CODEMODE_LIMITS.callsPerRun) {
    await send({ type: "result", ok: false, output: [], calls: [], error: { code: "resource_limit", message: "Codemode result exceeds the call-summary limit." } });
    finishNormally();
    return;
  }
  const errorCode = result.ok ? undefined : result.error.kind === "timeout" ? "timeout" : result.error.kind === "aborted" ? "aborted" : "script";
  const response = result.ok
    ? { type: "result", ok: true, ...(result.value === undefined ? {} : { value: result.value }), output, calls }
    : { type: "result", ok: false, output, calls, error: { code: errorCode, message: result.error.message } };
  try {
    await send(response);
  } catch (error) {
    if (!(error instanceof CodeModeProtocolError) || error.code !== "CODEMODE_RESOURCE_LIMIT") throw error;
    await send({ type: "result", ok: false, output: [], calls: [], error: { code: "resource_limit", message: "Codemode result exceeds the protocol frame limit." } });
  }
  finishNormally();
}

function onData(chunk) {
  if (terminal) return;
  let frames;
  try {
    frames = decoder.push(chunk);
  } catch (error) {
    failAndExit(error);
    return;
  }
  for (const frame of frames) {
    if (terminal) return;
    if (!started) {
      void run(frame).catch((error) => {
        if (!started && error instanceof CodeModeProtocolError) {
          started = true;
          void send({ type: "result", ok: false, output: [], calls: [], error: { code: error.code === "CODEMODE_RESOURCE_LIMIT" ? "resource_limit" : "protocol", message: error.message } })
            .then(finishNormally)
            .catch(failAndExit);
          return;
        }
        failAndExit(error);
      });
      continue;
    }
    if (isMessageType(frame, ["cancel"]) && onlyKeys(frame, ["type", "protocolVersion"])) {
      terminal = true;
      abortPending();
      void closeSandbox().finally(() => { process.exitCode = 0; process.stdin.pause(); process.stdin.destroy(); });
      return;
    }
    try {
      handleReply(frame);
    } catch (error) {
      failAndExit(error);
      return;
    }
  }
}

process.stdin.on("data", onData);
process.stdin.on("end", () => {
  try { decoder.finish(); } catch (error) { failAndExit(error); return; }
  if (!terminal) {
    abortPending();
    void closeSandbox().finally(() => {
      terminal = true;
      process.exitCode = started ? 1 : 0;
    });
  }
});
process.stdin.on("error", (error) => failAndExit(error));
