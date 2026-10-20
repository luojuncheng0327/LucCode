# Community Plugin Development Guide

> This document is for community developers who want to build user-installable plugins.
> System plugins (built-in features) use the same plugin format, placed in the project's `plugins/` directory and bundled with the app.

## Quick Start

1. Create a folder with a tool file:

```text
my-plugin/
└── tools/
    └── hello.js
```

```js
// tools/hello.js
export const name = "hello";
export const description = "Say hello to someone";
export const parameters = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};
export async function execute(input) {
  return `Hello, ${input.name}!`;
}
```

2. Open LucCode → Settings → Plugins, drag the folder into the install area (or drag a .zip)
3. After installation, the Agent can immediately call `my-plugin_hello`
4. Uninstall: click the delete button on the plugins page

## From Idea To Plugin

Pick the plugin shape first, then follow the manifest, runtime, and UI guidance in the sections below:

| Shape | Best for | Permission |
|------|----------|------------|
| Tool-only | No UI, adds Agent-callable tools | `restricted` |
| Runtime | Lifecycle, EventBus, background tasks, dynamic tools | `full-access` |
| UI | Page / widget / WebView/iframe card / `chat.surface` | `full-access` |
| Marketplace entry | Makes the plugin discoverable in the marketplace | `luccode-plugins/plugins/<id>.yaml` |

Start with the `luc-plugin-creator` scaffold, then delete what you do not need:

```bash
python3 skills2set/luc-plugin-creator/scripts/create_luc_plugin.py "My Plugin" --path examples/plugins --kind full
```

Debug order: install the local folder, inspect Settings diagnostics, finish README/manifest, then add an `luccode-plugins` marketplace entry when the plugin is ready to publish.

### Agent-Assisted Dev Loop

When an Agent such as Luc or Codex is building a plugin on the user's behalf,
prefer the dev loop over copying a half-finished plugin into the real plugin
directory:

1. Keep the plugin source in the current workspace, or in `${LUC_HOME}/plugin-dev-sources/`.
2. Call the EventBus `plugin.dev.install` or HTTP `POST /api/plugins/dev/install` to copy the source into `${LUC_HOME}/plugins-dev/<pluginId>` and load it.
3. After editing the source, call `plugin.dev.reload` or `POST /api/plugins/dev/:id/reload`.
4. To control the lifecycle, call `plugin.dev.disable`, `plugin.dev.enable`, `plugin.dev.reset`, `plugin.dev.uninstall`, or their HTTP counterparts: `PUT /api/plugins/dev/:id/enabled`, `POST /api/plugins/dev/:id/reset`, `DELETE /api/plugins/dev/:id`.
5. Smoke-test tool plugins with `plugin.dev.invokeTool` or `POST /api/plugins/dev/:id/tools/:toolName/invoke`. Prefer passing `sessionId` or `sessionRef` in the call body; `sessionPath` is only a legacy locator kept for older plugins.
6. For diagnostics, use `plugin.dev.diagnostics` or `GET /api/plugins/dev/diagnostics`.

The Agent-visible dev tools are off by default. The user has to enable "allow
Agent plugin development tools" under Settings → Plugins → Permissions. Only
then does the Agent see `plugin_dev_install`, `plugin_dev_reload`,
`plugin_dev_disable`, `plugin_dev_enable`, `plugin_dev_reset`,
`plugin_dev_uninstall`, `plugin_dev_invoke_tool`, `plugin_dev_diagnostics`,
`plugin_dev_list_surfaces`, `plugin_dev_describe_surface` and
`plugin_dev_run_scenario`.

Dev-mode permissions come from the dev slot Luc remembers, not from what the
manifest declares for itself. `devRunId` is the run guard for one dev
install/reload cycle; pass it to enable/disable/reset/uninstall so a stale
context cannot act on a newer dev slot. Dev operations may only touch the
runtime copy under `${LUC_HOME}/plugins-dev/`. They never write to
`${LUC_HOME}/plugins/` and never pollute the disable preferences of a real
installed plugin.

A `full-access` dev plugin must pass `allowFullAccess: true` explicitly. The
global community-plugin switch does not grant full access to dev-mode plugins.

When debugging UI plugins, use `plugin.dev.listSurfaces` to find the page or
widget, then `plugin.dev.describeSurfaceDebug` for an element-first debugging
description. The Agent should read the accessibility tree, text, roles and
labels and act on those semantic elements directly; screenshots are for visual
confirmation, layout checks, or as a fallback when semantic information is
insufficient.

#### Dev Scenarios

`manifest.json` may declare `dev.scenarios` for local development and Agent
smoke tests only. The production runtime ignores this field group.

```json
{
  "dev": {
    "scenarios": [
      {
        "id": "hello-tool",
        "steps": [
          { "invokeTool": { "name": "hello", "input": { "name": "Luc" } } },
          { "expectToolText": "hello Luc" }
        ]
      }
    ]
  }
}
```

An `invokeTool` step may carry `sessionId`, `sessionRef`, `sessionPath` and
`agentId`. Of these, `sessionId` / `sessionRef` are the currently recommended
session identity; `sessionPath` is kept only for legacy plugins and locator
compatibility. The first phase supports `invokeTool`, `expectToolText` and
`openSurface`. A scenario that mutates external state must declare
`"destructive": true`, and the run must additionally pass
`allowDestructive: true`.

## Installation & Management

### Installation Methods

- **Drag-and-drop**: Drag a plugin folder or .zip into Settings → Plugins install area
- **File picker**: Click the install area and select a plugin folder or .zip via the file picker
- **Manual**: Place the plugin directory in `${LUC_HOME}/plugins/`. The actual path is shown in Settings → Plugins or via `/api/plugins/settings` as `plugins_dir`

### Management

All operations take effect immediately, no restart required:

- **Enable/Disable**: Each plugin has its own toggle
- **Delete**: Removes plugin code; plugin data (`plugin-data/{pluginId}/`) is preserved
- **Upgrade**: Dragging in a new version with the same name unloads the old plugin and loads the new one; lifecycle resources should be cleaned up via `onunload` / disposables

### Plugin Data

Plugin private data is stored in `${LUC_HOME}/plugin-data/{pluginId}/`. This directory is preserved when the plugin is deleted, so config persists across reinstalls.

## Directory Structure

```text
my-plugin/
├── manifest.json          # Optional, only needed for complex declarations
├── tools/                 # Tools (called by Agent)
│   └── *.js
├── skills/                # Knowledge injection (Markdown)
│   └── my-skill/
│       └── SKILL.md
├── commands/              # User commands (slash-triggered)
│   └── *.js
├── agents/                # Agent templates (JSON)
│   └── *.json
├── routes/                # HTTP routes (requires full-access)
│   └── *.js
├── providers/             # Provider declarations: chat/media capabilities (requires full-access)
│   └── *.js
├── extensions/            # Pi SDK extension factories (requires full-access)
│   └── *.js
└── index.js               # Optional, stateful plugin entry point, loaded last (requires full-access)
```

Contribution types marked "requires full-access" only take effect when the manifest declares `"trust": "full-access"` and the user enables the full-access toggle.

## Permission Model

Community plugins have two permission levels. This determines which system capabilities a plugin can access.

### Restricted (default)

No manifest declaration needed; community plugins default to restricted.

**What you can do:**

| Capability | Description |
|------------|-------------|
| `tools/*.js` | Declare tools for Agent to call |
| `skills/` | Markdown knowledge injection |
| `commands/*.js` | User commands |
| `agents/*.json` | Agent templates (JSON declarations) |
| `ctx.config` | Read/write own configuration |
| `ctx.dataDir` | Own data directory |
| `bus.emit / subscribe / request` | Publish events, subscribe to events, call others' capabilities |
| `contributes.configuration` | JSON Schema config declarations |

**What you cannot do:** `bus.handle`, routes, extensions, providers, `registerTool`, lifecycle (onload/onunload).

Restricted plugin tool/command code runs in the main process with full Node.js API access. The permission model controls "which system extension points you get", not code-level sandboxing.

### Full-access

Declare `"trust": "full-access"` in manifest:

```json
{
  "id": "my-advanced-plugin",
  "trust": "full-access",
  "minAppVersion": "1.0.0"
}
```

`minAppVersion` (optional) declares the minimum LucCode version required to run the plugin. If the current app version is lower, the plugin will not load and its status is set to `incompatible`. All plugins should declare this field to prevent compatibility issues on older versions.

The user must enable the "Allow full-access plugins" toggle in Settings → Plugins. **When the toggle is off, full-access plugins are not loaded at all** (no partial loading) until the user explicitly enables it.

In addition to restricted capabilities:

| Capability | Description |
|------------|-------------|
| `bus.handle` | Register capabilities for other plugins to call |
| `routes/*.js` | HTTP endpoints |
| `extensions/*.js` | Pi SDK event interception (tool calls, provider requests, etc.) |
| `providers/*.js` | Provider declarations: chat/media capabilities |
| `ctx.registerTool` | Dynamically register tools at runtime |
| `onload` / `onunload` | Lifecycle hooks |

**Plugins without `trust` or with any other value are treated as restricted.**

## Contribution Types

### Tools

`tools/*.js` each file exports:

```js
export const name = "search";           // required
export const description = "...";       // required
export const parameters = { ... };      // JSON Schema, optional
export async function execute(input, toolCtx) {  // required
  // input: user-provided parameters
  // toolCtx: { pluginId, pluginDir, dataDir, sessionId, sessionRef, sessionPath, bus, network, config, log, registerSessionFile, stageFile }
  return "result";
}
```

- Automatically namespaced: `pluginId_name` (e.g. `my-plugin_search`)
- Restricted plugins' `toolCtx.bus` only has `emit/subscribe/request`, not `handle`
- New plugins can use `defineTool()` from `@luccode/plugin-runtime` for types and default parameters. The current static `tools/*.js` loader still reads named exports.
- Agent-callable tools should declare `sessionPermission`. Use `readOnly: true` for pure reads, `kind: "plugin_output"` for bounded `ctx.dataDir` writes returned through `stageFile()`, and `kind: "external_side_effect"` for provider, network, platform, or account actions that Auto mode should send to the reviewer. Tools that modify user workspace files should remain reviewer-bound unless they describe a narrower side effect with `describeSideEffect(input)`.

```js
import { defineTool } from '@luccode/plugin-runtime';

const tool = defineTool({
  name: "search",
  description: "Search project data",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"]
  },
  sessionPermission: { readOnly: true },
  async execute(input, ctx) {
    ctx.log.info("search", input.query);
    return `results for ${input.query}`;
  }
});

export const { name, description, parameters, execute } = tool;
```

#### User Resource Access

Use `ctx.resources` when a plugin needs to read or modify user resources. A resource can be a local file, mounted file, `SessionFile`, Resource record, or URL. Declare the exact capabilities in `manifest.json`:

```json
{
  "capabilities": ["resource.read", "resource.search", "resource.write"]
}
```

```js
export async function execute(input, ctx) {
  const ref = { kind: "mount", mountId: input.mountId, path: input.path };
  const file = await ctx.resources.read(ref);
  await ctx.resources.write(ref, file.content.toString("utf-8") + "\nupdated\n");
  return "updated";
}
```

`resource.read` covers `stat`, `read`, and `list`; `resource.search` covers search, including filename search through provider options; `resource.write` covers `write`, `writeExpectedVersion`, `edit`, `mkdir`, `delete`, `copy`, `rename`, `move`, and `trash`; `resource.materialize` is for turning a resource into a concrete local path; `resource.watch` resolves watch targets. URL resources stay read-only. Plugin-generated artifacts may still be written under `ctx.dataDir` and returned with `stageFile()`, but user resource reads and writes should not use raw local paths or `fs.writeFileSync`.

ResourceIO is the only authority path for user resources. `local-file`, `mount`, `session-file`, `resource`, and `url` refs are resource identities, not guarantees that the plugin can see a host-local path. `stageFile()` is only for plugin-generated artifacts entering the `SessionFile` delivery flow. `ctx.dataDir` and packaged `assets/` are plugin-owned storage where raw `fs` is acceptable; workspace, mount, URL, and SessionFile inputs are not covered by that exception. If a third-party library needs a concrete local path, call `ctx.resources.materialize(ref)` and keep any write-back as an explicit ResourceIO operation instead of mutating the materialized file as the source.

#### Media Delivery

When a tool needs to deliver files, first stage the local file as a `SessionFile` for the current session, then return the staged media item through `details.media.items`:

```js
import { createMediaDetails } from "@luccode/plugin-runtime";

const staged = toolCtx.stageFile({
  sessionId: toolCtx.sessionId,
  sessionRef: toolCtx.sessionRef,
  filePath: "/path/to/image.png",
  label: "image.png",
});

return {
  content: [{ type: "text", text: "Image generated" }],
  details: createMediaDetails([staged]),
};
```

The framework automatically extracts `details.media` and delivers files according to context: desktop renders file cards, Bridge sends through the target platform, and Mobile PWA / remote frontends read through the same `SessionFile` / Resource identity. The new protocol prefers structured `session_file` entries in `details.media.items`; `mediaUrls` remains only as a compatibility field for old tools and remote URLs. Local files must not bypass `stageFile()` / `stage_files` through `MEDIA:/path`, `file://`, or `mediaUrls`; register them as `session_file` entries first. Do not create private plugin file cards as a substitute for `SessionFile`.

When a plugin produces local files directly, call `toolCtx.stageFile({ sessionId, sessionRef, filePath, label })` to attach them to the current session and obtain a ready-to-return media item. `registerSessionFile` remains available as a lower-level compatibility API, but new plugins should use `stageFile` so file ownership and media delivery stay coupled. `sessionId` / `sessionRef` are the preferred identity fields; `sessionPath` remains only as a legacy compatibility locator. `filePath` must be absolute. Luc records these files as `storageKind: "plugin_data"`, so they are treated as plugin data or generated output and are not removed by the session temporary-cache cleaner. Plugins should not assign temporary-cache lifecycle to arbitrary local paths; that lifecycle belongs to the framework.

Boundaries:

- Plugin-generated files: `origin: "plugin_output"`, `storageKind: "plugin_data"`
- Async plugin-generated files must still be registered as `SessionFile` when the background task finishes; a card may show task state and result references, but it does not own the file lifecycle
- User uploads, Bridge inbound attachments, browser screenshots, and legacy `create_artifact` compatibility outputs are registered by the framework as `managed_cache`
- Install sources such as `.skill`, plugin folders, or zip files are registered by install routes as `install_source`
- Cards own interactive presentation; files remain resources. If a card needs a file, reference the `SessionFile` instead of embedding file bytes in the card payload

#### External Data Access

When a plugin needs live scores, weather, prices, external search results, or third-party platform data, new code should use the host-provided `ctx.network.fetch()` helper for outbound HTTP APIs. The iframe page calls only this plugin's own route, such as `luc.api.fetch("api/live-scores")`; the route handler then calls `ctx.network.fetch("https://...")`. This keeps iframe authentication, outbound host declarations, timeouts, caching, and response-size limits inside the host runtime boundary.

`ctx.network.fetch()` requires an explicit `network.fetch` capability plus allowed hosts in the manifest:

```json
{
  "trust": "full-access",
  "capabilities": ["network.fetch"],
  "network": {
    "allowedHosts": ["site.api.espn.com"],
    "methods": ["GET"],
    "defaultTimeoutMs": 8000,
    "maxResponseBytes": 1048576
  }
}
```

```js
// routes/api.js
route.get("/live-scores", async (c) => {
  const ctx = c.get("pluginCtx");
  const res = await ctx.network.fetch(
    "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard",
    { cacheTtlMs: 30_000 },
  );
  return c.json(await res.json());
});
```

Boundaries:

- `allowedHosts` contains hostnames; `*.example.com` matches subdomains; an empty list rejects every external host
- The default method set is `GET`; declare `POST`, `PUT`, or other methods in `network.methods` when needed
- HTTPS is required by default; `http://127.0.0.1`, `localhost`, and private-network targets require `"allowLocalhost": true`
- `timeoutMs`, `cacheTtlMs`, and `maxResponseBytes` may override manifest defaults per call
- API keys, tokens, and cookies must not live in `assets/` or iframe JS; store them through configuration schema and read them on the route side
- Older plugins that already call Node `fetch()` directly from routes remain compatible; new plugins, templates, and Agent-generated code should use `ctx.network.fetch()` so diagnostics can point to missing capability, host, method, or size declarations

#### Scheduled Automation Actions

Scheduled automation `plugin_action` executors reuse plugin tools in v0. A job stores `{ pluginId, actionId, params }` as JSON and maps it to the loaded tool named `pluginId_actionId` at runtime.

Both static `tools/*.js` exports and dynamic `ctx.registerTool()` tools receive the SDK-style `(input, ctx)` call. If the plugin is disabled, missing, or the tool cannot be found, the scheduled run fails explicitly and records the error in cron history. Luc does not silently fall back to an Agent session.

#### Visual Cards

Tools can automatically render visual cards in the chat by declaring `card` in the return value's `details`. Current stable shapes are:

- `type: "iframe"` / `type: "webview"` for plugin web UI, remote pages, standalone HTML, or complex browser UI. The old `iframe` type remains compatible; new docs treat it as the WebView escape hatch.
- `type: "chat.surface"` for showing a plugin-owned `plugin_private` / `private` session transcript natively in the current chat stream. It accepts `sessionId/sessionRef`; the host verifies same-plugin ownership before rendering.

Naming boundary: `workbench` is a legacy code namespace, not a public concept for new plugin authors. The public surface today is `chat.surface` for native transcripts plus WebView/iframe UI.

```js
return {
  content: [{ type: "text", text: "Data summary..." }],
  details: {
    card: {
      type: "webview",
      route: "/card/chart?symbol=sh600519&period=daily",
      title: "Kweichow Moutai Daily K",
      description: "Kweichow Moutai price 1450.00 change +2.11%",
    },
  },
};
```

- `route`: Plugin route path; the WebView/iframe fetches data and renders from this path
- `title`: Card title (optional)
- `description`: Plain text summary, used for IM platform fallback and when the plugin is uninstalled
- `pluginId` is auto-injected by the framework; tools don't need to set it
- Cards render immediately when the tool completes, independent of LLM behavior
- Card data is stored in JSONL with the toolResult and auto-restored on session reload
- Custom messages sent by plugin routes or the Session Bus use the same `details.card` extraction path and are restored as `plugin_card` blocks during history replay
- Cards can be adapted by Bridge, Mobile PWA, or future remote clients, while their related files still restore through the `SessionFile` lifecycle

Native chat surface example:

```js
import { createChatSurfaceCard, createSession } from "@luccode/plugin-runtime";

const child = await createSession(ctx, {
  kind: "tavern-run",
  visibility: "plugin_private",
  cwd: ctx.dataDir,
});

return {
  content: [{ type: "text", text: "Created a plugin-private session." }],
  details: {
    card: createChatSurfaceCard(ctx, child.sessionRef ?? child, {
      title: "Tavern run",
      description: "Plugin-private transcript",
    }),
  },
};
```

In main, `chat.surface` is a thin native transcript surface. Rich composer and
native card composition are not part of the public SDK contract yet.

### Skills (Knowledge Injection)

`skills/*/SKILL.md`, standard frontmatter format:

```markdown
---
name: my-skill
description: What this skill does
---
# Content
The Agent loads this knowledge automatically when needed.
```

Zero code, same pattern as Claude Code skills.

### Commands (User Commands)

`commands/*.js` each file exports:

```js
export const name = "focus";
export const description = "Start focus mode";
export async function execute(args, cmdCtx) {
  // args: user input text
  // cmdCtx: { sessionId, sessionRef, sessionPath, agentId, bus, config, log }
}
```

### Agents (Agent Templates)

`agents/*.json`:

```json
{
  "name": "Translator",
  "systemPrompt": "You are a translator.",
  "defaultModel": "gpt-4o",
  "defaultTools": ["web-search"]
}
```

### Routes (HTTP Routes) ⚡ full-access

`routes/*.js` supports three patterns, auto-mounted at `/api/plugins/{pluginId}/...`:

**Pattern A: Factory function** (recommended, ctx available as parameter)

```js
// routes/chat.js
export default function (app, ctx) {
  app.post("/send", async (c) => {
    const { text } = await c.req.json();
    const result = await ctx.bus.request("session:send", {
      text,
      sessionId: ctx.sessionId,
      sessionRef: ctx.sessionRef,
    });
    return c.json(result);
  });
}
```

**Pattern B: Static Hono app** (get ctx via middleware)

```js
// routes/webhook.js
import { Hono } from "hono";
const route = new Hono();
route.get("/webhook", (c) => {
  const ctx = c.get("pluginCtx");
  return c.json({ ok: true, plugin: ctx.pluginId });
});
export default route;
```

**Pattern C: Register export**

```js
// routes/status.js
export function register(app, ctx) {
  app.get("/status", (c) => c.json({ pluginId: ctx.pluginId }));
}
```

All three patterns are backward-compatible: plugins that don't use ctx need no changes. `ctx.bus` can directly call built-in session operations: `session:create`, `session:get`, `session:update`, `session:send`, `session:abort`, `session:history`, `session:list`, `agent:list`, `agent:profile`, `agent:create`, and `agent:update`. Operations against an existing session must include `sessionId` or `sessionRef`; `sessionPath` remains a legacy compatibility input. See the Route Context and Session Bus Handlers sections below for the full API.

#### Request-level context (pluginRequestContext)

Every HTTP request entering a plugin route gets its own request-level context, readable via `c.get("pluginRequestContext")` in all three patterns:

```js
app.post("/create-session", async (c) => {
  const reqCtx = c.get("pluginRequestContext");
  // reqCtx.principal        identity behind this request (owner device / this plugin's iframe surface…), null when invoked directly in tests
  // reqCtx.agentId          which agent this request belongs to; null means the
  //                         surface belongs to no agent right now (a preview,
  //                         for example) — it is not a stand-in for a default one
  // reqCtx.capabilityGrant  { accessLevel, declaredPermissions, legacyDeclaration }
  if (!reqCtx.agentId) {
    return c.json({ error: "this surface has no agent yet" }, 400);
  }
  const result = await reqCtx.bus.request("session:create", { agentId: reqCtx.agentId });
  return c.json(result);
});
```

`reqCtx.bus` differs from `ctx.bus` in one way: calling a system-sensitive capability through it (catalog entries with `owner: "system"` and a `permission`, e.g. `session:create` → `session.write`) is checked against the manifest declaration plus the user grant. A permission missing from manifest `capabilities` / `sensitiveCapabilities` (namespaces work: `session` covers `session.write`) returns 403 `PLUGIN_CAPABILITY_NOT_DECLARED`; a plugin without full access returns 403 `PLUGIN_CAPABILITY_NOT_GRANTED`. Error responses carry `capability` / `permission` / `pluginId` / `declared` / `granted` so the missing piece is immediately visible. Legacy manifests with no capability declarations at all (both fields absent) are treated as declaring everything, so existing plugins keep working; once either list is explicitly written, the declaration is enforced strictly — an explicit empty array (`"capabilities": []`) is not legacy and denies every system-sensitive capability. Prefer `reqCtx.bus` when handling requests that originate from iframe pages.

### Extensions (Pi SDK Event Interception) ⚡ full-access

Each `.js` file in the `extensions/` directory exports a factory function that receives Pi SDK's `ExtensionAPI` and subscribes to LLM pipeline events:

```js
// extensions/strip-empty-tools.js
export default function(pi) {
  pi.on("before_provider_request", (event) => {
    const p = event.payload;
    if (p && Array.isArray(p.tools) && p.tools.length === 0) {
      delete p.tools;
    }
    return p;
  });
}
```

Common events:

| Event | Timing | What you can do |
|-------|--------|-----------------|
| `tool_call` | Before tool execution | Modify args, block the call |
| `tool_result` | After tool returns | Modify the result |
| `before_provider_request` | Before HTTP request | Rewrite payload |
| `context` | Before each LLM call | Filter/inject messages |
| `before_agent_start` | After user input | Inject system prompt |
| `input` | When user input arrives | Intercept/transform input |

Factory functions are invoked by Pi SDK at session creation time; handlers fire when the corresponding event occurs. After a full-access plugin is installed, enabled, or reloaded, Luc rebinds extension runners for currently idle sessions; sessions that are streaming, compacting, or switching are skipped and pick up the new extension set on the next safe rebuild. See Pi SDK extension documentation for the full event list.

`extensions/` remains a full-access boundary. Restricted plugins that include an `extensions/` directory do not load those factories. If a plugin needs to intercept provider requests, tool calls, or context construction, it must declare `"trust": "full-access"` and the user must enable the full-access plugin toggle.

### Providers (Provider Contribution) ⚡ full-access

`providers/*.js` export a ProviderPlugin data object:

```js
export const id = "my-llm";
export const displayName = "My LLM Service";
export const authType = "api-key";
export const defaultBaseUrl = "https://api.my-llm.com/v1";
export const defaultApi = "openai-completions";
```

Providers can declare multiple capabilities. Chat surfaces consume `capabilities.chat`; image/video/speech tools consume `capabilities.media.*`. Media-only providers should set `chat.projection = "none"` so they never appear in the chat model selector.

```js
export const id = "my-image-cli";
export const displayName = "My Image CLI";
export const authType = "none";

export const runtime = {
  kind: "local-cli",
  protocolId: "local-cli-media",
  command: {
    executable: "my-image-cli",
    args: [
      { literal: "generate" },
      { option: "--prompt", from: "prompt" },
      { option: "--model", from: "modelId" },
      { option: "--output", from: "outputDir" },
    ],
    timeoutMs: 120000,
    output: { kind: "file_glob", directory: "outputDir", pattern: "*.png" },
  },
};

export const capabilities = {
  chat: { projection: "none" },
  media: {
    imageGeneration: {
      models: [
        {
          id: "my-image-model",
          displayName: "My Image Model",
          protocolId: "local-cli-media",
          inputs: ["text"],
          outputs: ["image"],
        },
      ],
    },
  },
};
```

CLI providers must use structured argument bindings. Do not build shell command strings; Luc runs commands through non-shell `execFile` / `spawn` paths and collects outputs into the media task directory.

### Configuration (Config Schema)

Declare in `manifest.json` under `contributes.configuration` using JSON Schema:

```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "interval": { "type": "number", "default": 25, "title": "Work interval (minutes)" },
        "sound": { "type": "boolean", "default": true, "title": "Completion sound" }
      }
    }
  }
}
```

Read/write config via `ctx.config.get(key)` / `ctx.config.set(key, value)`, persisted in `plugin-data/{pluginId}/config.json`.

### Page (Plugin Page) ⚡ full-access

A plugin can register a full-page view in the top tab bar, at the same level as "Chat/Channel". When the user switches to that tab, the plugin's iframe occupies the entire window space.

Declare in `manifest.json` under `contributes`:

```json
{
  "contributes": {
    "page": {
      "title": { "zh": "金融", "en": "Finance" },
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5'><polyline points='22 12 18 12 15 21 9 3 6 12 2 12'/></svg>",
      "route": "/dashboard"
    }
  }
}
```

- `title`: Display name. Accepts a plain string or an i18n object `{ zh, en, ... }`
- `icon`: Strongly recommended to provide an inline SVG (stroke style, `currentColor`). Falls back to the first character of the title if omitted
- `route`: Relative path for the plugin route. The actual URL is `/api/plugins/{pluginId}{route}`
- A plugin can declare both a `page` and a `widget` simultaneously — they are independent
- Hovering over the tab shows the plugin's full name (tooltip)
- When there are more than 5 tabs, extras are collapsed into an overflow dropdown menu; users can drag to reorder

Plugin pages are rendered via WebView/iframe. New plugins should use `@luccode/plugin-sdk` for handshake and host requests:

```js
import { luc } from '@luccode/plugin-sdk';

luc.ready();
luc.ui.resize({ height: 320 });
await luc.toast.show({ message: 'Refreshed', type: 'success' });
await luc.external.open('https://example.com');
await luc.clipboard.writeText('Copied text');
await luc.resources.open({ resource: { kind: 'session-file', fileId: 'sf_1' }, mode: 'preview' });
```

The lower-level `luc.host.request(type, payload)` remains available for future or experimental capabilities. Prefer typed helpers for stable capabilities.

For compatibility, the host still accepts the legacy handshake:

```js
window.parent.postMessage({ type: 'ready' }, '*');
```

The host accepts messages only from the current iframe window and matching origin. SDK requests go through the capability registry. Current built-in capabilities include `toast.show` (no grant required), `external.open` (grant required), `clipboard.writeText` (grant required), and resource request helpers `resource.open`, `resource.pick`, and `resource.requestAccess` (grant required).

Grant-required iframe host capabilities must be declared in the manifest:

```json
{
  "manifestVersion": 1,
  "ui": {
    "hostCapabilities": ["external.open", "clipboard.writeText", "resource.open"]
  }
}
```

Sensitive capabilities that are not declared return `CAPABILITY_DENIED`. Unknown capability names are ignored at load time; `toast.show` does not need to be declared.

`luc.resources.*` only sends host-mediated requests from the iframe: it can ask Luc to open a resource, pick resources, or request access, but it cannot read or write file contents directly. Actual user-resource reads and writes stay in server-side plugin routes, tools, or lifecycle code through `ctx.resources` and ResourceIO.

The host appends `luc-theme` and `luc-css` query parameters to the iframe URL. Plugins can optionally reference the theme CSS for visual consistency:

```html
<link rel="stylesheet" href="${new URLSearchParams(location.search).get('luc-css')}">
```

Static frontend resources belong under the plugin's `assets/` directory and are served by the Luc host at `/api/plugins/{pluginId}/assets/...`. This follows the same boundary idea as VS Code Webview resources: the entry route is opened with the local token or `pluginIframeTicket`; after a successful page response, the host issues a short-lived HttpOnly cookie scoped only to `/api/plugins/{pluginId}/assets/`. Vite split chunks, `React.lazy()` imports, CSS, fonts, images, JSON, wasm, and browser-playable video files such as MP4/WebM/MOV should not depend on `?token` or `pluginIframeTicket`. Video assets support HTTP byte ranges for `<video>` playback and seeking.

When page scripts call the plugin's own dynamic route APIs, prefer `luc.api.fetch()` from `@luccode/plugin-sdk`. It derives the current plugin id from the iframe route and sends the surface session credential that the host appended to the iframe URL:

```js
import { luc } from '@luccode/plugin-sdk';

const res = await luc.api.fetch('create-session', {
  method: 'POST',
});
```

When converting a website into a plugin, rewrite same-plugin `fetch('/api/...')` calls to `luc.api.fetch(...)` instead of hard-coding `/api/plugins/{pluginId}/...` in browser code. The lower-level protocol is: the host appends the surface session as the `pluginSurfaceSession` query parameter, and page scripts send it back with the `X-Luc-Plugin-Surface-Session` header (or a query parameter of the same name):

```js
const surfaceSession = new URLSearchParams(location.search).get('pluginSurfaceSession');
const res = await fetch('/api/plugins/my-plugin/create-session', {
  method: 'POST',
  headers: { 'X-Luc-Plugin-Surface-Session': surfaceSession },
});
```

This credential only authorizes the plugin's own proxied route paths and carries no host scopes; the host strips it from the request before forwarding to the plugin handler. `pluginIframeTicket` is a one-time document-load credential. Do not reuse it for XHR or static resource URLs.

Browser code should prefer the SDK helper:

```js
import { luc } from '@luccode/plugin-sdk';

const iconUrl = luc.assets.url('images/icon.svg');
const bgVideoUrl = luc.assets.url('videos/background.mp4');
```

The server-side shell can also point directly at the same host-served path:

```html
<script type="module" src="/api/plugins/my-plugin/assets/dist/app.js"></script>
```

Treat `assets/` as a public static root. Put only built files and public media there. Do not put source files, secrets, private config, or runtime data in it. The host rejects path traversal, dotfiles, source maps, and non-web static extensions by default. Use plugin route APIs or SDK host requests for dynamic data.

Agent-generated plugins and newly edited plugin UI should not register extra `/api/file`, `/api/video`, `/assets/*`, or similar routes only to serve CSS, JS, images, fonts, or MP4 files. Existing plugins that already use static-file compatibility handlers remain loadable. The documented contract for new work is to put those resources in `assets/` and reference them with `luc.assets.url(...)` or the official host-served assets path in the route shell.

React plugin UIs should use `@luccode/plugin-components`. It provides Button, IconButton, TextInput, Textarea, Select, Switch, SettingRow, CardShell, List, EmptyState, and related primitives that match Luc's current controls:

```tsx
import { Button, CardShell, LucThemeProvider, SettingRow, Switch } from "@luccode/plugin-components";
import "@luccode/plugin-components/styles.css";

export function PluginPanel() {
  return (
    <LucThemeProvider mode="inherit">
      <CardShell title="Sync">
        <SettingRow label="Enabled" control={<Switch checked label="On" />} />
        <Button variant="primary">Run</Button>
      </CardShell>
    </LucThemeProvider>
  );
}
```

`LucThemeProvider` supports three modes: `inherit` reads host CSS variables and then uses SDK fallback tokens; `luc` pins the UI to a named Luc theme token set; `custom` only overrides explicitly provided tokens and lets missing fields continue through the fallback chain. Components depend only on `luc-plugin-*` classes and CSS variables, not renderer internals.

### Widget (Sidebar Component) ⚡ full-access

A plugin can register a component in the right-side Jian sidebar. A widget and a page can be declared simultaneously in the same plugin — they are independent and do not conflict.

```json
{
  "contributes": {
    "widget": {
      "title": { "zh": "盯盘", "en": "Monitor" },
      "icon": "<svg viewBox='0 0 24 24' .../>",
      "route": "/sidebar"
    }
  }
}
```

Field rules are the same as Page. The widget appears alongside the desk in the Jian sidebar, controlled by a button on the right side of the titlebar. When no widgets are registered, the button area is automatically hidden.

Widgets are also rendered via WebView/iframe and must send the `ready` handshake signal.

### SettingsTab (Native Settings Page, Built-ins Only) ⚡ full-access

Bundled built-in plugins can register a native settings page shown in the settings sidebar, at the same level as "Skills" and "Plugins". This contribution only works for built-in plugins under the packaged `plugins/` directory; community plugins are ignored even if they declare it. The renderer maps `nativeComponent` through a host whitelist, so plugins declare a component id rather than shipping frontend code.

```json
{
  "hidden": true,
  "trust": "full-access",
  "contributes": {
    "settingsTab": {
      "id": "mcp",
      "title": { "zh": "连接器", "en": "Connectors" },
      "nativeComponent": "mcp.settings"
    }
  }
}
```

- `id`: Settings tab id, globally unique
- `title`: Display name. Accepts a plain string or an i18n object `{ zh, en, ... }`
- `nativeComponent`: Host-registered native component id, such as `mcp.settings`
- Use this when a hidden bundled feature needs native settings UI while keeping runtime logic removable as a plugin-shaped module

## Manifest

Most plugins don't need a manifest. Only required for:

- Declaring `trust: "full-access"` for full permissions
- Declaring WebView/iframe UI host capabilities (`ui.hostCapabilities`)
- Declaring ordinary plugin capabilities (`capabilities`) or future user-granted sensitive capabilities (`sensitiveCapabilities`)
- Declaring outbound HTTP data boundaries (`network.allowedHosts`, `network.methods`, etc.)
- Configuration schema (JSON Schema declarations)
- Plugin metadata (name, version, description for the management UI)
- Soft dependency declarations

```json
{
  "manifestVersion": 1,
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "trust": "full-access",
  "activationEvents": ["onToolCall:search"],
  "capabilities": ["session", "agent", "model.sample", "media.generate", "network.fetch"],
  "sensitiveCapabilities": ["filesystem.write"],
  "network": {
    "allowedHosts": ["api.example.com"],
    "methods": ["GET", "POST"],
    "defaultTimeoutMs": 8000,
    "maxResponseBytes": 1048576
  },
  "ui": {
    "hostCapabilities": ["external.open"]
  },
  "contributes": {
    "configuration": { ... }
  },
  "depends": {
    "capabilities": ["bridge:send"]
  }
}
```

Without a manifest, `id` is derived from the directory name, other fields default to empty, and permission is restricted.

`capabilities` are ordinary declarations and are exposed as `ctx.capabilities`; in the current version, declared ordinary capabilities can be used directly through the SDK or EventBus. `sensitiveCapabilities` records intent for the future user-granted permission system and is exposed as `ctx.sensitiveCapabilities`.

`network` describes the outbound HTTP boundary only; it does not grant a capability by itself. Code that calls `ctx.network.fetch()` must still declare `network.fetch` in `capabilities` or `sensitiveCapabilities`. New plugins should fetch live data, third-party API payloads, search results, and dynamic website-conversion data from route code, then return sanitized JSON to the iframe. `network` is not a static resource serving config; packaged images, videos, CSS, and JS still belong under `assets/`.

### Activation Events

`index.js` is not necessarily executed immediately on app startup. Declare `activationEvents` in `manifest.json` to start the lifecycle on demand:

| Event | When it fires |
|-------|---------------|
| `onStartup` | Executes `onload()` immediately when the plugin loads |
| `onPageOpen` | User opens the plugin's page route |
| `onWidgetOpen` | User opens the plugin's widget route |
| `onToolCall` | Any static tool contributed by the plugin is called |
| `onToolCall:name` | A specific static tool is called |
| `onBusRequest` | Reserved for bus request triggers |
| `onBusRequest:type` | Reserved for a specific bus capability request |
| `*` | Any known activation trigger |

Older plugins without `activationEvents` remain compatible: if `index.js` exists, the default is equivalent to `["onStartup"]`. New plugins should declare the minimum activation conditions for their capabilities to avoid spinning up all persistent connections, tasks, and handlers at app startup.

```json
{
  "id": "lazy-search",
  "trust": "full-access",
  "activationEvents": ["onToolCall:search"],
  "contributes": {
    "page": { "title": "Search", "route": "/search" }
  }
}
```

## Stateful Plugins (Lifecycle) ⚡ full-access

If a plugin needs persistent connections, scheduled tasks, or bus handlers, create `index.js`:

New plugins should use `definePlugin()` from `@luccode/plugin-runtime`. It returns a class-compatible value for the current PluginManager:

```js
import { definePlugin } from '@luccode/plugin-runtime';

export default definePlugin({
  async onload(ctx, { register }) {
    register(ctx.bus.handle("bridge:send", async (payload) => {
      return { sent: true, payload };
    }));
  },
});
```

The traditional class form is still supported:

```js
import { LUC_BUS_SKIP } from "@luccode/plugin-runtime";

export default class MyPlugin {
  async onload() {
    // ctx is injected by PluginManager:
    // this.ctx.bus          — EventBus (full: emit/subscribe/request/handle)
    // this.ctx.config       — Config read/write (get/set)
    // this.ctx.dataDir      — Private data directory path
    // this.ctx.log          — Logger with pluginId prefix
    // this.ctx.pluginId     — Plugin ID
    // this.ctx.pluginDir    — Plugin installation directory
    // this.ctx.registerTool — Dynamic tool registration (returns cleanup function)

    // Resources registered via register() are auto-cleaned on unload (reverse order)
    this.register(
      this.ctx.bus.handle("bridge:send", async (payload) => {
        if (payload.platform !== "feishu") return LUC_BUS_SKIP;
        await this.sendToFeishu(payload);
        return { sent: true };
      })
    );

    this.ws = await this.connect();
  }

  async onunload() {
    // Resources from register() are auto-cleaned, no manual unhandle needed
    // Only clean up things the framework can't manage
    this.ws?.close();
  }
}
```

## Bus Communication (bus.request / bus.handle)

Inter-plugin communication uses EventBus request-response. `bus.handle` requires full-access permission; `bus.request` is available to all plugins. `bus.listCapabilities()` / `bus.getCapability(type)` can read the current stable capability directory, which records the capability name, input/output schema, permission requirements, error codes, stability, and whether a handler is currently available. New plugins should use `defineBusHandler()`, `requestBus()`, and `LUC_BUS_SKIP` from `@luccode/plugin-runtime` so handler types, request arguments, and chained skip semantics come from the SDK instead of hand-written conventions.

```js
import { defineBusHandler, LUC_BUS_SKIP, requestBus } from "@luccode/plugin-runtime";

// Plugin A (full-access): register a capability
const bridgeSend = defineBusHandler({
  type: "bridge:send",
  async handle(payload) {
    if (payload.platform !== "telegram") return LUC_BUS_SKIP;
    await telegramBot.send(payload.chatId, payload.text);
    return { sent: true };
  },
});

this.register(this.ctx.bus.handle(
  bridgeSend.type,
  (payload) => bridgeSend.handle(payload, this.ctx),
  {
    capability: {
      title: "Bridge send",
      description: "Send text to a bridge platform.",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string" },
          chatId: { type: "string" },
          text: { type: "string" },
        },
        required: ["platform", "text"],
      },
      outputSchema: { type: "object" },
      permission: "bridge.send",
      errors: ["NO_HANDLER", "TIMEOUT", "INTERNAL_ERROR"],
      owner: "plugin:my-plugin",
      stability: "experimental",
    },
  },
));

// Plugin B (any permission): call the capability
const capability = this.ctx.bus.getCapability?.("bridge:send");
if (capability?.available) {
  const result = await requestBus(this.ctx, "bridge:send", {
    platform: "telegram",
    chatId: "123",
    text: "Hello",
  }, { timeout: 5000 });
}
```

**Naming convention**: `domain:action`, colon-separated. E.g. `bridge:send`, `memory:query`, `timer:schedule`.

**SKIP chain**: Multiple handlers can be registered for the same event type. The system calls them in registration order until one returns a value other than `LUC_BUS_SKIP`. Returning `LUC_BUS_SKIP` means "I don't handle this, pass it on":

```js
this.register(
  this.ctx.bus.handle("bridge:send", async (payload) => {
    if (payload.platform !== "telegram") return LUC_BUS_SKIP;
    await telegramBot.send(payload.chatId, payload.text);
    return { sent: true };
  })
);
```

**Error handling**:
- No handler → throws `BusNoHandlerError`
- Timeout (default 30s) → throws `BusTimeoutError`
- Handler business errors → propagated directly

**Soft dependencies**: `depends.capabilities` in manifest is advisory only; the system won't block installation if capabilities are missing. Plugin code should prefer `bus.getCapability(type)?.available` for graceful degradation at runtime; older plugins may continue to use `bus.hasHandler()`.

### Built-in Session / Agent / Model / Media Capabilities

Plugins should prefer the typed helpers from `@luccode/plugin-runtime`. They map to these EventBus capabilities:

| Capability | Description |
|------------|-------------|
| `session:create` | Create a normal Luc session without switching the main UI focus, with `agentId`, `cwd`, `memoryEnabled`, `workspaceFolders`, `thinkingLevel`, `permissionMode`, `ownerPluginId`, `kind`, and `visibility` |
| `session:get` / `session:list` | Read session projections; plugin-private sessions are hidden from the main list by default, and plugins can query their own sessions by `ownerPluginId` |
| `session:update` | Update title, pinned state, project, thinking level, permission mode, plugin owner, kind, and visibility |
| `session:send` | Send a message to a specific session; supports `context.system`, `context.beforeUser`, and `context.afterUser` |
| `session:abort` / `session:history` | Abort active session work and read persisted history |
| `agent:list` / `agent:profile` | List agents and read public agent profiles |
| `agent:create` / `agent:update` | Create or update plugin-owned agents, including `visibility: "plugin_private"` |
| `model:sample-text` | Run a non-streaming utility-model text sample for RAG query rewriting, summarization, routing, and similar plugin-side work |
| `provider:media-providers` / `provider:resolve-media-model` | Discover configured media providers and resolve a concrete media model |
| `media:generate-image` | Submit an image generation task through the built-in media task pipeline; completed files are delivered as `SessionFile` records by default, while `delivery.mode="response"` returns task/file results only |
| `media:generate` / `media:generate-video` / `media:transcribe-audio` | Submit generic media tasks, video generation, or audio transcription through the native Media Manager |

Plugin backend code should prefer the `@luccode/plugin-runtime` helpers. Plugin pages or route handlers that already hold host HTTP credentials can also use the native facade: `POST /api/media/generate`, `POST /api/media/image/generate`, `POST /api/media/video/generate`, and `POST /api/media/asr/transcribe`. These endpoints require chat scope. Image/video requests must include `prompt`; the default `delivery.mode="session"` also requires `sessionId` or `sessionRef` and registers completed files as `SessionFile` records. For plugin-owned artifacts, pass `delivery: { mode: "response" }` and omit session identity; poll `GET /api/media/tasks/:taskId`, then fetch `task.files[]` through `GET /api/media/generated/:filename`. ASR requests require `sessionId` or legacy `sessionPath` plus `fileId`; image references must use `SessionFile` references such as `{ kind: "session_file", fileId }`. All of them forward into the same Media Manager task pipeline. Image adapters accept multiple reference images by default; adapters that only support one reference should declare `maxReferenceImages: 1`, and the pipeline rejects oversized requests before enqueueing.

`session:send.context` is injected only into the current provider request. It does not rewrite the visible user message and does not persist as user text. A plugin can run its own RAG, world-state, mood, or character-state system, then attach those snippets when sending:

```js
import {
  createAgent,
  createSession,
  generateMedia,
  generateImage,
  transcribeAudio,
  sampleText,
  sendSessionMessage,
} from "@luccode/plugin-runtime";

const agent = await createAgent(ctx, {
  name: "Tavern Character",
  visibility: "plugin_private",
  memoryPolicy: { enabled: true },
});

const session = await createSession(ctx, {
  agentId: agent.agent.id,
  kind: "tavern",
  visibility: "plugin_private",
  cwd: ctx.dataDir,
});
const sessionTarget = session.sessionRef ?? { sessionId: session.sessionId };

const query = await sampleText(ctx, {
  operation: "tavern-rag-query",
  messages: [{ role: "user", content: "Extract world-lore keywords for this turn" }],
  maxTokens: 80,
});

await sendSessionMessage(ctx, sessionTarget, {
  text: "I push the door open.",
  context: {
    beforeUser: [
      { label: "world", text: "Rainy city night; the old theater is still open." },
      { label: "rag_query", text: query.text },
    ],
  },
});

await generateImage(ctx, {
  sessionId: session.sessionId,
  sessionRef: session.sessionRef,
  prompt: "A handwritten character card on warm paper",
  referenceImages: [
    { kind: "session_file", fileId: "sf_reference_a" },
    { kind: "session_file", fileId: "sf_reference_b" },
  ],
  ratio: "3:2",
});

await generateMedia(ctx, {
  kind: "video",
  sessionId: session.sessionId,
  sessionRef: session.sessionRef,
  prompt: "A slow page-turn animation on warm paper",
});

const artifactOnly = await generateImage(ctx, {
  prompt: "A small icon on transparent background",
  delivery: { mode: "response" },
});
// Later poll /api/media/tasks/{artifactOnly.tasks[0].taskId}

const transcription = await transcribeAudio(ctx, {
  sessionId: session.sessionId,
  sessionRef: session.sessionRef,
  fileId: "session-file-id",
});
// transcription = { ok: true, transcription: { status, text, ... } }
```

### Dynamic Tool Registration ⚡ full-access

Plugins can dynamically register tools in `onload()` via `ctx.registerTool()`, useful when tools are discovered at runtime (for example, the bundled Connectors MCP bridge):

```js
this.register(this.ctx.registerTool({
  name: "dynamic-search",
  description: "Dynamically registered tool",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  execute: async (input) => { ... },
}));
```

Tool names are auto-prefixed with `pluginId_` and auto-removed on unload via `register()`.

### Background Tasks ⚡ full-access

Plugins can register background tasks so LucCode can track and abort them. Runtime lifecycle is managed by `TaskRegistry`.

**Register a task type handler** once in `onload()`:

```js
await this.ctx.bus.request("task:register-handler", {
  type: "my-task-type",
  abort: (taskId) => {
    // cancel polling, abort a request, stop a worker, etc.
  },
});

this.register(() => {
  this.ctx.bus.request("task:unregister-handler", { type: "my-task-type" }).catch(() => {});
});
```

**Register a task instance** every time a background task starts:

```js
await this.ctx.bus.request("task:register", {
  taskId: "my-task-123",
  type: "my-task-type",
  parentSessionPath: sessionPath,
  meta: { type: "my-task", prompt: "..." },
});
```

**Remove the task when complete**:

```js
await this.ctx.bus.request("task:remove", { taskId: "my-task-123" });
```

**Result delivery** usually combines `task:*` with `deferred:*`: `task:*` tracks runtime lifecycle, while `deferred:*` tracks result delivery back to the parent session. A long task commonly calls `deferred:register` and `task:register` at start, then `deferred:resolve` and `task:remove` at completion.

TaskRegistry persists task records and schedule metadata. On restart, active tasks are marked as 'recovering'; plugins must re-register handlers in onload() and resume or fail recovering tasks.

### Official Plugin Marketplace

The "Open plugin marketplace" button in Settings -> Plugins opens a full marketplace subpage that reads `/api/plugins/marketplace`. Luc follows the Obsidian-style official community catalog model: third-party authors submit plugins to `luccode-plugins`, while users browse, install, enable, and disable plugins without managing marketplace sources.

Default official catalog:

```text
https://raw.githubusercontent.com/LuoJunCheng/luccode-plugins/main/marketplace.json
```

Developer overrides remain available:

- `LUC_PLUGIN_MARKETPLACE_FILE=/path/to/marketplace.json`
- `LUC_PLUGIN_MARKETPLACE_URL=https://.../marketplace.json`

Without either environment variable, Luc first tries `${LUC_HOME}/plugin-marketplace/marketplace.json` for local development. If it does not exist, Luc reads the official `luccode-plugins` URL. The marketplace index shape matches the `luccode-plugins` repository:

```json
{
  "schemaVersion": 1,
  "plugins": [{
    "schemaVersion": 1,
    "id": "demo",
    "name": "Demo",
    "publisher": "Luc",
    "version": "1.0.0",
    "description": "Demo plugin",
    "repository": "https://example.com/demo",
    "compatibility": { "minAppVersion": "1.0.0" },
    "trust": "restricted",
    "permissions": ["task.read"],
    "contributions": ["tools"],
    "distribution": {
      "kind": "release",
      "packageUrl": "https://github.com/LuoJunCheng/luccode-plugins/releases/download/demo-v1.0.0/demo.zip",
      "sha256": "..."
    },
    "versions": [
      {
        "version": "1.0.0",
        "compatibility": { "minAppVersion": "1.0.0" },
        "distribution": {
          "kind": "release",
          "packageUrl": "https://github.com/LuoJunCheng/luccode-plugins/releases/download/demo-v1.0.0/demo.zip",
          "sha256": "..."
        }
      }
    ],
    "readmePath": "plugins/demo/README.md"
  }]
}
```

The marketplace UI shows the plugin list and README in a wider settings subpage. Selecting a plugin reads `/api/plugins/marketplace/:id/readme`. `distribution.kind: "release"` downloads the zip package, verifies `sha256`, then installs it into the user's plugin directory. `distribution.kind: "source"` is only for local file marketplace development because the source path must resolve to a directory on the user's machine.

Marketplace version management uses `versions[]` as the long-term contract: each item declares `version`, that version's `compatibility.minAppVersion`, and its own `distribution`. If `versions[]` is absent, Luc treats the root-level `version` / `compatibility` / `distribution` as a single version entry. The client chooses the highest SemVer version compatible with the current app, while exposing `latestVersion`, `selectedVersion`, `installedVersion`, `updateAvailable`, `downgrade`, `reinstall`, `compatible`, `installAction`, and `canInstall` for UI state.

If the installed version is newer than the highest compatible marketplace version, the action is marked as `downgrade` and install requires explicit `allowDowngrade: true`. Drag-and-drop / local path installs also reject implicit downgrades. Updates back up the previous plugin directory under `${LUC_HOME}/plugin-backups/<pluginId>/`; if the new version fails to load, Luc restores and reloads the old directory. Successful installs are recorded in `${LUC_HOME}/plugin-installs.json` with source, version, release URL, and sha256 so later marketplace state is explicit.

## Forward Compatibility

The system ignores unrecognized directories and manifest fields. Old plugins always work on new systems; new plugins on old systems simply have new contribution types silently ignored. `manifestVersion` remains optional for compatibility; new WebView/iframe UI plugins that declare `ui.hostCapabilities` should use `manifestVersion: 1` to match the host and SDK docs, but old plugins do not need a migration. Existing plugins that created static-resource compatibility handlers for earlier asset limitations also remain allowed; diagnostics and Agent rules should treat them as cleanup candidates, not load blockers.

## Error Isolation

- A single plugin's `onload()` failure does not block other plugins or system startup
- A syntax error in a single tool/route/command file only affects that file
- Failed plugins are marked `status: "failed"` and show error info on the plugins page

## Diagnostics Panel

The diagnostics button under Settings → Plugins reads `/api/plugins/diagnostics`
and shows plugin load state, activation state, routes, tools, commands,
configuration, EventBus capabilities, background tasks and scheduled tasks in
one place. Plugin authors should look here first. If a plugin is loaded but
`activationState` is still `inactive`, its lifecycle has not been triggered by
the matching `activationEvents`. If a task sits in `recovering`, the host
restored the task record after an app restart, but the plugin still has to
re-register its handler in `onload()` and restore its own business state.

## Concurrency

Luc supports multiple sessions and multiple agents running in parallel. Keep the following in mind when developing plugins:

- All EventBus operations against an existing session (`session:get`, `session:update`, `session:send`, `session:abort`, `session:history`, etc.) must include `sessionId` or `sessionRef` to identify the target session; `sessionPath` is a legacy compatibility input
- Tools obtain the current session identity via `toolCtx.sessionId` / `toolCtx.sessionRef`; `toolCtx.sessionPath` is only the current locator
- Do not use `engine.currentSessionPath` or `engine.currentAgentId` (these are UI focus pointers and do not represent the currently executing session)

```js
// Correct: explicitly specify sessionId/sessionRef and attach per-turn context if needed
await bus.request("session:send", {
  text: "Hello",
  sessionId: toolCtx.sessionId,
  sessionRef: toolCtx.sessionRef,
  context: {
    beforeUser: [{ label: "world", text: "The character is in a quiet archive." }],
  },
});

await bus.request("session:abort", {
  sessionId: toolCtx.sessionId,
});

// Wrong: omitting session identity cannot target the right session under concurrency
await bus.request("session:send", { text: "Hello" });
```
