import { getToolSessionPath } from "../tools/tool-session.ts";
import { randomBytes } from "node:crypto";
import { createWriteStream, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractExitCode,
  firstText,
  jsonResult,
  mergeExecDetails,
  textResult,
} from "./schema.ts";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const MAX_ROLLING_BYTES = DEFAULT_MAX_BYTES * 2;

function truncateText(text: string, maxOutputTokens: number) {
  const maxChars = Math.max(1000, Math.floor(maxOutputTokens * 4));
  if (String(text || "").length <= maxChars) return text;
  return String(text).slice(0, maxChars) + "\n\n[exec_command output truncated]";
}

function normalizeThrownToolError(err: any, maxOutputTokens: number) {
  if (err?.lucCommandBlockedResult) {
    return firstText(err.lucCommandBlockedResult);
  }
  const text = err?.message || String(err);
  return truncateText(text, maxOutputTokens);
}

function getTempFilePath() {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `luc-exec-command-${id}.log`);
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateStringToBytesFromEnd(str: string, maxBytes: number) {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.slice(start).toString("utf-8");
}

function truncateTail(content: string, {
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      maxLines,
      maxBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy = "lines";
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
        outputLinesArr.unshift(truncatedLine);
        outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
        lastLinePartial = true;
      }
      break;
    }
    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }
  const outputContent = outputLinesArr.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: Buffer.byteLength(outputContent, "utf-8"),
    lastLinePartial,
    maxLines,
    maxBytes,
  };
}

function isValidUtf8(buffer: Buffer) {
  for (let i = 0; i < buffer.length;) {
    const byte = buffer[i];
    if (byte <= 0x7f) {
      i++;
      continue;
    }

    let needed = 0;
    let min = 0;
    let codePoint = 0;
    if (byte >= 0xc2 && byte <= 0xdf) {
      needed = 1;
      min = 0x80;
      codePoint = byte & 0x1f;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      needed = 2;
      min = 0x800;
      codePoint = byte & 0x0f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      needed = 3;
      min = 0x10000;
      codePoint = byte & 0x07;
    } else {
      return false;
    }

    if (i + needed >= buffer.length) return false;
    for (let j = 1; j <= needed; j++) {
      const next = buffer[i + j];
      if ((next & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (codePoint < min || codePoint > 0x10ffff) return false;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    i += needed + 1;
  }
  return true;
}

export function decodeCommandOutput(buffer: Buffer, {
  platform = process.platform,
}: { platform?: NodeJS.Platform } = {}) {
  if (!buffer.length) {
    return { text: "", encoding: "utf-8", transcoded: false };
  }
  if (platform === "win32" && !isValidUtf8(buffer)) {
    try {
      return {
        text: new TextDecoder("gbk").decode(buffer),
        encoding: "gbk",
        transcoded: true,
      };
    } catch {}
  }
  return {
    text: buffer.toString("utf-8"),
    encoding: "utf-8",
    transcoded: false,
  };
}

class CommandOutputCollector {
  private readonly platform: NodeJS.Platform;
  private chunks: Buffer[] = [];
  private chunksBytes = 0;
  private totalBytes = 0;
  private tempFilePath: string | undefined;
  private tempFileStream: any;

  constructor(platform: NodeJS.Platform) {
    this.platform = platform;
  }

  append(data: Buffer) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.totalBytes += chunk.length;
    if (this.totalBytes > DEFAULT_MAX_BYTES) {
      this.ensureTempFile();
    }
    if (this.tempFileStream) this.tempFileStream.write(chunk);

    this.chunks.push(chunk);
    this.chunksBytes += chunk.length;
    while (this.chunksBytes > MAX_ROLLING_BYTES && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      this.chunksBytes -= removed?.length || 0;
    }
  }

  snapshot() {
    const buffer = Buffer.concat(this.chunks);
    return decodeCommandOutput(buffer, { platform: this.platform });
  }

  close() {
    if (this.tempFileStream) {
      this.tempFileStream.end();
      this.tempFileStream = undefined;
    }
  }

  private ensureTempFile() {
    if (this.tempFilePath) return;
    this.tempFilePath = getTempFilePath();
    this.tempFileStream = createWriteStream(this.tempFilePath);
    for (const chunk of this.chunks) this.tempFileStream.write(chunk);
  }

  get fullOutputPath() {
    return this.tempFilePath;
  }
}

function buildFinalCommandResult(output: string, exitCode: number | null, {
  fullOutputPath,
  encoding,
  transcoded,
}: {
  fullOutputPath?: string;
  encoding?: string;
  transcoded?: boolean;
}) {
  const truncation = truncateTail(output);
  let outputText = truncation.content || "(no output)";
  let outputPath = fullOutputPath;
  const details: Record<string, any> = {};

  if (truncation.truncated) {
    details.truncation = truncation;
    if (!outputPath) {
      try {
        outputPath = getTempFilePath();
        writeFileSync(outputPath, output, "utf-8");
      } catch {
        outputPath = undefined;
      }
    }
    if (outputPath) details.fullOutputPath = outputPath;
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;
    const fullOutputNotice = outputPath ? `. Full output: ${outputPath}` : "";
    if (truncation.lastLinePartial) {
      const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
      outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize})${fullOutputNotice}]`;
    } else if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${fullOutputNotice}]`;
    } else {
      outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit)${fullOutputNotice}]`;
    }
  } else if (outputPath) {
    details.fullOutputPath = outputPath;
  }

  if (exitCode !== 0 && exitCode !== null) {
    outputText += `\n\nCommand exited with code ${exitCode}`;
  }
  if (encoding) {
    details.outputEncoding = encoding;
    details.outputTranscoded = !!transcoded;
  }
  return textResult(outputText, details);
}

export async function runExecCommandOnce({
  bashTool,
  toolCallId,
  command,
  timeout,
  signal,
  onUpdate,
  ctx,
  execDetails,
  maxOutputTokens,
}: any) {
  try {
    const params: any = { command };
    if (timeout) params.timeout = timeout;
    const result = await bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
    const text = firstText(result);
    const exitCode = extractExitCode(text) ?? 0;
    return mergeExecDetails(result, {
      ...execDetails,
      ok: exitCode === 0,
      exitCode,
      transportError: false,
    });
  } catch (err) {
    const output = normalizeThrownToolError(err, maxOutputTokens);
    const exitCode = extractExitCode(output);
    return textResult(output, {
      execCommand: {
        ...execDetails,
        ok: false,
        exitCode,
        transportError: false,
        errorCode: execDetails?.classification?.kind === "probe"
          ? "EXEC_COMMAND_DEPENDENCY_MISSING"
          : "EXEC_COMMAND_EXIT_NONZERO",
      },
    });
  }
}

export async function runExecCommandDirect({
  commandExec,
  command,
  workdir,
  timeout,
  signal,
  onUpdate,
  execDetails,
  maxOutputTokens,
  platform = process.platform,
}: any) {
  const collector = new CommandOutputCollector(platform);

  try {
    if (onUpdate) onUpdate({ content: [], details: undefined });
    const result = await commandExec(command, workdir, {
      timeout,
      signal,
      onData: (data: Buffer) => {
        collector.append(data);
        if (!onUpdate) return;
        const decoded = collector.snapshot();
        const truncation = truncateTail(decoded.text);
        onUpdate({
          content: [{ type: "text", text: truncation.content || "" }],
          details: {
            truncation: truncation.truncated ? truncation : undefined,
            fullOutputPath: collector.fullOutputPath,
            outputEncoding: decoded.encoding,
            outputTranscoded: decoded.transcoded,
          },
        });
      },
    });
    collector.close();
    const decoded = collector.snapshot();
    const exitCode = result?.exitCode ?? 0;
    const toolResult = buildFinalCommandResult(decoded.text, exitCode, {
      fullOutputPath: collector.fullOutputPath,
      encoding: decoded.encoding,
      transcoded: decoded.transcoded,
    });
    return mergeExecDetails(toolResult, {
      ...execDetails,
      ok: exitCode === 0,
      exitCode,
      transportError: false,
      errorCode: exitCode === 0
        ? undefined
        : execDetails?.classification?.kind === "probe"
          ? "EXEC_COMMAND_DEPENDENCY_MISSING"
          : "EXEC_COMMAND_EXIT_NONZERO",
    });
  } catch (err) {
    collector.close();
    if (err?.lucCommandBlockedResult) {
      return mergeExecDetails(err.lucCommandBlockedResult, {
        ...execDetails,
        ok: false,
        transportError: false,
        errorCode: "EXEC_COMMAND_BLOCKED",
      });
    }

    const decoded = collector.snapshot();
    let output = decoded.text;
    if (err?.message === "aborted") {
      if (output) output += "\n\n";
      output += "Command aborted";
    } else if (typeof err?.message === "string" && err.message.startsWith("timeout:")) {
      const timeoutSecs = err.message.split(":")[1];
      if (output) output += "\n\n";
      output += `Command timed out after ${timeoutSecs} seconds`;
    } else {
      if (output) output += "\n\n";
      output += err?.message || String(err);
    }

    const exitCode = extractExitCode(output);
    const toolResult = buildFinalCommandResult(
      truncateText(output, maxOutputTokens),
      exitCode,
      {
        fullOutputPath: collector.fullOutputPath,
        encoding: decoded.encoding,
        transcoded: decoded.transcoded,
      },
    );
    return mergeExecDetails(toolResult, {
      ...execDetails,
      ok: false,
      exitCode,
      transportError: false,
      errorCode: execDetails?.classification?.kind === "probe"
        ? "EXEC_COMMAND_DEPENDENCY_MISSING"
        : "EXEC_COMMAND_EXIT_NONZERO",
    });
  }
}

export async function startExecCommandTty({
  manager,
  getAgentId,
  getCwd,
  command,
  workdir,
  label,
  ctx,
  execDetails,
  cols = 80,
  rows = 24,
}: any) {
  const sessionPath = getToolSessionPath(ctx);
  if (!sessionPath) {
    return textResult("current session is required to start an interactive command", {
      errorCode: "EXEC_COMMAND_SESSION_REQUIRED",
      execCommand: execDetails,
    });
  }
  if (!manager) {
    return textResult("terminal manager unavailable", {
      errorCode: "EXEC_COMMAND_TERMINAL_MANAGER_UNAVAILABLE",
      execCommand: execDetails,
    });
  }
  const result = await manager.start({
    sessionPath,
    agentId: getAgentId?.() || "",
    cwd: workdir || ctx?.sessionManager?.getCwd?.() || getCwd?.() || process.cwd(),
    command,
    label: label || "exec_command",
    cols,
    rows,
  });
  return jsonResult({
    ...result,
    processId: result.terminalId,
    process_id: result.terminalId,
    execCommand: {
      ...execDetails,
      ok: true,
      processId: result.terminalId,
      terminalId: result.terminalId,
      transportError: false,
    },
  });
}
