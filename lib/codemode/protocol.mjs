import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { clearImmediate, setImmediate } from "node:timers";

export const CODEMODE_PROTOCOL_VERSION = 1;

export const CODEMODE_LIMITS = Object.freeze({
  sourceBytes: 128 * 1024,
  frameBytes: 8 * 1024 * 1024,
  directionBytes: 32 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  callsPerRun: 64,
  concurrentHostCalls: 8,
  timeoutDefaultMs: 60_000,
  timeoutMaxMs: 120_000,
  childHeapMiB: 128,
  guestHeapBytes: 64 * 1024 * 1024,
  jsonNodes: 10_000,
  containerItems: 10_000,
  jsonDepth: 64,
  framesPerDirection: 128,
});

export class CodeModeProtocolError extends Error {
  constructor(message, code = "CODEMODE_PROTOCOL") {
    super(message);
    this.name = "CodeModeProtocolError";
    this.code = code;
  }
}

function jsonStringBytes(value, maxBytes) {
  let bytes = 2;
  for (const char of value) {
    const point = char.codePointAt(0);
    bytes += point === 0x22 || point === 0x5c || point === 0x08 || point === 0x09
      || point === 0x0a || point === 0x0c || point === 0x0d ? 2
      : point < 0x20 || (point >= 0xd800 && point <= 0xdfff) ? 6
      : Buffer.byteLength(char);
    if (bytes > maxBytes) throw new CodeModeProtocolError("Protocol frame exceeds the byte limit.", "CODEMODE_RESOURCE_LIMIT");
  }
  return bytes;
}

function boundedJsonClone(value, maxBytes, state = { seen: new Set(), nodes: 0 }, depth = 0) {
  if (depth > CODEMODE_LIMITS.jsonDepth) throw new CodeModeProtocolError("JSON nesting exceeds the protocol depth limit.", "CODEMODE_RESOURCE_LIMIT");
  if (++state.nodes > CODEMODE_LIMITS.jsonNodes) throw new CodeModeProtocolError("JSON node count exceeds the protocol limit.", "CODEMODE_RESOURCE_LIMIT");
  if (value === null) return { value, bytes: 4 };
  if (value === true) return { value, bytes: 4 };
  if (value === false) return { value, bytes: 5 };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CodeModeProtocolError("Non-finite numbers are not valid protocol values.");
    return { value, bytes: Buffer.byteLength(JSON.stringify(value)) };
  }
  if (typeof value === "string") return { value, bytes: jsonStringBytes(value, maxBytes) };
  if (typeof value !== "object") throw new CodeModeProtocolError("Protocol values must be JSON data.");
  if (state.seen.has(value)) throw new CodeModeProtocolError("Cyclic protocol values are not allowed.");
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new CodeModeProtocolError("Protocol objects must be plain JSON records.");
  }
  if (Object.getOwnPropertyDescriptor(value, "toJSON")) {
    throw new CodeModeProtocolError("toJSON properties are not protocol data.");
  }
  state.seen.add(value);
  let bytes = 2;
  let clone;
  if (array) {
    const length = value.length;
    if (!Number.isSafeInteger(length) || length > CODEMODE_LIMITS.containerItems || length > Math.floor(maxBytes / 5)) {
      throw new CodeModeProtocolError("Protocol array exceeds the item or byte limit.", "CODEMODE_RESOURCE_LIMIT");
    }
    clone = new Array(length);
    Object.setPrototypeOf(clone, null);
    for (let index = 0; index < length; index++) {
      if (index > 0) bytes++;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) {
        clone[index] = null;
        bytes += 4;
      } else {
        if (!("value" in descriptor)) throw new CodeModeProtocolError("Accessor properties are not protocol values.");
        const nested = boundedJsonClone(descriptor.value, maxBytes - bytes, state, depth + 1);
        clone[index] = nested.value;
        bytes += nested.bytes;
      }
      if (bytes > maxBytes) throw new CodeModeProtocolError("Protocol frame exceeds the byte limit.", "CODEMODE_RESOURCE_LIMIT");
    }
  } else {
    clone = Object.create(null);
    let index = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++index > CODEMODE_LIMITS.containerItems) throw new CodeModeProtocolError("Protocol object exceeds the item limit.", "CODEMODE_RESOURCE_LIMIT");
      if (++state.nodes > CODEMODE_LIMITS.jsonNodes) throw new CodeModeProtocolError("JSON node count exceeds the protocol limit.", "CODEMODE_RESOURCE_LIMIT");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) throw new CodeModeProtocolError("Accessor properties are not protocol values.");
      if (index > 1) bytes++;
      const keyBytes = jsonStringBytes(key, maxBytes - bytes);
      const nested = boundedJsonClone(descriptor.value, maxBytes - bytes - keyBytes - 1, state, depth + 1);
      clone[key] = nested.value;
      bytes += keyBytes + 1 + nested.bytes;
      if (bytes > maxBytes) throw new CodeModeProtocolError("Protocol frame exceeds the byte limit.", "CODEMODE_RESOURCE_LIMIT");
    }
  }
  state.seen.delete(value);
  return { value: clone, bytes };
}

export function encodeProtocolFrame(message) {
  const normalized = boundedJsonClone(message, CODEMODE_LIMITS.frameBytes - 1);
  const text = JSON.stringify(normalized.value);
  const jsonBytes = Buffer.byteLength(text);
  if (jsonBytes !== normalized.bytes || jsonBytes + 1 > CODEMODE_LIMITS.frameBytes) {
    throw new CodeModeProtocolError("Protocol frame exceeds the byte limit.", "CODEMODE_RESOURCE_LIMIT");
  }
  return Buffer.from(`${text}\n`, "utf8");
}

export class ByteBudget {
  #used = 0;
  #limit;
  constructor(limit = CODEMODE_LIMITS.directionBytes) {
    this.#limit = limit;
  }
  consume(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.#used + bytes > this.#limit) {
      throw new CodeModeProtocolError("Protocol direction exceeds the cumulative byte limit.", "CODEMODE_RESOURCE_LIMIT");
    }
    this.#used += bytes;
    return this.#used;
  }
  get used() { return this.#used; }
}

function assertJsonStructure(text, { nodeLimit, containerItemLimit, depthLimit }) {
  let index = 0;
  let nodes = 0;
  const failLimit = (message) => { throw new CodeModeProtocolError(message, "CODEMODE_RESOURCE_LIMIT"); };
  const failSyntax = (message) => { throw new CodeModeProtocolError(message); };
  const whitespace = () => {
    while ([9, 10, 13, 32].includes(text.charCodeAt(index))) index++;
  };
  const countNode = () => {
    if (++nodes > nodeLimit) failLimit("JSON node count exceeds the protocol limit.");
  };
  const scanString = () => {
    if (text.charCodeAt(index) !== 34) failSyntax("Invalid JSON string token.");
    countNode();
    index++;
    while (index < text.length) {
      const char = text.charCodeAt(index++);
      if (char === 34) return;
      if (char === 92) {
        if (index >= text.length) failSyntax("Incomplete JSON escape.");
        const escape = text.charCodeAt(index++);
        if (escape === 117) index += 4;
        if (index > text.length) failSyntax("Incomplete JSON unicode escape.");
      }
    }
    failSyntax("Unterminated JSON string.");
  };
  const scanValue = (depth) => {
    whitespace();
    const token = text.charCodeAt(index);
    countNode();
    if (token === 34) {
      nodes--;
      scanString();
      return;
    }
    if (token === 91 || token === 123) {
      if (depth + 1 > depthLimit) failLimit("JSON nesting exceeds the protocol depth limit.");
      const array = token === 91;
      const close = array ? 93 : 125;
      index++;
      whitespace();
      if (text.charCodeAt(index) === close) { index++; return; }
      let items = 0;
      while (index < text.length) {
        if (++items > containerItemLimit) failLimit("JSON container exceeds the item limit.");
        if (!array) {
          whitespace();
          scanString();
          whitespace();
          if (text.charCodeAt(index++) !== 58) failSyntax("Invalid JSON object member.");
        }
        scanValue(depth + 1);
        whitespace();
        if (text.charCodeAt(index) === close) { index++; return; }
        if (text.charCodeAt(index++) !== 44) failSyntax("Invalid JSON container separator.");
      }
      failSyntax("Unterminated JSON container.");
    }
    const start = index;
    while (index < text.length && ![9, 10, 13, 32, 44, 93, 125].includes(text.charCodeAt(index))) index++;
    if (start === index) index++;
  };
  scanValue(0);
  whitespace();
  if (index !== text.length) failSyntax("Trailing content after JSON value.");
}

export function writeProtocolBuffer(stream, buffer) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) {
      reject(new Error("Protocol output stream is closed."));
      return;
    }
    let callbackDone = false;
    let drainDone = false;
    let settled = false;
    let drainAttached = false;
    let errorFallback;
    const cleanup = () => {
      if (errorFallback) clearImmediate(errorFallback);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
      if (drainAttached) stream.removeListener("drain", onDrain);
    };
    const finish = () => {
      if (settled || !callbackDone || !drainDone) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onClose = () => fail(new Error("Protocol output stream closed before a write completed."));
    const onDrain = () => { drainDone = true; finish(); };
    stream.once("error", onError);
    stream.once("close", onClose);
    const accepted = stream.write(buffer, (error) => {
      if (error) {
        errorFallback = setImmediate(() => fail(error));
        return;
      }
      callbackDone = true;
      finish();
    });
    if (accepted) {
      drainDone = true;
      finish();
    } else {
      drainAttached = true;
      stream.once("drain", onDrain);
    }
  });
}

export class ProtocolFrameDecoder {
  #buffer = Buffer.alloc(0);
  #total = 0;
  #frameCount = 0;
  #frameLimit;
  #totalLimit;
  #frameCountLimit;
  #structureLimits;
  #decoder = new TextDecoder("utf-8", { fatal: true });
  constructor({
    frameLimit = CODEMODE_LIMITS.frameBytes,
    totalLimit = CODEMODE_LIMITS.directionBytes,
    frameCountLimit = CODEMODE_LIMITS.framesPerDirection,
    nodeLimit = CODEMODE_LIMITS.jsonNodes,
    containerItemLimit = CODEMODE_LIMITS.containerItems,
    depthLimit = CODEMODE_LIMITS.jsonDepth,
  } = {}) {
    this.#frameLimit = frameLimit;
    this.#totalLimit = totalLimit;
    this.#frameCountLimit = frameCountLimit;
    this.#structureLimits = { nodeLimit, containerItemLimit, depthLimit };
  }
  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.#total + bytes.length > this.#totalLimit) {
      throw new CodeModeProtocolError("Protocol direction exceeds the cumulative byte limit.", "CODEMODE_RESOURCE_LIMIT");
    }
    this.#total += bytes.length;
    const frames = [];
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline < 0 ? bytes.length : newline + 1;
      const piece = bytes.subarray(start, end);
      if (this.#buffer.length + piece.length > this.#frameLimit) {
        throw new CodeModeProtocolError("Protocol frame exceeds the byte limit.", "CODEMODE_RESOURCE_LIMIT");
      }
      if (newline < 0) {
        this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, piece]) : Buffer.from(piece);
        break;
      }
      const frame = this.#buffer.length ? Buffer.concat([this.#buffer, piece]) : piece;
      this.#buffer = Buffer.alloc(0);
      const body = frame.subarray(0, frame.length - 1);
      if (body.length === 0) throw new CodeModeProtocolError("Empty protocol frames are invalid.");
      if (this.#frameCount >= this.#frameCountLimit) {
        throw new CodeModeProtocolError("Protocol direction exceeds the frame-count limit.", "CODEMODE_RESOURCE_LIMIT");
      }
      this.#frameCount++;
      let parsed;
      try {
        const text = this.#decoder.decode(body);
        assertJsonStructure(text, this.#structureLimits);
        parsed = JSON.parse(text);
      } catch (error) {
        if (error instanceof CodeModeProtocolError && error.code === "CODEMODE_RESOURCE_LIMIT") throw error;
        throw new CodeModeProtocolError(`Invalid protocol JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CodeModeProtocolError("Protocol frames must contain JSON objects.");
      }
      frames.push(parsed);
      start = end;
    }
    return frames;
  }
  finish() {
    if (this.#buffer.length !== 0) throw new CodeModeProtocolError("Protocol stream ended with an incomplete frame.");
  }
  get totalBytes() { return this.#total; }
}

export function isMessageType(value, types) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.protocolVersion === CODEMODE_PROTOCOL_VERSION && types.includes(value.type));
}

export function isSafePositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function isJsonValue(value, maxBytes = CODEMODE_LIMITS.frameBytes) {
  try {
    boundedJsonClone(value, maxBytes);
    return true;
  } catch {
    return false;
  }
}
