/**
 * card-document — Interactive Card 的服务端 HTML 包壳
 *
 * 由本地 Luc server 经 http 提供（见 server/routes/cards.ts）。
 * 关键：卡片必须从真实 http origin 加载，而非 srcdoc/blob——后两者会继承
 * 渲染进程的 `script-src 'self'` CSP，导致 iframe 内所有内联脚本（高度上报 +
 * agent 的 onclick/addEventListener）被静默阻断。http 响应不带 CSP，
 * iframe 文档拿到自己的（空）CSP 上下文，内联脚本才能执行。
 *
 * 包壳职责：
 *   - 静态部分：reset / 排版 / 字体 / 高度上报脚本（与设计 spec §4/§6 一致）
 *   - 注入部分：themeVarsCss（渲染器按当前主题采集的 CSS 变量）+ agent 的 code
 *
 * 本模块是纯字符串拼装，不依赖 DOM，可在 Node 端运行与单测。
 */

export interface BuildCardDocumentOptions {
  /** agent 生成的 HTML/SVG 片段，原样进 body（由 sandboxed iframe 隔离） */
  code: string;
  /** 渲染器采集的主题变量，形如 `--accent: #537D96;\n--bg: ...`。可空。 */
  varsCss?: string;
}

/**
 * 防止注入的变量串提前闭合 <style>。themeVarsCss 来自渲染器的 computed style
 * 采集，理论可信，但仍做一道防御：剥掉任何尖括号，杜绝 `</style>` 逃逸。
 */
function sanitizeVarsCss(varsCss: string): string {
  return varsCss.replace(/[<>]/g, "");
}

export function buildCardDocument(options: BuildCardDocumentOptions): string {
  const { code, varsCss = "" } = options;
  const safeVars = sanitizeVarsCss(varsCss);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
${safeVars}
  --font-serif: 'EB Garamond', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif;
  --font-ui: system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}

/* Reset */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html {
  background: var(--bg-card, #FBF7EE);
  color: var(--text, #2A2622);
  scrollbar-width: none;
  -ms-overflow-style: none;
}
html::-webkit-scrollbar,
body::-webkit-scrollbar { width: 0; height: 0; }
body { padding: 12px 16px; font-family: var(--font-serif); font-size: 14px; line-height: 1.65; }

/* Typography (§4) */
h1 { font-size: 1.35rem; font-weight: 500; line-height: 1.25; margin: 0 0 0.6em; }
h2 { font-size: 1.1rem; font-weight: 500; line-height: 1.3; margin: 0.8em 0 0.4em; border-left: 2px solid var(--accent, #537D96); padding-left: 8px; }
h3 { font-size: 0.95rem; font-weight: 500; line-height: 1.35; margin: 0.6em 0 0.3em; }
p { margin: 0.4em 0; }
small { font-size: 0.75rem; color: var(--text-muted, #6B6158); }
strong { font-weight: 500; color: var(--accent, #537D96); }
a { color: var(--accent, #537D96); text-decoration: none; }
hr { border: none; border-top: 0.5px solid var(--border, #D8CFBE); margin: 0.8em 0; }

/* Table (§6) */
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 0.6em 0; }
th { text-align: left; font-weight: 500; color: var(--text-light, #4A433C); padding: 6px 8px; border-bottom: 1px solid var(--border, #D8CFBE); }
td { padding: 5px 8px; border-bottom: 0.5px solid rgba(0,0,0,0.06); color: var(--text, #2A2622); }
tr:last-child td { border-bottom: none; }

/* Lists */
ul, ol { padding-left: 18px; margin: 0.4em 0; }
li { margin: 0.15em 0; }
li::marker { color: var(--accent, #537D96); }

/* Code (§6) */
pre { background: var(--bg, #F5EFE4); border: 0.5px solid var(--border, #D8CFBE); border-radius: 4px; padding: 8px 12px; overflow-x: auto; }
code { font-family: var(--font-mono); font-size: 0.82rem; color: var(--text, #2A2622); }

/* Blockquote (§6) */
blockquote { border-left: 2px solid var(--accent, #537D96); padding: 4px 0 4px 12px; color: var(--text-muted, #6B6158); font-style: italic; margin: 0.5em 0; }

/* SVG defaults (§11) */
svg { display: block; width: 100%; max-width: 100%; }
svg text { font-family: var(--font-serif); }

/* Accessibility */
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
</style>
</head>
<body>
${code}
<script>
(function() {
  var NS = 'luc.card-resize';
  var last = 0;
  function report() {
    var h = document.documentElement.scrollHeight;
    if (h !== last) { last = h; window.parent.postMessage({ type: NS, height: h }, '*'); }
  }
  if (document.readyState === 'complete') report();
  else window.addEventListener('load', report);
  new ResizeObserver(function() { report(); }).observe(document.body);
  // 响应宿主 ping，覆盖 ResizeObserver 首报被漏掉的竞态
  window.addEventListener('message', function(e) {
    if (e.data === 'luc.card-ping') { last = 0; report(); }
  });
})();
</script>
</body>
</html>`;
}
