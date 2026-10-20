# Luc Plugin SDK

Luc's plugin SDK is split into small packages so plugin authors can choose only the layer they need.

| Package | Runs In | Purpose |
| --- | --- | --- |
| `@luccode/plugin-protocol` | WebView/iframe / host | Shared protocol constants and message shapes for plugin UI. |
| `@luccode/plugin-sdk` | WebView/iframe browser code | Typed helpers for `ready`, asset URLs, resize, toast, external links, clipboard, and lower-level host requests. |
| `@luccode/plugin-runtime` | plugin Node runtime | Helpers for tools, lifecycle plugins, EventBus handlers, SessionFile media details, providers, and Pi SDK extensions. |
| `@luccode/plugin-components` | WebView/iframe React UI | Luc-styled React primitives with theme fallback: controls, cards, rows, lists, and empty states. |

For the end-to-end plugin author workflow, start with [`PLUGINS_EN.md`](PLUGINS_EN.md), then use this file as the SDK package map.

Run `npm run build:packages` after SDK changes. The command builds all SDK packages and their `.d.ts` files:

```bash
npm run build:packages
```

## Runtime Boundary

The SDK packages are developer-facing source/build dependencies. The app package still excludes `packages/**`, so plugin UI code should bundle `@luccode/plugin-sdk` and `@luccode/plugin-components` into its WebView/iframe assets. Runtime helpers from `@luccode/plugin-runtime` should be bundled or installed with the plugin when the plugin is distributed outside the monorepo.

Built-in plugins may use the same source patterns, but they should be checked against the packaged server bundle before release. The host does not silently provide these SDK packages as global runtime modules.

Plugin server code is installed and loaded by the Studio server. Plugin WebView/iframe assets are also served by that server; the desktop renderer, Mobile PWA, or browser client may cache them, but client locality must not decide whether a plugin surface, provider, task, config, or tool exists. Declare true client-machine-only actions separately from server workspace actions.

## Production Install Checklist

A plugin installed under `${LUC_HOME}/plugins`, `${LUC_HOME}/plugins-dev`, or a marketplace release is imported from that plugin directory. Bare package imports in server-side plugin code resolve from the plugin package, not from the Luc repository, the desktop renderer, or the packaged server root. A `package.json` beside the plugin is only metadata unless the dependency files are also present or the code has been bundled.

Before copying or zipping a plugin outside the monorepo, inspect every server-side entry point:

- `index.js` / `index.ts`
- `tools/*`
- `routes/*`
- `providers/*`
- `extensions/*`
- any helper file imported by those files

If any of those files import `@luccode/plugin-runtime`, `@luccode/plugin-sdk`, `@luccode/plugin-components`, or another bare package name, the installed plugin must satisfy that import without relying on workspace symlinks. Use one of these release shapes:

- Bundle the server-side plugin code so the installed file no longer contains unresolved SDK imports.
- Ship a plugin directory or release zip that already contains the installed dependencies needed by Node's resolver. Do not assume Luc will run `npm install` during plugin installation.
- Avoid the SDK helper for that entry point and use the host objects already passed by the plugin manager, such as `ctx` for lifecycle, tool, and route code.

`--sdk-mode workspace` is only for source development inside the Luc monorepo. Do not drag a workspace-mode plugin directory into `${LUC_HOME}/plugins` or publish it as a release package. `--sdk-mode bundled` copies SDK tarballs for the plugin's own install or build step; the final installed directory must still be smoke-tested as an extracted plugin, with no dependency on the repo root `node_modules`.

The production smoke test is: install the exact folder or zip that users will receive, then check plugin diagnostics and server logs for `Cannot find package` or other import errors. A plugin that loads in the repo but fails from `${LUC_HOME}/plugins` has crossed the runtime boundary incorrectly.

## Plugin Shape Guide

- Tool-only plugins can stay `restricted`. No-build tools may export the static tool contract directly; tools that import `@luccode/plugin-runtime` must still satisfy the production install checklist above.
- Runtime plugins use `index.js` for lifecycle, EventBus handlers, background tasks, schedules, or dynamic tools. They require `trust: "full-access"`.
- UI plugins use WebView/iframe routes plus `@luccode/plugin-sdk` and, for React UI, `@luccode/plugin-components`. They require `trust: "full-access"` and explicit `ui.hostCapabilities` grants for host calls such as `external.open`, `clipboard.writeText`, `resource.open`, `resource.pick`, or `resource.requestAccess`. Native `chat.surface` cards are declarative transcript surfaces for plugin-owned private sessions and use `createChatSurfaceCard()`. Rich native card composition is not part of the public SDK contract yet.
- Provider contribution plugins use `providers/*.js` declarations. They require `trust: "full-access"` and should declare `capabilities.chat` separately from `capabilities.media.*` so chat selectors stay clean while image, video, or speech tools discover media providers. Provider declarations, `listMediaProviders()`, and `resolveMediaModel()` are the stable discovery entrypoints; media adapter / executor authoring remains a separate API surface. Legacy `media-gen:*` adapter/runtime events remain compatibility-only for older image generation plugins.
- Pi SDK extension plugins use `extensions/*.js` factories. They require `trust: "full-access"` because they run inside the LLM request pipeline. Luc reloads idle sessions after full-access plugin install/enable/reload so existing chats can pick up new extension handlers without requiring an app restart; busy sessions are not reloaded and will retain old extension handlers until the session is naturally rebuilt.
- Marketplace metadata lives outside the app repo in `luccode-plugins`, the official community plugin catalog. The app reads the generated catalog URL by default, installs `distribution.kind = "release"` entries by downloading the zip package and verifying `sha256`, and keeps `distribution.kind = "source"` for local file marketplace development only. `versions[]` lets the catalog keep multiple SemVer releases; Luc selects the highest app-compatible version, blocks implicit downgrades, backs up old installs, and records successful installs in `${LUC_HOME}/plugin-installs.json`. `readmePath` is resolved relative to the catalog when the official URL is used.

## Agent Dev Loop

Agent-assisted plugin work should use Luc's dev loop instead of copying work-in-progress code into the production plugin directory.

- Source stays in the workspace or `${LUC_HOME}/plugin-dev-sources/`.
- `plugin.dev.install` copies the source into `${LUC_HOME}/plugins-dev/<pluginId>` and loads it through the normal `PluginManager`.
- `plugin.dev.reload` replaces the dev copy from the same source slot.
- `plugin.dev.disable`, `plugin.dev.enable`, `plugin.dev.reset`, and `plugin.dev.uninstall` control only the remembered dev slot. They do not write normal plugin preferences and do not remove community installs.
- `plugin.dev.invokeTool` runs a tool smoke test with explicit input. Pass `sessionId` or `sessionRef` for session-scoped tools; `sessionPath` remains a legacy locator compatibility field.
- `plugin.dev.diagnostics` returns dev slots, load status, logs, surfaces, and plugin diagnostics.
- `plugin.dev.listSurfaces` and `plugin.dev.describeSurfaceDebug` drive UI debugging.

Agent-callable dev tools are opt-in. The user must enable "Allow Agent plugin dev tools" in Settings -> Plugins before the Agent sees `plugin_dev_install`, `plugin_dev_reload`, `plugin_dev_disable`, `plugin_dev_enable`, `plugin_dev_reset`, `plugin_dev_uninstall`, `plugin_dev_invoke_tool`, `plugin_dev_diagnostics`, `plugin_dev_list_surfaces`, `plugin_dev_describe_surface`, or `plugin_dev_run_scenario`.

The trusted development identity comes from Luc's install record and the `${LUC_HOME}/plugins-dev/` slot, not from a manifest field. Pass `devRunId` when controlling lifecycle if the Agent has one, so stale tool calls cannot accidentally act on a newer dev run.

UI debugging is element-first. A capable Agent should inspect accessible elements, text, roles, labels, and stable locators before asking for screenshots. Screenshots are still useful for visual polish, clipping, theme contrast, and blank-state checks, but they are no longer the first source of truth when Luc can expose semantic UI structure.

## UI Path

Use `@luccode/plugin-sdk` for host communication:

```ts
import { luc } from '@luccode/plugin-sdk';

luc.ready();
luc.ui.resize({ height: 320 });
await luc.toast.show({ message: 'Ready' });
await luc.resources.open({ resource: { kind: 'session-file', fileId: 'sf_1' }, mode: 'preview' });
```

Use `luc.api.fetch(path, init)` for browser-side calls to this plugin's own dynamic route handlers. It derives the current plugin id from the iframe route and sends the `X-Luc-Plugin-Surface-Session` header that Luc issued with the iframe URL:

```ts
const res = await luc.api.fetch('api/translate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ domain: 'football' }),
});
```

Website-to-plugin conversions should rewrite same-plugin `fetch('/api/...')` calls to `luc.api.fetch(...)`. Do not hard-code `/api/plugins/{pluginId}/...` in browser code, and do not reuse `pluginIframeTicket` for XHR/fetch calls; that ticket is only for the iframe document load.

Browser-side code should not call third-party APIs directly. If a plugin needs live data from the public internet, call a same-plugin route with `luc.api.fetch(...)`; the route should use the runtime `ctx.network.fetch()` helper described below. When a route calls sensitive host capabilities, read the request-scoped context with `getPluginRequestContext(c)` and use `req.bus`. This keeps API keys out of iframe assets and lets Luc diagnose missing host, method, timeout, response-size, and capability declarations.

Browser-side resource helpers are host-mediated only: `luc.resources.open()`, `luc.resources.pick()`, and `luc.resources.requestAccess()` can ask Luc to open, choose, or grant access to a resource, but they do not expose filesystem reads or writes inside the iframe. Actual user-resource reads and writes belong in server-side plugin code through `ctx.resources`.

Use `luc.assets.url(path)` for browser-side references to files bundled under the plugin's `assets/` directory:

```ts
const logoUrl = luc.assets.url('images/logo.svg');
const videoUrl = luc.assets.url('videos/background.mp4');
```

Luc uses a VS Code-like webview resource boundary. The iframe entry route is authenticated by the host, then the host issues a short-lived, HttpOnly cookie scoped only to `/api/plugins/{pluginId}/assets/`. Static JS, CSS, fonts, images, JSON, wasm, and browser-playable video files are served from the plugin's own `assets/` directory through that path. Video assets support HTTP byte ranges for `<video>` playback and seeking. Do not rely on `?token` or `pluginIframeTicket` being copied to Vite chunks, `React.lazy()` imports, modulepreload links, CSS requests, or media requests.

For a built UI, put compiled files under `assets/` and point the shell at the host-served resource URL:

```html
<script type="module" src="/api/plugins/my-plugin/assets/dist/app.js"></script>
```

Keep source files, secrets, config, and private data outside `assets/`. The host rejects path traversal, dotfiles, source maps, and non-web asset extensions by default. Use plugin routes or SDK host requests for dynamic data.

Agent-generated plugins and scaffold updates should not create custom routes only to serve static resources such as CSS, JS, images, fonts, or MP4 files. Existing plugins that already use static-file compatibility handlers remain loadable. The documented contract for new work is to put those resources in `assets/` and reference them through `luc.assets.url(...)` or the same host-served assets path in the route shell. Treat `pluginIframeTicket` as a document-load credential only; do not manually append it to asset URLs.

Use `@luccode/plugin-components` for WebView/iframe UI:

```tsx
import { Button, CardShell, LucThemeProvider } from '@luccode/plugin-components';
import '@luccode/plugin-components/styles.css';

export function Panel() {
  return (
    <LucThemeProvider mode="inherit">
      <CardShell title="Plugin">
        <Button variant="primary">Run</Button>
      </CardShell>
    </LucThemeProvider>
  );
}
```

Theme fallback order is:

1. Explicit custom tokens passed to `LucThemeProvider`.
2. Named Luc tokens when `mode="luc"`.
3. Host CSS variables when `mode="inherit"`.
4. SDK defaults in `@luccode/plugin-components/styles.css`.

## Runtime Path

Use `@luccode/plugin-runtime` for Node-side plugin code:

```js
import {
  createAgent,
  createSession,
  definePlugin,
  defineTool,
  generateImage,
  registerTask,
  requestBus,
  sampleText,
  sendSessionMessage,
} from '@luccode/plugin-runtime';
```

Tools should return local files through `stageFile()` and `createMediaDetails()` so desktop, Bridge, Mobile PWA, and future remote clients all consume the same `SessionFile` / Resource identity.

Tools should also declare `sessionPermission` so Luc's session permission mode can make a precise decision before the tool runs. Use `readOnly: true` for pure reads, `kind: "plugin_output"` for bounded writes under `ctx.dataDir` that return `SessionFile` media, and `kind: "external_side_effect"` for provider, network, platform, or account actions that Auto mode should review. Tools that modify user workspace files should stay reviewer-bound unless they can describe a narrower side effect with `describeSideEffect(input)`.

```js
const tool = defineTool({
  name: 'create_note',
  description: 'Create a markdown note in plugin data.',
  sessionPermission: {
    kind: 'plugin_output',
    describeSideEffect: () => ({
      kind: 'session_file_output',
      summary: 'Write a markdown file under plugin data and register it as SessionFile media.',
      ruleId: 'plugin-output-session-file',
    }),
  },
  async execute(input, ctx) {
    // write under ctx.dataDir, then ctx.stageFile(...)
  },
});
```

### Runtime ResourceIO API

Use `ctx.resources` for user resources such as local workspace files, mounted files, `SessionFile` references, Resource records, and URLs. Declare the exact manifest capabilities the plugin needs:

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

`resource.read` covers `stat`, `read`, and `list`; `resource.search` covers search, including filename search with provider options; `resource.write` covers `write`, `writeExpectedVersion`, `edit`, `mkdir`, `delete`, `copy`, `rename`, `move`, and `trash`; `resource.materialize` is required before asking the host for a concrete local path; `resource.watch` covers backend watch subscriptions through `ctx.resources.watch()` and `ctx.resources.subscribe()`. URL resources are read-only and write attempts fail at the provider boundary. Plugin ResourceIO mutations run with `principal.kind = "plugin"` so audit logs and resource events can identify the plugin source. Plugin-generated artifacts may still be written under `ctx.dataDir` and returned with `stageFile()`, but user resource edits should not use raw local path writes.

Use `ctx.resources.watch(ref)` for a single resource and `ctx.resources.subscribe([refA, refB])` for a set. Both return `{ subscriptionId, resourceKeys, unsubscribe, close }`; lifecycle plugins should pass `unsubscribe` to `register()`, and short-lived tools should release it in `finally`. Resource events arrive through the normal plugin bus as `resource.changed`, `resource.deleted`, or `resource.renamed`; filter by `resourceKeys` before refreshing.

Treat ResourceIO as the only user-resource authority. `local-file`, `mount`, `session-file`, `resource`, and `url` refs are identity inputs, not promises that the plugin can see a host-local path. `stageFile()` is for plugin-generated artifacts that should be delivered as `SessionFile` media. `ctx.dataDir` and packaged `assets/` are plugin-owned storage; workspace, mount, URL, and SessionFile inputs are not. When a library needs a real path, call `ctx.resources.materialize(ref)` and keep the write-back path explicit through ResourceIO rather than editing the materialized file as if it were the source.

Scheduled automation plugin actions reuse plugin tools in v0. A cron executor saved as `plugin_action` with `{ pluginId, actionId, params }` maps to the loaded tool named `pluginId_actionId`. The scheduler stores only JSON data and invokes the tool at runtime; plugin-authored static `tools/*.js` tools and dynamic `ctx.registerTool()` tools both receive the SDK-style `(input, ctx)` call. If the plugin or tool is unavailable, the run fails explicitly and is recorded in cron history.

Lifecycle plugins should declare `activationEvents` in `manifest.json` when they do not need to start on app launch. Existing lifecycle plugins without this field still activate on startup for compatibility.

Long-running plugins should use the runtime task helpers (`registerTask`, `updateTask`, `completeTask`, `failTask`, `cancelTask`, `scheduleTask`) instead of hand-writing EventBus payloads.

### Runtime External HTTP API

Use `ctx.network.fetch()` for external HTTP APIs such as live scores, weather, prices, search, or third-party platform data. It is intentionally a runtime helper, not an iframe helper: iframe code calls a plugin route with `luc.api.fetch(...)`, and the route performs the outbound request.

Manifest:

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

Route:

```js
// routes/api.js
route.get('/live-scores', async (c) => {
  const ctx = c.get('pluginCtx');
  const res = await ctx.network.fetch(
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
    { cacheTtlMs: 30_000 },
  );
  return c.json(await res.json());
});
```

`ctx.network.fetch(input, init)` returns a standard `Response`. Extra options are:

- `timeoutMs`: per-call timeout, defaulting to `network.defaultTimeoutMs` or 15 seconds
- `cacheTtlMs`: in-memory GET cache TTL for this plugin context
- `maxResponseBytes`: per-call response body cap, defaulting to `network.maxResponseBytes` or 5 MiB

The host validates `network.fetch` capability declaration, `network.allowedHosts`, HTTP method, HTTPS scheme, private-network targets, timeout, cache, and response size. Direct Node `fetch()` in older plugins remains compatible, but new and refactored plugins should use `ctx.network.fetch()` so diagnostics can explain the missing manifest declaration instead of failing later in plugin code.

Do not put API keys, bearer tokens, or cookies in `assets/` or browser JavaScript. Define configuration schema fields and read them from `ctx.config` inside the route or lifecycle code.

Browser automation, login-backed websites, and turning a full external web app into a persistent plugin should use a separate future web-session capability rather than inventing ad hoc browser-control routes. Until that API exists, document the gap and keep ordinary data APIs on `ctx.network.fetch()`.

### Runtime Session and Agent API

Plugins can use the same session-facing operations that Luc's own UI and server use, through typed runtime helpers:

```js
import {
  createAgent,
  createChatSurfaceCard,
  createSession,
  getAgentProfile,
  listSessions,
  sendSessionMessage,
  subscribeSessionEvents,
} from '@luccode/plugin-runtime';

const agent = await createAgent(ctx, {
  name: 'Tavern Character',
  visibility: 'plugin_private',
  memoryPolicy: { enabled: true },
});

const session = await createSession(ctx, {
  agentId: agent.agent.id,
  kind: 'tavern',
  visibility: 'plugin_private',
  memoryEnabled: true,
  cwd: ctx.dataDir,
});
const sessionTarget = session.sessionRef ?? { sessionId: session.sessionId };

await sendSessionMessage(ctx, sessionTarget, {
  text: 'Hello',
  context: {
    beforeUser: [
      { label: 'world', text: 'The city is under moonlit rain.' },
      { label: 'mood', text: 'Keep the reply intimate and quiet.' },
    ],
  },
});

const off = subscribeSessionEvents(ctx, sessionTarget, (event) => {
  ctx.log.debug('session event', event);
});
```

`context.system`, `context.beforeUser`, and `context.afterUser` are injected into the model request through Luc's Pi SDK context hook for that turn only. They do not change the visible user message and are cleared after the prompt finishes. Use this for plugin-side RAG, world lore, mood, or scene state.

`visibility: 'plugin_private'` keeps plugin-owned agents and sessions out of Luc's main agent/session lists by default. The owning plugin can list them with `listAgents(ctx, { ownerPluginId: ctx.pluginId })` or `listSessions(ctx, { ownerPluginId: ctx.pluginId })`.

To show one of those plugin-owned private sessions inside the main chat stream, return a declarative `chat.surface` card:

```js
return {
  content: [{ type: 'text', text: 'Created a plugin-private run.' }],
  details: {
    card: createChatSurfaceCard(ctx, session.sessionRef ?? session, {
      title: 'Tavern run',
      description: 'Plugin-private transcript',
    }),
  },
};
```

`createChatSurfaceCard()` requires `sessionId` / `sessionRef`; path-only locators are rejected. Luc resolves the current session path from the manifest and only renders sessions owned by the same plugin with `visibility: 'plugin_private'` or `'private'`. In main this is a thin native transcript surface; rich composer and native card composition are not part of the public SDK contract yet.

### Runtime Model and Media API

Plugins can call the configured utility text model for routing, summaries, RAG query rewriting, and similar background work:

```js
const { text } = await sampleText(ctx, {
  operation: 'world-lore-query',
  messages: [{ role: 'user', content: 'Extract search keywords for this scene.' }],
  maxTokens: 120,
});
```

Media helpers expose Luc's configured provider stack. `listMediaProviders()` and `resolveMediaModel()` are stable discovery helpers for configured image/video/speech-capable providers; they do not make adapter execution contracts stable by themselves. `generateImage()` submits an image generation task through the built-in media task pipeline and returns a task/batch result; by default generated files are delivered as `SessionFile` resources when the task completes. Use `referenceImages` with `SessionFile` references for multi-reference image generation. Image/video adapters must declare reference-image support on the selected model mode with `modes[].inputLimits.referenceImages`, for example `{ min: 1, max: 1 }` for single-image-to-video or `{ min: 0, max: 0 }` for text-only generation. The task pipeline rejects unsupported reference images before enqueueing. `generateVideo()`, `generateMedia()`, and `transcribeAudio()` use the same native media manager for video tasks and ASR. `transcribeAudio()` returns `{ ok: true, transcription }`.

Image/video helpers keep a stable top-level shape. Provider-specific controls go through `options`. Parameter support belongs to the model and usually to the mode, not to the provider as a whole: use `models[].modes[].parameterSchema`, `modes[].defaults`, `modes[].inputLimits`, `modes[].pricing`, and `modes[].agentHints` so settings UI, Agent discovery, and runtime validation all read the same contract.

```js
const result = await generateImage(ctx, {
  sessionId: ctx.sessionId,
  sessionRef: ctx.sessionRef,
  prompt: 'A handwritten character card on warm paper',
  referenceImages: [
    { kind: 'session_file', fileId: 'sf_reference_a' },
    { kind: 'session_file', fileId: 'sf_reference_b' },
  ],
  ratio: '3:2',
  resolution: '2k',
});
```

For plugin-owned jobs that should not create chat history, Bridge delivery, or `SessionFile` records, pass `delivery: { mode: 'response' }` and omit `sessionId`/`sessionPath`. The returned task can be polled through `GET /api/media/tasks/:taskId`; once it is done, read `task.files[]` and fetch each file from `GET /api/media/generated/:filename`.

```js
const result = await generateImage(ctx, {
  prompt: 'A small icon on transparent background',
  delivery: { mode: 'response' },
});
```

Plugin backend code should prefer the SDK helpers above. Lightweight plugin pages or route handlers that already have host HTTP credentials can also submit through the native facade:

```http
POST /api/media/generate
POST /api/media/image/generate
POST /api/media/video/generate
POST /api/media/asr/transcribe
```

The image/video endpoints require `prompt`; default `delivery.mode = "session"` also requires `sessionId` or legacy `sessionPath`. With `delivery.mode = "response"`, image/video requests may omit both and will not create `SessionFile` records. ASR requires `sessionId` or legacy `sessionPath` plus `fileId`. Image reference fields on the native facade accept only `SessionFile` references such as `{ "kind": "session_file", "fileId": "sf_..." }`; raw local paths are reserved for legacy/internal image-gen calls. These routes require chat-scope host credentials and forward into the same native Media Manager task pipeline as the SDK helpers.

For Agent-assisted development, plugins can declare `manifest.dev.scenarios`. These are not runtime features; they are smoke-test instructions for Luc's dev loop and should only describe repeatable checks such as invoking a tool, expecting text in the result, or opening a declared UI surface. `invokeTool` scenario steps may pass `sessionId`, `sessionRef`, `sessionPath`, and `agentId`; prefer `sessionId/sessionRef` for new scenarios.

Pi SDK extension factories live in `extensions/*.js` and are loaded only for full-access plugins:

```js
// extensions/request-audit.js
export default function(pi) {
  pi.on('before_provider_request', (event) => {
    event.payload.metadata = {
      ...(event.payload.metadata || {}),
      auditedBy: 'my-plugin',
    };
    return event.payload;
  });
}
```

Use extensions for request-pipeline hooks such as provider request rewriting, context filtering, and tool-call observation. Do not use them for ordinary tool behavior; a normal `tools/*.js` contribution is safer and can remain restricted.

Provider plugins can use `defineProvider()` for TypeScript-friendly authoring, then export named provider fields from `providers/*.js`:

```js
import { defineProvider } from '@luccode/plugin-runtime';

const provider = defineProvider({
  id: 'my-image-cli',
  displayName: 'My Image CLI',
  authType: 'none',
  runtime: {
    kind: 'local-cli',
    protocolId: 'local-cli-media',
    command: {
      executable: 'my-image-cli',
      args: [
        { literal: 'generate' },
        { option: '--prompt', from: 'prompt' },
        { option: '--model', from: 'modelId' },
        { option: '--output', from: 'outputDir' },
      ],
      timeoutMs: 120000,
      output: { kind: 'file_glob', directory: 'outputDir', pattern: '*.png' },
    },
  },
  capabilities: {
    chat: { projection: 'none' },
    media: {
      imageGeneration: {
        models: [{
          id: 'my-image-model',
          displayName: 'My Image Model',
          protocolId: 'local-cli-media',
          inputs: ['text'],
          outputs: ['image'],
          modes: [{
            id: 'text2image',
            label: 'Text to image',
            inputLimits: { referenceImages: { min: 0, max: 0 } },
            parameterSchema: {
              type: 'object',
              properties: {
                ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'], default: '1:1' },
              },
            },
          }],
        }],
      },
    },
  },
});

export const { id, displayName, authType, runtime, capabilities } = provider;
```

Provider declarations own model discovery and capability metadata. Media adapters own protocol execution. A plugin that only calls legacy `media-gen:register-adapter` can still provide an executor during the compatibility window, but it should also contribute a ProviderPlugin with `capabilities.media.*`; otherwise the model will not appear in provider settings, default media model selectors, or `listMediaProviders()`. Agent-generated plugins and new templates must not call `media-gen:*`; use `providers/*.js`, the media helpers, and the formal Adapter Plugin API once that execution surface is available.

Migration rule for older image-generation plugins:

- `providers/*.js` with image capability: keep the provider entrypoint and add/verify `capabilities.media.imageGeneration.models[].protocolId`.
- Adapter-only `media-gen:*` plugin: add a ProviderPlugin declaration, then keep the adapter registration only as the execution layer until a stable Adapter Plugin API replaces the compatibility namespace.

CLI-backed providers must use structured argument bindings. Avoid shell command strings; the host runtime validates the contract and runs local commands through non-shell execution.

See `examples/plugins/sdk-showcase/` for a compact plugin that shows the current recommended shape.
