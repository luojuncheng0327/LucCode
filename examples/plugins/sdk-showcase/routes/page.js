export default function registerSdkShowcaseRoutes(app, ctx) {
  app.get("/page", (c) => c.html(renderShell(c, ctx, "page")));
  app.get("/widget", (c) => c.html(renderShell(c, ctx, "widget")));
}

function renderShell(c, ctx, surface) {
  const lucCss = c.req.query("luc-css") || "";
  const theme = c.req.query("luc-theme") || "inherit";
  const base = `/api/plugins/${ctx.pluginId}`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${lucCss ? `<link rel="stylesheet" href="${escapeAttr(lucCss)}">` : ""}
  <link rel="stylesheet" href="${base}/assets/panel.css">
</head>
<body data-luc-theme="${escapeAttr(theme)}" data-surface="${surface}">
  <div id="root" data-surface="${surface}"></div>
  <script type="module" src="${base}/assets/panel.js"></script>
</body>
</html>`;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
