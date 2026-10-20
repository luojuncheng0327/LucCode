---
name: luc-plugin-creator
description: Create Luc plugin scaffolds and guide users through beginner or developer plugin planning, capability checks, manifest setup, runtime tools, WebView/iframe UI, Session/Agent APIs, model/media APIs, SDK templates, and install-ready plugin directories. Use when LucCode/Codex needs to explain what Luc plugins can do, help a user describe a plugin idea, check whether the SDK supports it, or generate/update a Luc plugin with @luccode/plugin-runtime, @luccode/plugin-sdk, and @luccode/plugin-components.
compatibility: "Uses a bundled Node preflight plus a Python scaffold script. No third-party Python packages are required."
metadata:
  default-enabled: false
---

# Luc Plugin Creator

Use this skill for Luc application plugins, not Codex `.codex-plugin` bundles.

## First Contact

On first use, give a map, not an encyclopedia. Explain what Luc plugins can add, ask what the user wants to build, and invite follow-up questions. Expand details only after the user asks or after the chosen scaffold needs them.

Choose the user mode this way:

- If the user explicitly says they are new, non-technical, or wants hand-holding, use beginner mode.
- If the user explicitly asks for SDK/API/build details or gives code-level requirements, use developer mode.
- If memory is unavailable, disabled, or uncertain, ask: `你想我用哪种方式帮你创建插件？A. 边讲边做 B. 开发者模式`

Beginner mode tone: encouraging, concrete, and guided. Say that the user can describe the feature in plain language, LucCode will help turn it into a plugin plan and scaffold, and LucCode can answer questions at any step. Ask:

1. 你希望 LucCode 多一个什么能力？
2. 这个能力是让 Agent 自动调用，还是让你点界面使用？
3. 它需要界面、文件、联网、外部平台、账号权限吗？

Developer mode tone: concise and collaborative. Lead with the capability surface, then ask for the target contribution and integration boundary.

After delivering a plugin, encourage with grounded product value. Name the real situation where the plugin helps, such as reducing repeated steps, making an external service available inside Luc, turning a manual workflow into an Agent-callable tool, or giving a recurring task a stable UI. Use natural wording such as `这个想法挺实用，适合把每周重复整理的步骤固定下来` or `这个方向比较适合做成工具型插件，因为 Agent 可以在对话里直接调用`. Avoid inflated praise like `你的设想太棒了`.

## Capability Map

Luc plugins can provide:

- Agent-callable tools and slash-style actions.
- Skills, agents, and knowledge that guide model behavior.
- WebView/iframe pages, widgets, and cards using Luc theme and host capabilities.
- Declarative `chat.surface` cards for showing plugin-owned private session transcripts in the main chat stream.
- Lifecycle and EventBus handlers for full-access integrations.
- Session and Agent control through `@luccode/plugin-runtime`: create/list/update/send/abort/history sessions, subscribe to session events, create/read/update plugin-owned agents, and hide plugin-private resources from the main Luc UI.
- Per-turn model context injection through `sendSessionMessage(..., { context })` or `session:send.context`, suitable for plugin-owned RAG, world lore, mood, character state, or routing hints. This affects only the current provider request and does not rewrite visible user text.
- Non-streaming utility model calls through `sampleText()` for plugin-side summarization, RAG query rewriting, routing, and classification.
- External HTTP data access through runtime `ctx.network.fetch()` with manifest-declared hosts, methods, timeout, cache, and response-size boundaries.
- User resource access through runtime `ctx.resources`, with ResourceRef inputs for local files, mounts, SessionFiles, durable resources, read-only URLs, and backend watch subscriptions.
- Media discovery and generation through `listMediaProviders()`, `resolveMediaModel()`, and `generateImage()`, with generated files delivered as `SessionFile` resources.
- Provider contributions for chat and media capabilities, including image/video/speech providers backed by HTTP, OAuth HTTP, local CLI, browser CLI, or plugin runtimes.
- Pi SDK extension-style integrations under `extensions/*.js` where the plugin must observe or transform the LLM request pipeline.
- SessionFile-backed outputs for files and media.

Luc provides install/enable/reload, per-agent skill toggles, manifest capability checks, iframe host messaging, theme tokens, toast/clipboard/external host APIs, EventBus, data directories, and SDK packages.

Current boundaries: WebView/iframe UI is the stable escape hatch for existing web apps, remote sites, and standalone HTML. `chat.surface` is a thin native transcript surface for plugin-owned `plugin_private` / `private` sessions created through the runtime session API. Rich native card composition is not part of the public SDK contract yet. Native renderer components and code sandboxing are not the default path yet. Ordinary manifest `capabilities` are declaration metadata and can be used directly through the SDK/EventBus; `sensitiveCapabilities` records future user-granted permission intent. If a request depends on native renderer hooks, code sandboxing, or fine-grained permission prompts, explain the gap and propose the closest supported shape.

## Environment Preflight

Run the bundled Node preflight before invoking the Python scaffold script:

```bash
node skills2set/luc-plugin-creator/scripts/check_env.mjs --capability scaffold
```

Behavior:

- The preflight itself is JavaScript and uses only Node built-ins.
- It finds Python through `LUC_PLUGIN_CREATOR_PYTHON`, `python3`, `python`, or Windows `py -3`.
- It requires Python 3.9+ because the scaffold script uses modern stdlib typing syntax.
- If it returns `ok: false`, stop and show the user the `message` or `installGuidance`. Do not auto-install dependencies.
- Use the same Python command that passed preflight for the scaffold examples below. The examples use `python3`.

## Workflow

1. Find the Luc repo root. Prefer the current workspace if it contains `PLUGIN_SDK.md`, `PLUGINS.md`, and `packages/plugin-runtime`.
2. Read `PLUGIN_SDK.md` and the relevant sections of `PLUGINS.md` before changing plugin code. For React UI, also read `packages/plugin-sdk/README.md` and `packages/plugin-components/README.md`.
3. Pick a template:
   - `direct`: no npm install, no build step, best for a beginner's first runnable plugin.
   - `guided-react`: React/Vite/SDK starter with shared Luc components and a gentler README.
   - `professional-react`: React/Vite/SDK starter for developers who expect package scripts and typed UI code.
4. Pick the contribution kind:
   - `tool`: restricted plugin with `tools/*.js`.
   - `ui`: full-access WebView/iframe page/widget.
   - `full`: tool, lifecycle/EventBus entry, and WebView/iframe UI.
   - `provider`: full-access provider declaration under `providers/*.js`.
5. Pick the target location:
   - Built-in plugin shipped with Luc: `plugins/<plugin-id>`.
   - Example or template plugin: `examples/plugins/<plugin-id>`.
   - User-installed plugin: the directory reported by `/api/plugins/settings` or `${LUC_HOME}/plugins`.
6. Generate the scaffold with the bundled script, then adjust names, descriptions, tools, routes, capabilities, and UI to the user's request.
   - When converting an existing website or single-page app into a Luc iframe plugin, rewrite same-plugin browser `fetch('/api/...')` calls to `luc.api.fetch(...)`, move static files under `assets/`, and use `luc.assets.url(...)` for browser-side asset references.
   - If the website depends on live third-party data, create a plugin route and call `ctx.network.fetch(...)` from that route. Add `network.fetch` and `network.allowedHosts` to the manifest instead of calling the third-party API directly from iframe JavaScript.
7. Use the Plugin Dev Loop when available:
   - confirm the user has enabled Settings -> Plugins -> "Allow Agent plugin dev tools";
   - install source with `plugin.dev.install`;
   - reload with `plugin.dev.reload` after edits;
   - keep the returned `devRunId` and pass it to lifecycle controls when available;
   - enable, disable, reset, or uninstall only through `plugin.dev.enable`, `plugin.dev.disable`, `plugin.dev.reset`, and `plugin.dev.uninstall`;
   - inspect `plugin.dev.diagnostics`;
   - smoke-test tools with `plugin.dev.invokeTool`;
   - list UI surfaces with `plugin.dev.listSurfaces`;
   - run `manifest.dev.scenarios` with `plugin.dev.runScenario`.
8. For UI debugging, prefer element-first inspection: read accessible elements, role, label, text, and stable locators before screenshots. Use screenshots for visual polish, clipping, theme fit, or fallback.
9. If the user wants publication, choose one channel:
   - local debug: keep source local and install through the dev loop;
   - human review bundle: create zip, README, manifest, screenshots, and sha256 for email/group/issue review;
   - official OH-Plugins release: prepare catalog entry and release zip, then complete the release safety review before any remote push.
10. Run focused verification. When editing this skill, at minimum validate the skill and run the scaffold script against a temp directory.

## Scaffold Commands

Beginner starter:

```bash
python3 skills2set/luc-plugin-creator/scripts/create_luc_plugin.py "My Plugin" --path examples/plugins --audience beginner --template direct
```

Developer React starter:

```bash
python3 skills2set/luc-plugin-creator/scripts/create_luc_plugin.py "My Plugin" --path examples/plugins --audience developer --template professional-react --sdk-mode workspace
```

Useful options:

- `--kind tool`: restricted plugin with a static `tools/create-note.js`.
- `--kind ui`: full-access plugin with `page` and `widget` WebView/iframe UI.
- `--kind full`: tool, lifecycle/EventBus entry, and WebView/iframe UI.
- `--kind provider`: full-access provider contribution with a media-capability provider declaration.
- `--sdk-mode workspace`: use repo-local SDK packages.
- `--sdk-mode bundled`: copy SDK tarballs from this skill into the generated plugin.
- `--dev-scenario`: add a first-phase `manifest.dev.scenarios` smoke test.
- `--force`: replace an existing generated directory only when the user explicitly wants overwrite.

Provider contribution starter:

```bash
python3 skills2set/luc-plugin-creator/scripts/create_luc_plugin.py "Jimeng Provider" --path examples/plugins --kind provider --audience developer
```

## SDK Rules

- Static `tools/*.js` must export `name`, `description`, `parameters`, and `execute`.
- Agent-callable tools should declare `sessionPermission`. Use `readOnly: true` for pure reads, `kind: "plugin_output"` for bounded plugin-data writes that return SessionFile media, and `kind: "external_side_effect"` for network/provider/platform actions that Auto mode should send to the reviewer. Tools that modify user workspace files should stay reviewer-bound unless the user has explicitly granted a narrower workflow.
- React templates may use `@luccode/plugin-runtime`, `@luccode/plugin-sdk`, and `@luccode/plugin-components`.
- Static iframe resources belong under `assets/` and should be referenced with `luc.assets.url(path)` from browser code or the official `/api/plugins/{pluginId}/assets/...` path from the route shell. This includes CSS, JS, images, fonts, JSON, wasm, and browser-playable videos such as MP4/WebM/MOV. Do not inline large assets as a workaround.
- Do not create custom plugin routes only to serve static files, such as `/api/video`, `/api/file`, or `/assets/*`, in new Agent-generated code. Existing plugins with static-file compatibility handlers may continue to run; if editing them, prefer adding the official `assets/` references without removing the existing handler unless the user explicitly asks for cleanup.
- Dev authority is not a manifest permission. Luc grants it from the remembered dev install slot under `${LUC_HOME}/plugins-dev/`, and Agent dev tools are hidden until the user enables the dev tools setting.
- Declare ordinary SDK needs in manifest `capabilities`, such as `session`, `agent`, `model.sample`, and `media.generate`. Put future high-risk needs in `sensitiveCapabilities`.
- For external HTTP APIs, declare `"network.fetch"` in `capabilities` and add a top-level `network` object with `allowedHosts`, `methods`, `defaultTimeoutMs`, and `maxResponseBytes`. Use `ctx.network.fetch(url, { cacheTtlMs })` from Node-side tools, routes, or lifecycle code.
- Iframe browser code must not call third-party APIs directly. It should call a same-plugin route with `luc.api.fetch(...)`; the route reads config/secrets server-side and calls `ctx.network.fetch(...)`.
- Do not invent custom external-data permission fields, custom ticket query params, custom proxy routes, or global fetch wrappers. Existing plugins that already use direct Node `fetch()` remain compatible, but new or refactored Agent-generated code should use `ctx.network.fetch()` so diagnostics can explain missing capabilities, hosts, methods, and response-size limits.
- User resource access must go through `ctx.resources`. Declare `resource.read` for `stat/read/list`, `resource.search` for search, `resource.write` for `write/writeExpectedVersion/edit/mkdir/delete/copy/rename/move/trash`, `resource.materialize` for concrete local paths, and `resource.watch` for backend watch subscriptions through `ctx.resources.watch()` / `ctx.resources.subscribe()`. URL resources are read-only. Do not use local path writes for user resources.
- Release resource watch handles explicitly. Lifecycle plugins should pass `watch.unsubscribe` to `register()`, and short-lived tools should release in `finally`. Listen for `resource.changed`, `resource.deleted`, and `resource.renamed` on `ctx.bus`, then filter by the handle's `resourceKeys`.
- Generated plugins should model user-file inputs as ResourceRefs, such as `{ kind: "local-file", path }`, `{ kind: "mount", mountId, path }`, `{ kind: "session-file", fileId }`, `{ kind: "resource", resourceId }`, or `{ kind: "url", url }`. Avoid designing new tool parameters that require host-local absolute paths unless the feature is explicitly local-execution-only.
- Keep the storage split clear: `ctx.resources` is for user resources; `toolCtx.stageFile()` is for plugin-generated files that need to become `SessionFile` media; `ctx.dataDir` and packaged `assets/` are plugin-owned storage. Raw `fs` examples are only acceptable for plugin-owned storage, not workspace, mount, URL, or SessionFile inputs.
- Use `ctx.resources.materialize(ref)` only when a parser, CLI, or host library needs a concrete local path. Treat the returned path as an execution boundary and write back through ResourceIO explicitly if the source resource must change.
- Browser iframe code may call `luc.resources.open()`, `luc.resources.pick()`, or `luc.resources.requestAccess()` as host-mediated requests only. It must not read or write filesystem content directly; server-side plugin routes and tools should use `ctx.resources` for actual resource operations.
- If iframe code calls `luc.resources.open()`, `luc.resources.pick()`, or `luc.resources.requestAccess()`, declare the matching `resource.open`, `resource.pick`, or `resource.requestAccess` entry under `ui.hostCapabilities`. Do not request resource host grants in templates that do not use those calls.
- Store API keys, bearer tokens, and cookies through configuration schema and `ctx.config`; never place secrets in `assets/`, iframe JavaScript, route shell HTML, or checked-in examples.
- Prefer runtime helpers over raw bus calls for stable host capabilities: `createSession`, `getSession`, `listSessions`, `updateSession`, `sendSessionMessage`, `subscribeSessionEvents`, `createAgent`, `updateAgent`, `sampleText`, `ctx.resources.watch`, `ctx.resources.subscribe`, `listMediaProviders`, `resolveMediaModel`, `generateImage`, `generateMedia`, `generateVideo`, and `transcribeAudio`.
- `createSession()` creates a detached Luc session and does not switch the main UI focus. Use `visibility: "plugin_private"` and `ownerPluginId` for plugin-only sessions or Tavern-style parallel chat surfaces.
- Use `createChatSurfaceCard(ctx, session.sessionRef ?? session, options)` when a plugin wants to display its own private session in chat. Do not hand-build path-only `chat.surface` payloads; the helper requires `sessionId` / `sessionRef` and Luc verifies plugin ownership before rendering.
- `createAgent()` / `updateAgent()` can create plugin-owned hidden agents. Keep plugin-only characters and resources marked `visibility: "plugin_private"` unless the user expects them in the main Agent list.
- Use `sendSessionMessage()` with `context.system`, `context.beforeUser`, or `context.afterUser` for per-turn RAG/world-lore/mood injection. Do not write JSONL history directly and do not mutate the visible user message to smuggle hidden context.
- Use `sampleText()` for plugin-side reasoning tasks that do not need a full chat turn, such as query rewriting, summaries, classifiers, or routing.
- Use `generateImage()` / `generateMedia()` for host media generation instead of calling provider internals directly. The media task pipeline owns progress, cancellation, delivery, and `SessionFile` registration. Image references should use `{ kind: "session_file", fileId }` instead of raw local paths. Provider models must declare reference-image support on each mode with `modes[].inputLimits.referenceImages`, such as `{ min: 0, max: 0 }` for text-only generation or `{ min: 1, max: 1 }` for a single-reference mode. Use `transcribeAudio()` for ASR over registered `SessionFile` audio.
- Do not call legacy `media-gen:*` events from newly generated plugins. They remain only for old adapter compatibility. New provider plugins must declare `providers/*.js` with `capabilities.media.*`, then use stable media helpers or the formal Adapter Plugin API once available.
- Local files returned to users must go through `toolCtx.stageFile({ sessionId, sessionRef, filePath, label })`, then media details. `sessionPath` is legacy locator metadata only, not identity. Do not hand-build local `MEDIA:` or `file://` output.
- Page and widget contributions require `"trust": "full-access"` and route-backed WebView/iframe UI. WebView/iframe cards remain valid for plugin web UI; native `chat.surface` cards are only for plugin-owned private session transcripts. Rich native card APIs are not part of the public SDK contract yet.
- Iframe browser code must call this plugin's own route handlers with `luc.api.fetch('route/path', init)` or `luc.api.url('route/path')`. Do not hard-code `/api/plugins/{pluginId}/...` in browser code, do not reuse `pluginIframeTicket` for XHR/fetch, and do not ask authors to manually pass `pluginSurfaceSession` unless documenting the low-level protocol.
- `pluginIframeTicket` is only for iframe document loading. Do not append it to CSS, JS, image, font, video, or XHR URLs.
- Pi SDK extension factories under `extensions/*.js` require `"trust": "full-access"`. They are for provider request rewriting, context filtering, and tool-call observation; use ordinary `tools/*.js` for Agent-callable actions.
- After full-access plugin install, enable, or reload, Luc rebinds extension runners for idle sessions. Busy sessions pick up the change on the next safe rebuild, so do not promise that an in-flight reply will use freshly edited extension code.
- Declare only the iframe host capabilities actually used.
- EventBus handlers should return `LUC_BUS_SKIP` for payloads that do not belong to them.
- Keep WebView/iframe UI self-contained. Do not import renderer internals from `desktop/src/react`.
- Provider declarations live in `providers/*.js` and require `"trust": "full-access"`.
- Keep `capabilities.chat` separate from `capabilities.media.*`. Media-only providers must set `chat.projection = "none"` so they never appear in chat model selectors.
- CLI-backed providers must declare `runtime.kind = "local-cli"` or `"browser-cli"` with structured arg bindings and output contracts. Do not build shell command strings.

## Marketplace Rules

- Marketplace metadata lives in the `OH-Plugins` repository, not inside `project-luc`.
- Official source plugins may live in `OH-Plugins/official-plugins/<plugin-id>/` with a matching `plugins/<plugin-id>.yaml`.
- Each marketplace entry needs one README source: `readme`, `readmePath`, or `readmeUrl`. Use `readmePath` only for local file marketplaces; use inline `readme` or HTTPS `readmeUrl` for URL marketplaces.
- Prefer `versions[]` once a plugin has more than one release line. Each version item declares `version`, `compatibility.minAppVersion`, and its own `distribution`.
- For a single release, root `version`, `compatibility`, and `distribution` remain valid; Luc normalizes them into a single version entry.
- Luc selects the highest SemVer version compatible with the current app and exposes update, reinstall, incompatible, and downgrade states to the UI.
- If the selected compatible version is lower than the installed version, install requires explicit downgrade confirmation with `allowDowngrade: true`.
- Release installs are backed up before replacement and rolled back when the new plugin fails to load.
- Local file marketplaces can install `distribution.kind = "source"` entries because paths resolve on disk.
- URL marketplaces browse entries, show README content, and install release packages by downloading the zip and verifying `sha256`.
- Before pushing `OH-Plugins`, complete the release safety review and wait for explicit user confirmation.

## UI Rules

- Default React plugin UI to `LucThemeProvider mode="inherit"` so it follows the host theme.
- Use `mode="luc"` for a named Luc theme, and `mode="custom"` only for explicit token overrides.
- Route shells should read `luc-theme` and `luc-css` query params, include the theme CSS link when present, and escape values inserted into HTML attributes.
- Direct templates may use small no-build host messaging helpers, but should stay compatible with the public iframe protocol.
- Direct templates include `luc.api.fetch()` for plugin route calls; preserve that helper when simplifying generated browser code.

## Website-To-Plugin Conversion Rules

- Split the source website into a route shell plus `assets/`. Keep HTML structure in the shell, compiled or copied JS/CSS/media in `assets/`, and business APIs in `routes/*.js`.
- Large media such as MP4 backgrounds must stay as files under `assets/`; do not base64-inline them and do not stream them through custom plugin routes.
- Live data APIs belong behind plugin routes that call `ctx.network.fetch()`. The browser page calls `luc.api.fetch('api/...')`, receives sanitized JSON, and renders it locally.
- First paint must not auto-call LLM APIs. Trigger model calls only from an explicit user action, then call a plugin backend route with `luc.api.fetch(...)`; the backend route may use `sampleText()` or other runtime helpers.
- After generating or editing a UI plugin, check for disallowed patterns before installing: `pluginIframeTicket` in asset/API URLs, hard-coded `/api/plugins/{pluginId}` in browser code, direct third-party `fetch()` from iframe assets, custom static-file routes in new code, missing `assets/` files, and page-load LLM calls.
- If the user asks to turn a login-backed or browser-operated website into a plugin, explain that the stable API today is WebView/iframe UI plus route-backed data APIs. Do not create ad hoc browser-control interfaces; note that a future web-session capability should own persistent cookies, navigation, and user-mediated external site interaction.
- Use the dev loop first. Install source into `${LUC_HOME}/plugins-dev/`, reload after edits, run diagnostics and scenarios, then package or install into the normal plugin directory only after the dev copy works. Existing installed plugins may include compatibility handlers; treat them as cleanup candidates, not broken plugins.
