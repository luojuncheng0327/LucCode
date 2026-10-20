const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { app, BrowserWindow } = require("electron");
const { buildFontInjectionCss } = require("./office-pdf-fonts.cjs");

const OFFICE_PDF_HELPER_FLAG = "--luc-office-html-to-pdf";
const DEFAULT_TIMEOUT_MS = 60000;

function isOfficePdfHelperInvocation(argv = process.argv) {
  return argv.some((arg) => arg === OFFICE_PDF_HELPER_FLAG || arg.startsWith(`${OFFICE_PDF_HELPER_FLAG}=`));
}

function jobPathFromArgv(argv = process.argv) {
  const flagIndex = argv.findIndex((arg) => arg === OFFICE_PDF_HELPER_FLAG || arg.startsWith(`${OFFICE_PDF_HELPER_FLAG}=`));
  if (flagIndex < 0) return null;
  const flag = argv[flagIndex];
  if (flag.startsWith(`${OFFICE_PDF_HELPER_FLAG}=`)) {
    return flag.slice(OFFICE_PDF_HELPER_FLAG.length + 1);
  }
  return argv[flagIndex + 1] || null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function normalizeJob(raw) {
  if (!raw || typeof raw !== "object") throw new Error("job must be an object");
  const htmlPath = path.resolve(String(raw.htmlPath || ""));
  const outputPath = path.resolve(String(raw.outputPath || ""));
  if (!htmlPath || !fs.existsSync(htmlPath)) throw new Error(`htmlPath does not exist: ${htmlPath}`);
  if (!outputPath) throw new Error("outputPath is required");
  return {
    htmlPath,
    outputPath,
    viewport: {
      width: normalizeNumber(raw.viewport?.width, 1280, 320, 4096),
      height: normalizeNumber(raw.viewport?.height, 900, 320, 4096),
    },
    printBackground: raw.printBackground !== false,
    preferCSSPageSize: raw.preferCSSPageSize !== false,
    pageSize: typeof raw.pageSize === "string" && raw.pageSize.trim() ? raw.pageSize.trim() : "A4",
    landscape: raw.landscape === true,
    margins: raw.margins && typeof raw.margins === "object" ? raw.margins : undefined,
    allowJavaScript: raw.allowJavaScript === true,
    embedLucFonts: raw.embedLucFonts !== false,
    settleMs: normalizeNumber(raw.settleMs, 250, 0, 30000),
    timeoutMs: normalizeNumber(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 5 * 60 * 1000),
  };
}

async function waitForPageAssets(webContents, settleMs) {
  if (settleMs > 0) await delay(settleMs);
  try {
    await webContents.executeJavaScript(`
      Promise.all([
        document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(),
        Promise.all(Array.from(document.images || []).map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          });
        })),
      ]).then(() => true)
    `, true);
  } catch {
    // javascript=false pages can reject executeJavaScript. Load completion plus settleMs
    // is still deterministic enough for static HTML/CSS.
  }
}

async function renderJob(job) {
  // 注入素材在开窗口前构建：字体资源缺失时显式失败，不静默产出回退字体的 PDF。
  const fontCss = job.embedLucFonts ? buildFontInjectionCss() : null;

  const win = new BrowserWindow({
    show: false,
    width: job.viewport.width,
    height: job.viewport.height,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      javascript: job.allowJavaScript,
    },
  });

  try {
    const url = pathToFileURL(job.htmlPath).href;
    await withTimeout(win.loadURL(url), job.timeoutMs, "loadURL");
    if (fontCss) {
      // 只声明 @font-face：页面字体栈引用这些族名才会触发按 unicode-range 的
      // 惰性加载，未引用的页面零影响。waitForPageAssets 的 document.fonts.ready
      // 会等注入字体加载完成。
      await withTimeout(win.webContents.insertCSS(fontCss), job.timeoutMs, "font css inject");
    }
    await withTimeout(waitForPageAssets(win.webContents, job.settleMs), job.timeoutMs, "asset wait");
    const pdf = await withTimeout(
      win.webContents.printToPDF({
        printBackground: job.printBackground,
        preferCSSPageSize: job.preferCSSPageSize,
        pageSize: job.pageSize,
        landscape: job.landscape,
        ...(job.margins ? { margins: job.margins } : {}),
      }),
      job.timeoutMs,
      "printToPDF",
    );
    fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
    fs.writeFileSync(job.outputPath, pdf);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function runOfficePdfHelperFromArgv(argv = process.argv) {
  const jobPath = jobPathFromArgv(argv);
  if (!jobPath) throw new Error(`${OFFICE_PDF_HELPER_FLAG} requires a job JSON path`);
  const raw = JSON.parse(fs.readFileSync(path.resolve(jobPath), "utf-8"));
  const job = normalizeJob(raw);
  await app.whenReady();
  await renderJob(job);
  app.exit(0);
}

module.exports = {
  OFFICE_PDF_HELPER_FLAG,
  isOfficePdfHelperInvocation,
  runOfficePdfHelperFromArgv,
};
