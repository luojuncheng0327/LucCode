import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { guessMime } from "../http/file-content.ts";

export type MobileStaticMode = "dist" | "guide" | "error";

export type MobileStaticRouteOptions =
  | { mode: "dist"; distDir: string }
  | { mode: "guide" }
  | { mode: "error"; reason: string };

/**
 * Startup-time decision for whether `/mobile` and `/desktop` have a real
 * renderer build to serve. `devDistDir` is the repo-tree fallback used
 * when no `LUC_RENDERER_DIST` is injected (the existing `npm start` dev
 * shape). This is deliberately a pure, side-effect-free predicate — it
 * lives here (not in server/index.ts, which binds ports and boots the
 * engine at module load and so cannot be safely `import`-ed by a test)
 * so the three-mode decision can be exercised directly in tests.
 *
 * No silent fallback: if `LUC_RENDERER_DIST` is set but doesn't contain
 * a real build, this returns "error", never a quiet drop-through to
 * `devDistDir` — a broken injected pointer must surface loudly, not
 * masquerade as "dev fallback available" or "never installed".
 */
export function resolveMobileStaticRouteOptions({
  env = process.env,
  devDistDir,
}: { env?: NodeJS.ProcessEnv; devDistDir: string }): MobileStaticRouteOptions {
  const injected = env.LUC_RENDERER_DIST;
  if (injected) {
    if (hasMobileEntry(injected)) return { mode: "dist", distDir: injected };
    return {
      mode: "error",
      reason: `LUC_RENDERER_DIST is set to ${injected}, but that directory is missing or does not contain mobile.html`,
    };
  }
  if (hasMobileEntry(devDistDir)) return { mode: "dist", distDir: devDistDir };
  return { mode: "guide" };
}

function hasMobileEntry(dir: string) {
  try {
    return fs.statSync(path.join(dir, "mobile.html")).isFile();
  } catch {
    return false;
  }
}

export function createMobileStaticRoute(options: MobileStaticRouteOptions) {
  if (!options || !options.mode) throw new Error("createMobileStaticRoute: mode required");
  const route = new Hono();

  if (options.mode === "dist") {
    if (!options.distDir) throw new Error("createMobileStaticRoute: distDir required for dist mode");
    registerWebClientRoute(route, "/mobile", options.distDir, "mobile.html");
    registerWebClientRoute(route, "/desktop", options.distDir, "mobile.html");
    return route;
  }

  if (options.mode === "guide") {
    registerStaticPage(route, "/mobile", 200, GUIDE_HTML, { fallthrough404: true });
    registerStaticPage(route, "/desktop", 200, GUIDE_HTML, { fallthrough404: true });
    return route;
  }

  if (options.mode === "error") {
    // Logged once at route construction (startup), not per-request — the
    // response body stays generic (no filesystem paths), the log carries
    // the real reason for whoever operates the server.
    console.error(`[mobile-static] web frontend unavailable: ${options.reason}`);
    registerStaticPage(route, "/mobile", 503, ERROR_HTML, { fallthrough404: false });
    registerStaticPage(route, "/desktop", 503, ERROR_HTML, { fallthrough404: false });
    return route;
  }

  throw new Error(`createMobileStaticRoute: unknown mode ${JSON.stringify((options as { mode: string }).mode)}`);
}

function registerWebClientRoute(route: Hono, basePath: string, distDir: string, entryFile: string) {
  route.get(basePath, (c) => serveWebClientFile(c, distDir, "", entryFile));
  route.get(`${basePath}/`, (c) => serveWebClientFile(c, distDir, "", entryFile));
  route.get(`${basePath}/*`, (c) => {
    const pattern = new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/?`);
    return serveWebClientFile(c, distDir, c.req.path.replace(pattern, ""), entryFile);
  });
}

/**
 * Registers `basePath`/`basePath/` returning `html` at `status`. When
 * `fallthrough404` is true, deeper paths (`basePath/*`) 404 instead of
 * repeating the page — that's the guide mode's "nothing to serve"
 * semantics (an asset request under a never-installed frontend is a 404,
 * not a page). When false (error mode), every path under `basePath`
 * returns the same status/page — the whole surface is down, a 404 there
 * would misleadingly suggest only one asset is missing.
 */
function registerStaticPage(
  route: Hono,
  basePath: string,
  status: number,
  html: string,
  { fallthrough404 }: { fallthrough404: boolean },
) {
  const respond = (c) => {
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(html, status as any);
  };
  route.get(basePath, respond);
  route.get(`${basePath}/`, respond);
  route.get(`${basePath}/*`, fallthrough404 ? (c) => c.body(null, 404) : respond);
}

function serveWebClientFile(c, distDir, requestPath, entryFile) {
  const relative = !requestPath || requestPath === "index.html"
    ? entryFile
    : safeRelativePath(requestPath);
  if (!relative) return c.body(null, 404);
  const filePath = path.join(distDir, relative);
  const safePath = resolveExistingInside(distDir, filePath);
  if (!safePath) return c.body(null, 404);
  const stat = fs.statSync(safePath);
  if (!stat.isFile()) return c.body(null, 404);
  c.header("Content-Type", guessMime(safePath));
  c.header("Cache-Control", relative === entryFile
    ? "no-cache"
    : "public, max-age=31536000, immutable");
  return c.body(fs.readFileSync(safePath));
}

function safeRelativePath(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(value || ""));
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\\") || decoded.startsWith("/") || decoded.includes("\0")) return null;
  const parts = decoded.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (
    parts[0] !== "assets"
    && parts[0] !== "icons"
    && parts[0] !== "lib"
    && parts[0] !== "themes"
    && parts[0] !== "locales"
    && decoded !== "manifest.webmanifest"
    && decoded !== "sw.js"
    && decoded !== "icon.png"
  ) {
    return null;
  }
  return parts.join(path.sep);
}

function resolveExistingInside(root, target) {
  let rootReal;
  let targetReal;
  try {
    rootReal = fs.realpathSync(root);
    targetReal = fs.realpathSync(target);
  } catch {
    return null;
  }
  return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep)
    ? targetReal
    : null;
}

const PAGE_STYLE = `
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #faf7f2; color: #3a352e; text-align: center; padding: 2rem; box-sizing: border-box;
  }
  main { max-width: 32rem; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 1rem; }
  p { line-height: 1.6; margin: 0 0 0.75rem; }
  p.en { color: #7a7368; font-size: 0.9rem; }
  code { background: rgba(0,0,0,0.06); padding: 0.1em 0.4em; border-radius: 3px; }
`;

const GUIDE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Luc</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <h1>Luc</h1>
  <p>尚未安装网页界面。在服务器上运行 <code>luc bundle pull</code> 获取，然后重启 <code>luc serve</code>。</p>
  <p class="en">No web frontend installed yet. Run <code>luc bundle pull</code> on the server, then restart <code>luc serve</code>.</p>
</main>
</body>
</html>
`;

const ERROR_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Luc</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <h1>Luc</h1>
  <p>网页界面文件不可用（目录缺失或损坏）。请查看服务器日志，或重新运行 <code>luc bundle pull</code>。</p>
  <p class="en">The web frontend files are unavailable (missing or corrupted). Check the server logs, or re-run <code>luc bundle pull</code>.</p>
</main>
</body>
</html>
`;
