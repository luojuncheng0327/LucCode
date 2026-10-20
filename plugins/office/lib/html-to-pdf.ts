import { spawn as nodeSpawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

export const OFFICE_PDF_HELPER_FLAG = "--luc-office-html-to-pdf";

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_SETTLE_MS = 250;
const MAX_LOG_CHARS = 12000;

function sanitizeFilename(value, fallback = "document.pdf") {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const withoutControlChars = Array.from(raw)
    .map((char) => char.charCodeAt(0) < 32 ? "-" : char)
    .join("");
  const safe = withoutControlChars.replace(/[\\/:*?"<>|]+/g, "-").replace(/^\.+$/, fallback);
  return safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;
}

function ensureAbsolutePath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const resolved = path.resolve(value.trim());
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must be absolute`);
  return resolved;
}

function appendLimited(buffer, chunk) {
  const next = buffer + String(chunk || "");
  return next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next;
}

function helperCommandForJob(jobPath, input: any = {}, env = process.env) {
  const execPath = input.helperExecPath
    || env.LUC_OFFICE_PDF_HELPER_EXEC
    || env.LUC_DESKTOP_EXEC_PATH;
  if (!execPath) {
    throw new Error(
      "Chromium PDF helper is unavailable. Start Luc Desktop, or set LUC_OFFICE_PDF_HELPER_EXEC to an Electron executable.",
    );
  }

  const helperAppPath = input.helperAppPath
    || env.LUC_OFFICE_PDF_HELPER_APP_PATH
    || (env.LUC_DESKTOP_IS_PACKAGED === "1" ? null : env.LUC_DESKTOP_APP_PATH);

  const args = helperAppPath
    ? [helperAppPath, OFFICE_PDF_HELPER_FLAG, jobPath]
    : [OFFICE_PDF_HELPER_FLAG, jobPath];

  return { execPath, args };
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill?.("SIGTERM"); } catch {}
      reject(new Error(`Chromium PDF helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on?.("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.on?.("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on?.("close", (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const suffix = stderr || stdout ? `: ${(stderr || stdout).trim()}` : "";
      reject(new Error(`Chromium PDF helper exited with ${signal || code}${suffix}`));
    });
  });
}

async function writeInputHtml(input, workDir) {
  const hasHtml = typeof input.html === "string";
  const hasHtmlPath = typeof input.htmlPath === "string" && input.htmlPath.trim();
  if (hasHtml === Boolean(hasHtmlPath)) {
    throw new Error("provide exactly one of html or htmlPath");
  }
  if (hasHtmlPath) return ensureAbsolutePath(input.htmlPath, "htmlPath");

  const htmlPath = path.join(workDir, "input.html");
  await fsp.writeFile(htmlPath, input.html, "utf-8");
  return htmlPath;
}

function resolveOutputPath(input, dataDir, jobId) {
  if (input.outputPath) {
    const outputPath = ensureAbsolutePath(input.outputPath, "outputPath");
    if (fs.existsSync(outputPath) && input.overwrite !== true) {
      throw new Error(`outputPath already exists: ${outputPath}`);
    }
    return outputPath;
  }
  const filename = sanitizeFilename(input.filename, `office-${jobId}.pdf`);
  return path.join(dataDir, "generated", filename);
}

function buildJobPayload(input, htmlPath, outputPath) {
  return {
    htmlPath,
    outputPath,
    viewport: {
      width: Number.isFinite(Number(input.viewportWidth)) ? Number(input.viewportWidth) : 1280,
      height: Number.isFinite(Number(input.viewportHeight)) ? Number(input.viewportHeight) : 900,
    },
    printBackground: input.printBackground !== false,
    preferCSSPageSize: input.preferCSSPageSize !== false,
    pageSize: typeof input.pageSize === "string" && input.pageSize.trim() ? input.pageSize.trim() : "A4",
    landscape: input.landscape === true,
    margins: input.margins && typeof input.margins === "object" ? input.margins : undefined,
    allowJavaScript: input.allowJavaScript === true,
    embedLucFonts: input.embedLucFonts !== false,
    settleMs: Number.isFinite(Number(input.settleMs)) ? Number(input.settleMs) : DEFAULT_SETTLE_MS,
  };
}

export async function renderHtmlToPdf(input: any = {}, ctx: any = {}, deps: any = {}) {
  const dataDir = ctx.dataDir || path.join(process.cwd(), ".office-plugin");
  const jobId = crypto.randomBytes(8).toString("hex");
  const workDir = path.join(dataDir, "jobs", jobId);
  await fsp.mkdir(workDir, { recursive: true });

  const htmlPath = await writeInputHtml(input, workDir);
  const outputPath = resolveOutputPath(input, dataDir, jobId);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  const job = buildJobPayload(input, htmlPath, outputPath);
  const jobPath = path.join(workDir, "job.json");
  await fsp.writeFile(jobPath, JSON.stringify(job, null, 2), "utf-8");

  const { execPath, args } = helperCommandForJob(jobPath, input, deps.env || process.env);
  const env = { ...(deps.env || process.env) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = (deps.spawn || nodeSpawn)(execPath, args, {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timeoutMs = Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : DEFAULT_TIMEOUT_MS;
  await waitForChild(child, timeoutMs);

  const stat = await fsp.stat(outputPath);
  const staged = (ctx.sessionId || ctx.sessionPath) && typeof ctx.stageFile === "function"
    ? ctx.stageFile({
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
      ...(ctx.sessionRef ? { sessionRef: ctx.sessionRef } : {}),
      filePath: outputPath,
      label: path.basename(outputPath),
    })
    : null;

  return {
    outputPath,
    htmlPath,
    filename: path.basename(outputPath),
    size: stat.size,
    engine: "electron-printToPDF",
    mediaItem: staged?.mediaItem || null,
    sessionFile: staged?.file || null,
  };
}
