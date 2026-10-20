#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import ntpath
import os
import posixpath
import re
import shutil
import sys
from pathlib import Path, PurePath, PureWindowsPath


SDK_PACKAGES = {
    "@luccode/plugin-protocol": "plugin-protocol",
    "@luccode/plugin-runtime": "plugin-runtime",
    "@luccode/plugin-sdk": "plugin-sdk",
    "@luccode/plugin-components": "plugin-components",
}

SDK_TARBALLS = {
    "@luccode/plugin-protocol": "luc-plugin-protocol-*.tgz",
    "@luccode/plugin-runtime": "luc-plugin-runtime-*.tgz",
    "@luccode/plugin-sdk": "luc-plugin-sdk-*.tgz",
    "@luccode/plugin-components": "luc-plugin-components-*.tgz",
}

REACT_TEMPLATES = {"guided-react", "professional-react"}


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "luc-plugin"


def titleize(value: str) -> str:
    parts = re.split(r"[\s_-]+", value.strip())
    return " ".join(part[:1].upper() + part[1:] for part in parts if part) or "Luc Plugin"


def js_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def script_root() -> Path:
    return Path(__file__).resolve().parents[1]


def find_luc_root(*starts: Path) -> Path | None:
    seen: set[Path] = set()
    for start in starts:
        current = start.resolve()
        for candidate in [current, *current.parents]:
            if candidate in seen:
                continue
            seen.add(candidate)
            if (candidate / "PLUGIN_SDK.md").exists() and (candidate / "packages" / "plugin-runtime").exists():
                return candidate
    return None


def read_package_json(root: Path | None) -> dict:
    if not root:
        return {}
    package_path = root / "package.json"
    if not package_path.exists():
        return {}
    try:
        return json.loads(package_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def package_version(root_package: dict, name: str, fallback: str) -> str:
    for bucket in ("dependencies", "devDependencies", "peerDependencies"):
        value = root_package.get(bucket, {}).get(name)
        if isinstance(value, str) and value:
            return value
    return fallback


def uses_windows_path_flavor(path: PurePath) -> bool:
    return isinstance(path, PureWindowsPath) or bool(path.drive)


def path_module_for(*paths: PurePath):
    if any(uses_windows_path_flavor(path) for path in paths):
        return ntpath
    return posixpath


def relative_file_spec(from_dir: Path, target: Path) -> str:
    path_module = path_module_for(from_dir, target)
    try:
        rel = path_module.relpath(str(target), str(from_dir))
    except ValueError:
        if not target.is_absolute():
            raise
        return target.as_uri()
    return "file:" + rel.replace("\\", "/")


def choose_template(template: str, audience: str) -> str:
    if template != "auto":
        return template
    if audience == "developer":
        return "professional-react"
    return "direct"


def choose_scaffold_template(args: argparse.Namespace) -> str:
    if args.kind == "provider" and args.template == "auto":
        return "direct"
    return choose_template(args.template, args.audience)


def choose_sdk_mode(sdk_mode: str, luc_root: Path | None, template: str) -> str:
    if template not in REACT_TEMPLATES:
        return "none"
    if sdk_mode != "auto":
        return sdk_mode
    if luc_root:
        return "workspace"
    return "bundled"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def required_sdk_packages(include_tool: bool, include_ui: bool, include_lifecycle: bool, template: str) -> list[str]:
    if template not in REACT_TEMPLATES:
        return []
    packages: list[str] = []
    if include_tool or include_lifecycle:
        packages.append("@luccode/plugin-protocol")
        packages.append("@luccode/plugin-runtime")
    if include_ui:
        if "@luccode/plugin-protocol" not in packages:
            packages.append("@luccode/plugin-protocol")
        packages.extend(["@luccode/plugin-sdk", "@luccode/plugin-components"])
    return packages


def find_sdk_tarball(package_name: str) -> Path:
    sdk_dir = script_root() / "assets" / "sdk"
    pattern = SDK_TARBALLS[package_name]
    matches = sorted(sdk_dir.glob(pattern))
    if not matches:
        raise SystemExit(
            f"Bundled SDK tarball missing for {package_name}. "
            f"Expected {sdk_dir / pattern}. Run npm pack for SDK packages first."
        )
    return matches[-1]


def prepare_bundled_sdk(plugin_dir: Path, packages: list[str]) -> dict[str, Path]:
    vendor_dir = plugin_dir / "vendor" / "sdk"
    copied: dict[str, Path] = {}
    for package_name in packages:
        src = find_sdk_tarball(package_name)
        dst = vendor_dir / src.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied[package_name] = dst
    return copied


def sdk_dependency(
    plugin_dir: Path,
    luc_root: Path | None,
    package_name: str,
    sdk_mode: str,
    bundled: dict[str, Path],
) -> str:
    if sdk_mode == "workspace":
        if not luc_root:
            raise SystemExit("workspace SDK mode requires running from a Luc repo. Use --sdk-mode bundled.")
        package_dir = luc_root / "packages" / SDK_PACKAGES[package_name]
        if not package_dir.exists():
            raise SystemExit(f"Missing workspace SDK package: {package_dir}")
        return relative_file_spec(plugin_dir, package_dir)

    if sdk_mode == "bundled":
        tarball = bundled.get(package_name)
        if not tarball:
            raise SystemExit(f"Bundled SDK tarball was not prepared for {package_name}.")
        return relative_file_spec(plugin_dir, tarball)

    raise SystemExit(f"Unsupported SDK mode for {package_name}: {sdk_mode}")


def manifest_for(
    args: argparse.Namespace,
    plugin_id: str,
    display_name: str,
    include_tool: bool,
    include_ui: bool,
    include_lifecycle: bool,
    include_provider: bool,
) -> dict:
    manifest = {
        "manifestVersion": 1,
        "id": plugin_id,
        "name": display_name,
        "version": "0.1.0",
        "description": args.description or f"{display_name} plugin for Luc.",
        "minAppVersion": args.min_app_version,
    }
    if include_ui or include_lifecycle or include_provider:
        manifest["trust"] = "full-access"
    if include_ui:
        manifest["ui"] = {
            "hostCapabilities": ["external.open", "clipboard.writeText"],
        }
        manifest["contributes"] = {
            "page": {
                "title": display_name,
                "route": "/page",
                "icon": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M5 5h14v14H5z\"/><path d=\"M9 9h6M9 13h6\"/></svg>",
            },
            "widget": {
                "title": display_name,
                "route": "/widget",
                "icon": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M8 7l-4 5 4 5\"/><path d=\"M16 7l4 5-4 5\"/></svg>",
            },
        }
    if args.dev_scenario:
        if include_tool:
            manifest.setdefault("dev", {})["scenarios"] = [{
                "id": "smoke-tool",
                "steps": [
                    {
                        "invokeTool": {
                            "name": "create_note",
                            "input": {
                                "title": "Smoke Test",
                                "body": "Generated by dev scenario.",
                            },
                        },
                    },
                    {"expectToolText": "Created"},
                ],
            }]
        elif include_ui:
            manifest.setdefault("dev", {})["scenarios"] = [{
                "id": "open-page",
                "steps": [{"openSurface": "/page"}],
            }]
    return manifest


def package_json_for(
    plugin_dir: Path,
    luc_root: Path | None,
    root_package: dict,
    plugin_id: str,
    include_tool: bool,
    include_ui: bool,
    include_lifecycle: bool,
    template: str,
    sdk_mode: str,
    bundled_sdk: dict[str, Path],
) -> dict:
    dependencies: dict[str, str] = {}
    for package_name in required_sdk_packages(include_tool, include_ui, include_lifecycle, template):
        dependencies[package_name] = sdk_dependency(plugin_dir, luc_root, package_name, sdk_mode, bundled_sdk)

    dev_dependencies: dict[str, str] = {}
    scripts: dict[str, str] = {}

    if include_ui and template in REACT_TEMPLATES:
        dependencies.update({
            "react": package_version(root_package, "react", "^19.0.0"),
            "react-dom": package_version(root_package, "react-dom", "^19.0.0"),
        })
        dev_dependencies.update({
            "@vitejs/plugin-react": package_version(root_package, "@vitejs/plugin-react", "^5.0.0"),
            "@types/react": package_version(root_package, "@types/react", "^19.0.0"),
            "@types/react-dom": package_version(root_package, "@types/react-dom", "^19.0.0"),
            "typescript": package_version(root_package, "typescript", "^5.0.0"),
            "vite": package_version(root_package, "vite", "^7.0.0"),
        })
        scripts.update({
            "build:ui": "vite build",
            "typecheck": "tsc --noEmit",
        })

    package = {
        "name": plugin_id,
        "version": "0.1.0",
        "private": True,
        "type": "module",
    }
    if dependencies:
        package["dependencies"] = dependencies
    if scripts:
        package["scripts"] = scripts
    if dev_dependencies:
        package["devDependencies"] = dev_dependencies
    return package


def create_direct_tool(plugin_id: str, display_name: str) -> str:
    return f"""
import fs from "node:fs";
import path from "node:path";

export const name = "create_note";
export const description = "Create a markdown note and return it as SessionFile media.";
export const parameters = {{
  type: "object",
  properties: {{
    title: {{ type: "string" }},
    body: {{ type: "string" }}
  }}
}};

export const sessionPermission = {{
  kind: "plugin_output",
  describeSideEffect: () => ({{
    kind: "session_file_output",
    summary: "Create a markdown file in plugin data and register it as SessionFile media.",
    ruleId: "{plugin_id}-plugin-output",
  }}),
}};

export async function execute(input = {{}}, toolCtx) {{
  const sessionRef = toolCtx.sessionRef || (toolCtx.sessionId
    ? {{ sessionId: toolCtx.sessionId, sessionPath: toolCtx.sessionPath || null }}
    : null);
  if (!sessionRef?.sessionId) {{
    throw new Error("{plugin_id}_create_note requires sessionId");
  }}
  if (!toolCtx.stageFile) {{
    throw new Error("{plugin_id}_create_note requires stageFile");
  }}

  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : {js_string(display_name + " Note")};
  const body = typeof input.body === "string" ? input.body : "Generated from a Luc plugin.";
  const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "note";
  const outputDir = path.join(toolCtx.dataDir, "notes");
  const filePath = path.join(outputDir, `${{safeName}}.md`);

  fs.mkdirSync(outputDir, {{ recursive: true }});
  fs.writeFileSync(filePath, `# ${{title}}\\n\\n${{body}}\\n`, "utf-8");

  const staged = toolCtx.stageFile({{
    sessionId: sessionRef.sessionId,
    sessionRef,
    filePath,
    label: `${{safeName}}.md`,
  }});

  return {{
    content: [{{ type: "text", text: `Created ${{safeName}}.md` }}],
    details: {{ media: {{ items: [staged.mediaItem] }} }},
  }};
}}
"""


def create_runtime_tool(plugin_id: str, display_name: str) -> str:
    return f"""
import fs from "node:fs";
import path from "node:path";
import {{ createMediaDetails, defineTool }} from "@luccode/plugin-runtime";

const tool = defineTool({{
  name: "create_note",
  description: "Create a markdown note and return it as SessionFile media.",
  parameters: {{
    type: "object",
    properties: {{
      title: {{ type: "string" }},
      body: {{ type: "string" }}
    }}
  }},
  sessionPermission: {{
    kind: "plugin_output",
    describeSideEffect: () => ({{
      kind: "session_file_output",
      summary: "Create a markdown file in plugin data and register it as SessionFile media.",
      ruleId: "{plugin_id}-plugin-output",
    }}),
  }},
  async execute(input = {{}}, toolCtx) {{
    const sessionRef = toolCtx.sessionRef || (toolCtx.sessionId
      ? {{ sessionId: toolCtx.sessionId, sessionPath: toolCtx.sessionPath || null }}
      : null);
    if (!sessionRef?.sessionId) {{
      throw new Error("{plugin_id}_create_note requires sessionId");
    }}
    if (!toolCtx.stageFile) {{
      throw new Error("{plugin_id}_create_note requires stageFile");
    }}

    const title = typeof input.title === "string" && input.title.trim()
      ? input.title.trim()
      : {js_string(display_name + " Note")};
    const body = typeof input.body === "string" ? input.body : "Generated from a Luc plugin.";
    const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "note";
    const outputDir = path.join(toolCtx.dataDir, "notes");
    const filePath = path.join(outputDir, `${{safeName}}.md`);

    fs.mkdirSync(outputDir, {{ recursive: true }});
    fs.writeFileSync(filePath, `# ${{title}}\\n\\n${{body}}\\n`, "utf-8");

    const staged = toolCtx.stageFile({{
      sessionId: sessionRef.sessionId,
      sessionRef,
      filePath,
      label: `${{safeName}}.md`,
    }});

    return {{
      content: [{{ type: "text", text: `Created ${{safeName}}.md` }}],
      details: createMediaDetails([staged]),
    }};
  }},
}});

export const {{ name, description, parameters, execute }} = tool;
"""


def create_direct_index(plugin_id: str, display_name: str) -> str:
    status_type = f"{plugin_id}:status"
    return f"""
const LUC_BUS_SKIP = Symbol.for("luc.event-bus.skip");

export default class Plugin {{
  async onload() {{
    const ctx = this.ctx;
    if (ctx.bus.handle) {{
      this.register(ctx.bus.handle({js_string(status_type)}, (payload) => {{
        if (payload?.pluginId && payload.pluginId !== ctx.pluginId) return LUC_BUS_SKIP;
        return {{
          ok: true,
          pluginId: ctx.pluginId,
          name: {js_string(display_name)},
        }};
      }}));
    }}
    ctx.log.info({js_string(display_name + " loaded")});
  }}

  async onunload() {{
    this.ctx.log.info({js_string(display_name + " unloaded")});
  }}
}}
"""


def create_runtime_index(plugin_id: str, display_name: str) -> str:
    status_type = f"{plugin_id}:status"
    return f"""
import {{
  defineBusHandler,
  definePlugin,
  LUC_BUS_SKIP,
}} from "@luccode/plugin-runtime";

const statusHandler = defineBusHandler({{
  type: {js_string(status_type)},
  async handle(payload, ctx) {{
    if (payload?.pluginId && payload.pluginId !== ctx.pluginId) return LUC_BUS_SKIP;
    return {{
      ok: true,
      pluginId: ctx.pluginId,
      name: {js_string(display_name)},
    }};
  }},
}});

export default definePlugin({{
  async onload(ctx, {{ register }}) {{
    if (ctx.bus.handle) {{
      register(ctx.bus.handle(statusHandler.type, (payload) => statusHandler.handle(payload, ctx)));
    }}
    ctx.log.info({js_string(display_name + " loaded")});
  }},

  async onunload(ctx) {{
    ctx.log.info({js_string(display_name + " unloaded")});
  }},
}});
"""


def create_provider_contribution(plugin_id: str, display_name: str) -> str:
    model_id = f"{plugin_id}-image"
    executable = f"{plugin_id}-image"
    return f"""
export const id = {js_string(plugin_id)};
export const displayName = {js_string(display_name)};
export const authType = "none";

export const runtime = {{
  kind: "local-cli",
  protocolId: "local-cli-media",
  command: {{
    executable: {js_string(executable)},
    args: [
      {{ literal: "generate" }},
      {{ option: "--prompt", from: "prompt" }},
      {{ option: "--model", from: "modelId" }},
      {{ option: "--output", from: "outputDir" }},
    ],
    timeoutMs: 120000,
    output: {{ kind: "file_glob", directory: "outputDir", pattern: "*.png" }},
  }},
}};

export const capabilities = {{
  chat: {{ projection: "none" }},
  media: {{
    imageGeneration: {{
      defaultModelId: {js_string(model_id)},
      models: [
        {{
          id: {js_string(model_id)},
          displayName: {js_string(display_name + " Image")},
          protocolId: "local-cli-media",
          inputs: ["text"],
          outputs: ["image"],
          modes: [
            {{
              id: "text2image",
              label: "Text to image",
              inputLimits: {{ referenceImages: {{ min: 0, max: 0 }} }},
              parameterSchema: {{
                type: "object",
                properties: {{
                  ratio: {{
                    type: "string",
                    enum: ["1:1", "16:9", "9:16"],
                    default: "1:1",
                  }},
                }},
              }},
            }},
          ],
        }},
      ],
    }},
  }},
}};
"""


def create_route(display_name: str) -> str:
    return f"""
export default function registerPluginUiRoutes(app, ctx) {{
  app.get("/page", (c) => c.html(renderShell(c, ctx, "page")));
  app.get("/widget", (c) => c.html(renderShell(c, ctx, "widget")));
}}

function renderShell(c, ctx, surface) {{
  const lucCss = c.req.query("luc-css") || "";
  const theme = c.req.query("luc-theme") || "inherit";
  const assetBase = `/api/plugins/${{encodeURIComponent(ctx.pluginId)}}/assets`;
  const title = {js_string(display_name)};

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${{escapeHtml(title)}}</title>
  ${{lucCss ? `<link rel="stylesheet" href="${{escapeAttr(lucCss)}}">` : ""}}
  <link rel="stylesheet" href="${{assetBase}}/panel.css">
</head>
<body data-luc-theme="${{escapeAttr(theme)}}" data-surface="${{surface}}">
  <div id="root" data-surface="${{surface}}"></div>
  <script type="module" src="${{assetBase}}/panel.js"></script>
</body>
</html>`;
}}

function escapeAttr(value) {{
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}}

function escapeHtml(value) {{
  return escapeAttr(value).replace(/>/g, "&gt;");
}}
"""


def create_direct_panel_js(display_name: str) -> str:
    return f"""
const PROTOCOL = "luc.plugin.ui";
const VERSION = 1;
let seq = 0;

function targetOrigin() {{
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("luc-host-origin");
  if (explicit) return explicit;
  try {{
    return new URL(document.referrer).origin;
  }} catch {{
    return "*";
  }}
}}

function post(message) {{
  window.parent.postMessage(message, targetOrigin());
}}

function event(type, payload) {{
  post({{ protocol: PROTOCOL, version: VERSION, kind: "event", type, payload }});
}}

function request(type, payload, timeoutMs = 10000) {{
  const id = `luc-plugin-${{Date.now()}}-${{++seq}}`;
  const origin = targetOrigin();
  return new Promise((resolve, reject) => {{
    const timeout = window.setTimeout(() => {{
      window.removeEventListener("message", onMessage);
      reject(new Error(`Host request timed out: ${{type}}`));
    }}, timeoutMs);

    function onMessage(evt) {{
      if (evt.source !== window.parent) return;
      if (origin !== "*" && evt.origin !== origin) return;
      const msg = evt.data || {{}};
      if (msg.protocol !== PROTOCOL || msg.version !== VERSION || msg.id !== id || msg.type !== type) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (msg.kind === "error") reject(new Error(msg.error?.message || `Host request failed: ${{type}}`));
      else resolve(msg.payload);
    }}

    window.addEventListener("message", onMessage);
    post({{ protocol: PROTOCOL, version: VERSION, id, kind: "request", type, payload }});
  }});
}}

function currentPluginId() {{
  const match = /^\\/api\\/plugins\\/([^/]+)(?:\\/|$)/.exec(window.location.pathname || "");
  if (!match) throw new Error("Plugin API helper requires an iframe route under /api/plugins/:pluginId/.");
  return decodeURIComponent(match[1]);
}}

function normalizePluginApiPath(input) {{
  if (typeof input !== "string" || !input.trim()) throw new Error("Invalid plugin API path.");
  const trimmed = input.trim();
  if (
    trimmed.includes("\\\\") ||
    trimmed.includes("\\0") ||
    trimmed.includes("#") ||
    trimmed.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) throw new Error("Invalid plugin API path.");

  const stripped = trimmed.replace(/^\\/+/, "");
  if (!stripped || stripped.startsWith("./") || stripped === "api/plugins" || stripped.startsWith("api/plugins/")) {{
    throw new Error("Invalid plugin API path. Use a route path relative to the current plugin.");
  }}
  const queryIndex = stripped.indexOf("?");
  const rawPath = queryIndex >= 0 ? stripped.slice(0, queryIndex) : stripped;
  const segments = rawPath.split("/");
  for (const segment of segments) {{
    if (!segment) throw new Error("Invalid plugin API path.");
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\\\")) {{
      throw new Error("Invalid plugin API path.");
    }}
  }}
  const parsed = new URL(`http://luc.local/${{stripped}}`);
  return `${{segments.map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/")}}${{parsed.search}}`;
}}

function pluginApiUrl(path) {{
  return `${{window.location.origin}}/api/plugins/${{encodeURIComponent(currentPluginId())}}/${{normalizePluginApiPath(path)}}`;
}}

function pluginApiFetch(path, init = {{}}) {{
  const surfaceSession = new URLSearchParams(window.location.search).get("pluginSurfaceSession");
  if (!surfaceSession) throw new Error("luc.api.fetch requires pluginSurfaceSession in the iframe URL.");
  const headers = new Headers(init.headers || {{}});
  headers.set("X-Luc-Plugin-Surface-Session", surfaceSession);
  return fetch(pluginApiUrl(path), {{ ...init, headers }});
}}

const luc = {{
  ready: () => event("luc.ready"),
  ui: {{ resize: (size) => event("ui.resize", size) }},
  api: {{ url: pluginApiUrl, fetch: pluginApiFetch }},
  toast: {{ show: (input) => request("toast.show", input) }},
  external: {{ open: (url) => request("external.open", typeof url === "string" ? {{ url }} : url) }},
  clipboard: {{ writeText: (text) => request("clipboard.writeText", typeof text === "string" ? {{ text }} : text) }},
  resources: {{
    open: (input) => request("resource.open", input),
    pick: (input = {{}}) => request("resource.pick", input),
    requestAccess: (input) => request("resource.requestAccess", input),
  }},
  theme: {{
    getSnapshot: () => {{
      const params = new URLSearchParams(window.location.search);
      return {{ theme: params.get("luc-theme") || undefined, cssUrl: params.get("luc-css") || undefined }};
    }},
  }},
}};

const root = document.getElementById("root");
const surface = root?.dataset.surface || "page";

function render() {{
  if (!root) return;
  root.innerHTML = `
    <main class="panel">
      <section class="card">
        <header class="card-header">
          <div>
            <h1 id="titleText"></h1>
            <p>A no-build Luc plugin panel.</p>
          </div>
          <button id="openBtn" class="button ghost" type="button">Open</button>
        </header>
        <label class="field">
          <span>Title</span>
          <input id="titleInput" type="text">
        </label>
        <div class="row">
          <div>
            <strong>Enabled</strong>
            <p>Local iframe state for this starter panel.</p>
          </div>
          <button id="toggleBtn" class="switch on" type="button" aria-pressed="true"><span></span></button>
        </div>
        <ul class="list">
          <li><span>Tool</span><em>Agent callable</em></li>
          <li><span>Page</span><em>Full iframe</em></li>
          <li><span>Widget</span><em>Sidebar iframe</em></li>
        </ul>
        <footer>
          <button id="copyBtn" class="button primary" type="button">Copy title</button>
        </footer>
      </section>
    </main>
  `;

  const titleInput = document.getElementById("titleInput");
  const titleText = document.getElementById("titleText");
  const toggleBtn = document.getElementById("toggleBtn");
  titleInput.value = {js_string(display_name)};
  titleText.textContent = titleInput.value;

  titleInput.addEventListener("input", () => {{
    titleText.textContent = titleInput.value || {js_string(display_name)};
  }});
  toggleBtn.addEventListener("click", () => {{
    const on = !toggleBtn.classList.contains("on");
    toggleBtn.classList.toggle("on", on);
    toggleBtn.setAttribute("aria-pressed", String(on));
  }});
  document.getElementById("copyBtn").addEventListener("click", async () => {{
    await luc.clipboard.writeText(titleInput.value);
    await luc.toast.show({{ message: "Copied title", type: "success" }});
  }});
  document.getElementById("openBtn").addEventListener("click", () => {{
    luc.external.open("https://example.com");
  }});
}}

render();
luc.ready();
luc.ui.resize({{ height: surface === "widget" ? 320 : 500 }});
"""


def create_direct_panel_css() -> str:
    return """
html,
body,
#root {
  min-height: 100%;
  margin: 0;
}

body {
  background: var(--bg, #f8f5ed);
  color: var(--text, #3b3d3f);
  font-family: var(--font-ui, Inter, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif);
}

* {
  box-sizing: border-box;
}

.panel {
  min-height: 100vh;
  padding: 16px;
}

body[data-surface="widget"] .panel {
  padding: 12px;
}

.card {
  display: grid;
  gap: 14px;
  border: 1px solid var(--border, rgba(83, 125, 150, 0.22));
  border-radius: var(--radius-card, 4px);
  background: var(--bg-card, #fcfaf5);
  padding: 16px;
}

.card-header,
.row,
.list li,
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

h1,
p {
  margin: 0;
}

h1 {
  font-size: 1.05rem;
  font-weight: 650;
}

p,
em {
  color: var(--text-muted, #8e9196);
  font-size: 0.78rem;
  font-style: normal;
}

.field {
  display: grid;
  gap: 6px;
  color: var(--text-light, #6b6f73);
  font-size: 0.78rem;
}

input {
  width: 100%;
  border: 1px solid var(--border, rgba(83, 125, 150, 0.22));
  border-radius: var(--radius-input, 3px);
  background: var(--bg, #f8f5ed);
  color: var(--text, #3b3d3f);
  padding: 8px 10px;
  font: inherit;
}

.button,
.switch {
  border: 1px solid transparent;
  border-radius: var(--radius-input, 3px);
  font: inherit;
  cursor: pointer;
}

.button {
  padding: 8px 12px;
}

.button.primary {
  background: var(--accent, #537d96);
  color: white;
}

.button.ghost {
  background: var(--accent-light, rgba(83, 125, 150, 0.08));
  color: var(--accent, #537d96);
}

.switch {
  width: 38px;
  height: 22px;
  padding: 2px;
  background: var(--border, rgba(83, 125, 150, 0.22));
}

.switch span {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--bg-card, #fcfaf5);
  transition: transform 0.15s ease;
}

.switch.on {
  background: var(--accent, #537d96);
}

.switch.on span {
  transform: translateX(16px);
}

.list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.list li {
  border-top: 1px solid var(--border, rgba(83, 125, 150, 0.18));
  padding-top: 8px;
}
"""


def create_react_panel(display_name: str) -> str:
    return f"""
import {{ useEffect, useMemo, useState }} from 'react';
import {{ createRoot }} from 'react-dom/client';
import {{ luc }} from '@luccode/plugin-sdk';
import {{
  Button,
  CardShell,
  EmptyState,
  LucThemeProvider,
  List,
  Select,
  SettingRow,
  Switch,
  TextInput,
}} from '@luccode/plugin-components';
import '@luccode/plugin-components/styles.css';
import './panel.css';

type ThemeMode = 'inherit' | 'luc' | 'custom';

function Panel() {{
  const surface = document.getElementById('root')?.dataset.surface || 'page';
  const [themeMode, setThemeMode] = useState<ThemeMode>('inherit');
  const [title, setTitle] = useState({js_string(display_name)});
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {{
    luc.ready();
    luc.ui.resize({{ height: surface === 'widget' ? 320 : 520 }});
  }}, [surface]);

  const customTheme = useMemo(() => (
    themeMode === 'custom'
      ? {{ bg: '#F7F4EF', bgCard: '#FFFDF8', accent: '#537D96' }}
      : undefined
  ), [themeMode]);

  async function copyTitle() {{
    await luc.clipboard.writeText(title);
    await luc.toast.show({{ message: 'Copied title', type: 'success' }});
  }}

  return (
    <LucThemeProvider
      mode={{themeMode}}
      theme={{customTheme || (themeMode === 'luc' ? 'warm-paper' : undefined)}}
      className="plugin-panel"
    >
      <CardShell
        title={{title}}
        description="A Luc plugin panel using the SDK and shared components."
        actions={{<Button variant="ghost" onClick={{() => luc.external.open('https://example.com')}}>Open</Button>}}
        footer={{<Button variant="primary" onClick={{copyTitle}}>Copy title</Button>}}
      >
        <SettingRow
          label="Enabled"
          hint="Local iframe state; persist through plugin config when needed."
          control={{<Switch checked={{enabled}} onChange={{setEnabled}} label={{enabled ? 'On' : 'Off'}} />}}
        />
        <SettingRow
          label="Theme"
          control={{
            <Select
              value={{themeMode}}
              onChange={{(value) => setThemeMode(value as ThemeMode)}}
              options={{[
                {{ value: 'inherit', label: 'Follow Luc' }},
                {{ value: 'luc', label: 'Warm paper' }},
                {{ value: 'custom', label: 'Custom' }},
              ]}}
            />
          }}
        />
        <TextInput label="Title" value={{title}} onChange={{(event) => setTitle(event.currentTarget.value)}} />
        <List
          items={{[
            {{ id: 'runtime', title: '@luccode/plugin-runtime', meta: 'Node' }},
            {{ id: 'sdk', title: '@luccode/plugin-sdk', meta: 'iframe' }},
            {{ id: 'components', title: '@luccode/plugin-components', meta: 'React' }},
          ]}}
        />
        {{!enabled && <EmptyState title="Paused" description="Turn the switch back on to resume actions." />}}
      </CardShell>
    </LucThemeProvider>
  );
}}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Panel />);
"""


def create_react_panel_css() -> str:
    return """
html,
body,
#root {
  min-height: 100%;
  margin: 0;
}

body {
  background: var(--luc-plugin-bg, #f8f5ed);
  color: var(--luc-plugin-text, #3b3d3f);
}

.plugin-panel {
  min-height: 100vh;
  box-sizing: border-box;
  padding: 16px;
}

body[data-surface="widget"] .plugin-panel {
  padding: 12px;
}
"""


def create_vite_config() -> str:
    return """
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'assets',
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: path.resolve(__dirname, 'ui', 'Panel.tsx'),
      formats: ['es'],
      fileName: () => 'panel.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => assetInfo.name === 'style.css' ? 'panel.css' : '[name][extname]',
      },
    },
  },
});
"""


def create_tsconfig() -> str:
    return """
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["ui", "vite.config.ts"]
}
"""


def create_readme(
    plugin_id: str,
    display_name: str,
    include_tool: bool,
    include_ui: bool,
    include_lifecycle: bool,
    include_provider: bool,
    template: str,
    audience: str,
) -> str:
    lines = [
        f"# {display_name}",
        "",
        f"Luc plugin id: `{plugin_id}`.",
        "",
    ]
    if audience == "beginner" or template == "direct":
        lines.extend([
            "This is a small Luc plugin starter. Start by changing labels, button actions, and the sample tool.",
            "",
            "## What to edit first",
            "",
            "- `manifest.json`: the name, description, and permissions Luc sees.",
        ])
        if include_provider:
            lines.extend([
                "- `providers/*.js`: the provider declaration Luc discovers.",
                "- Replace the sample CLI executable with the real command before enabling this provider for users.",
            ])
        if include_tool:
            lines.append("- `tools/create-note.js`: the sample action the Agent can call.")
        if include_ui:
            lines.extend([
                "- `assets/panel.js`: the iframe UI behavior.",
                "- `assets/panel.css`: the iframe UI style.",
            ])
    else:
        lines.extend([
            "## Contents",
            "",
            "- `manifest.json`: plugin metadata and capability declarations.",
        ])
        if include_provider:
            lines.append("- `providers/*.js`: provider contribution with explicit chat/media capabilities.")
        if include_tool:
            lines.append("- `tools/create-note.js`: sample SessionFile-aware tool.")
        if include_lifecycle:
            lines.append("- `index.js`: sample lifecycle entry and EventBus handler.")
        if include_ui:
            lines.extend([
                "- `routes/ui.js`: iframe shell and static asset route.",
                "- `ui/Panel.tsx`: React iframe UI built with Luc SDK components.",
                "- `vite.config.ts`: builds `assets/panel.js` and `assets/panel.css`.",
            ])

    lines.extend(["", "## Development", ""])
    if template in REACT_TEMPLATES:
        lines.extend([
            "```bash",
            "npm install",
            "npm run build:ui",
            "npm run typecheck",
            "```",
        ])
    else:
        lines.append("No build step is required for this direct template.")

    lines.extend([
        "",
        "Install by dragging this folder into Luc Settings > Plugins, or place it under the user plugin directory reported by `/api/plugins/settings`.",
        "",
        "## File and resource rules",
        "",
        "- The sample note tool writes plugin-owned output under `ctx.dataDir`, then returns it through `stageFile()` as SessionFile media.",
        "- If you add a feature that reads, edits, or watches user files, use `ctx.resources` with ResourceRef inputs and declare the matching `resource.read`, `resource.search`, `resource.write`, `resource.materialize`, or `resource.watch` capability.",
        "- Use `ctx.resources.watch()` / `ctx.resources.subscribe()` for backend resource watches, release the returned handle, and filter `resource.changed` / `resource.deleted` / `resource.renamed` bus events by `resourceKeys`.",
        "- Browser iframe code may open, pick, or request access to resources through `luc.resources.*`, but real file reads and writes belong in server-side plugin tools, routes, or lifecycle code.",
        "- Do not treat `SessionFile`, mount, URL, or future remote resources as host-local paths. Use `ctx.resources.materialize(ref)` only for libraries that require a concrete execution path, and write back through ResourceIO explicitly.",
        "- If you create plugin-only chat runs, create sessions with `visibility: \"plugin_private\"` and return `createChatSurfaceCard(ctx, session.sessionRef ?? session, options)` from `details.card`. Do not hand-build path-only chat surface payloads.",
    ])
    if include_ui:
        lines.extend([
            "This plugin requires full-access because Luc page and widget contributions are route-backed WebView/iframe UI.",
            "Use WebView/iframe cards for existing web apps, remote sites, or standalone HTML. Use native `chat.surface` only for plugin-owned private session transcripts.",
            "The starter manifest grants only the host calls used by the sample panel. If you add `luc.resources.open()`, `luc.resources.pick()`, or `luc.resources.requestAccess()` calls, add the matching `resource.open`, `resource.pick`, or `resource.requestAccess` entries under `ui.hostCapabilities`.",
        ])
    if include_provider:
        lines.extend([
            "This plugin requires full-access because provider contributions can affect model discovery and runtime execution.",
            "The sample provider is media-only: `chat.projection = \"none\"` keeps it out of chat model selectors.",
            "CLI-backed providers must use structured argument bindings and output contracts; do not replace them with shell command strings.",
            "Do not call legacy media generation EventBus namespaces from new provider plugins; declare `providers/*.js` with `capabilities.media.*`, then use stable media helpers or the formal Adapter Plugin API when available.",
        ])
    return "\n".join(lines)


def scaffold(args: argparse.Namespace) -> Path:
    plugin_id = slugify(args.plugin_id or args.name)
    display_name = args.display_name or titleize(args.name)
    parent = Path(args.path).expanduser().resolve()
    plugin_dir = parent / plugin_id
    template = choose_scaffold_template(args)
    include_tool = args.kind in {"tool", "full"}
    include_ui = args.kind in {"ui", "full"}
    include_lifecycle = args.kind == "full"
    include_provider = args.kind == "provider"

    if plugin_dir.exists():
        if not args.force:
            raise SystemExit(f"{plugin_dir} already exists. Pass --force to replace it.")
        shutil.rmtree(plugin_dir)
    plugin_dir.mkdir(parents=True, exist_ok=True)

    luc_root = find_luc_root(Path.cwd(), parent)
    root_package = read_package_json(luc_root)
    sdk_mode = choose_sdk_mode(args.sdk_mode, luc_root, template)
    sdk_packages = required_sdk_packages(include_tool, include_ui, include_lifecycle, template)
    bundled_sdk = prepare_bundled_sdk(plugin_dir, sdk_packages) if sdk_mode == "bundled" else {}

    write_json(plugin_dir / "manifest.json", manifest_for(
        args,
        plugin_id,
        display_name,
        include_tool,
        include_ui,
        include_lifecycle,
        include_provider,
    ))
    if template in REACT_TEMPLATES:
        write_json(plugin_dir / "package.json", package_json_for(
            plugin_dir,
            luc_root,
            root_package,
            plugin_id,
            include_tool,
            include_ui,
            include_lifecycle,
            template,
            sdk_mode,
            bundled_sdk,
        ))
    write_text(plugin_dir / "README.md", create_readme(
        plugin_id,
        display_name,
        include_tool,
        include_ui,
        include_lifecycle,
        include_provider,
        template,
        args.audience,
    ))

    if include_tool:
        tool_source = create_runtime_tool(plugin_id, display_name) if template in REACT_TEMPLATES else create_direct_tool(plugin_id, display_name)
        write_text(plugin_dir / "tools" / "create-note.js", tool_source)
    if include_lifecycle:
        index_source = create_runtime_index(plugin_id, display_name) if template in REACT_TEMPLATES else create_direct_index(plugin_id, display_name)
        write_text(plugin_dir / "index.js", index_source)
    if include_provider:
        write_text(plugin_dir / "providers" / f"{plugin_id}-provider.js", create_provider_contribution(plugin_id, display_name))
    if include_ui:
        write_text(plugin_dir / "routes" / "ui.js", create_route(display_name))
        if template in REACT_TEMPLATES:
            write_text(plugin_dir / "ui" / "Panel.tsx", create_react_panel(display_name))
            write_text(plugin_dir / "ui" / "panel.css", create_react_panel_css())
            write_text(plugin_dir / "vite.config.ts", create_vite_config())
            write_text(plugin_dir / "tsconfig.json", create_tsconfig())
        else:
            write_text(plugin_dir / "assets" / "panel.js", create_direct_panel_js(display_name))
            write_text(plugin_dir / "assets" / "panel.css", create_direct_panel_css())

    return plugin_dir


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a Luc plugin scaffold.")
    parser.add_argument("name", help="Human-facing plugin name, for example 'Finance Panel'.")
    parser.add_argument("--plugin-id", help="Stable plugin id. Defaults to a slugified name.")
    parser.add_argument("--display-name", help="Display name. Defaults to title-cased name.")
    parser.add_argument("--description", help="Manifest description.")
    parser.add_argument("--path", default="examples/plugins", help="Parent directory for the plugin. Defaults to examples/plugins.")
    parser.add_argument("--kind", choices=["tool", "ui", "full", "provider"], default="full", help="Scaffold shape.")
    parser.add_argument("--audience", choices=["auto", "beginner", "developer"], default="auto", help="Controls generated README tone and auto template choice.")
    parser.add_argument("--template", choices=["auto", "direct", "guided-react", "professional-react"], default="auto", help="UI/project template.")
    parser.add_argument("--sdk-mode", choices=["auto", "workspace", "bundled"], default="auto", help="SDK dependency source for React templates.")
    parser.add_argument("--min-app-version", default="0.159.0", help="Manifest minAppVersion.")
    parser.add_argument("--dev-scenario", action="store_true", help="Add a first-phase manifest.dev.scenarios smoke test.")
    parser.add_argument("--force", action="store_true", help="Replace an existing plugin directory.")
    args = parser.parse_args()

    plugin_dir = scaffold(args)
    template = choose_scaffold_template(args)
    print(f"Created Luc plugin scaffold: {plugin_dir}")
    print(f"Template: {template}")
    print("Next steps:")
    print("  1. Review manifest.json capabilities and trust.")
    if args.kind == "provider":
        print("  2. Edit the provider declaration under providers/ and replace the sample CLI executable.")
        print("  3. Install or drag the plugin folder into Luc with full-access enabled.")
    elif template in REACT_TEMPLATES:
        print("  2. Run npm install inside the plugin directory.")
        print("  3. Run npm run build:ui to produce assets/panel.js and assets/panel.css.")
    else:
        print("  2. Install or drag the plugin folder into Luc; no build step is required.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
