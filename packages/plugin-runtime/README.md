# @luccode/plugin-runtime

Node-side helper package for Luc plugins.

This package is intentionally small. It gives plugin authors stable shapes and TypeScript types while preserving Luc's current plugin loading model.

```ts
import { definePlugin, defineTool } from '@luccode/plugin-runtime';

export const searchTool = defineTool({
  name: 'search',
  description: 'Search project data',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    ctx.log.info('searching', input);
    return `results for ${input.query}`;
  },
});

export default definePlugin({
  async onload(ctx, { register }) {
    if (ctx.registerTool) {
      register(ctx.registerTool(searchTool));
    }
  },
});
```

Static `tools/*.js` and `commands/*.js` still use Luc's named export loader today. Lifecycle plugins can already use `export default definePlugin(...)` because the host expects a default class-compatible value.

Scheduled automation `plugin_action` jobs reuse plugin tools in v0. The scheduler stores `{ pluginId, actionId, params }` and invokes the loaded tool named `pluginId_actionId`; both static tools and dynamic `ctx.registerTool()` tools receive the SDK-style `(input, ctx)` call.

## EventBus helpers

```ts
import { defineBusHandler, LUC_BUS_SKIP, requestBus } from '@luccode/plugin-runtime';

export const bridgeSend = defineBusHandler<
  { platform: string; text: string },
  { sent: boolean } | typeof LUC_BUS_SKIP
>({
  type: 'bridge:send',
  async handle(payload) {
    if (payload.platform !== 'telegram') return LUC_BUS_SKIP;
    return { sent: true };
  },
});

export default definePlugin({
  async onload(ctx, { register }) {
    register(ctx.bus.handle(bridgeSend.type, (payload) => bridgeSend.handle(payload as any, ctx as any), {
      capability: {
        title: 'Bridge send',
        description: 'Send text to a bridge platform.',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        permission: 'bridge.send',
        errors: ['NO_HANDLER', 'TIMEOUT'],
        owner: 'plugin:example',
        stability: 'experimental',
      },
    }));

    await requestBus(ctx, 'session:send', {
      sessionId: ctx.sessionId,
      sessionRef: ctx.sessionRef,
      text: 'Plugin loaded',
    }, { timeout: 5000 });
  },
});
```

`LUC_BUS_SKIP` is the shared skip sentinel used by the host `EventBus.SKIP`, so SDK-authored handlers can participate in chained handlers without importing host internals.

Use `ctx.bus.listCapabilities?.()` or `ctx.bus.getCapability?.(type)` to inspect
the host EventBus capability directory before making optional requests.

## Plugin route request context

Route handlers receive a request-scoped context from the host. Use
`getPluginRequestContext(c)` instead of reading `c.get('pluginRequestContext')`
directly when a route calls system capabilities:

```ts
import { getPluginRequestContext } from '@luccode/plugin-runtime';

export default function(app) {
  app.post('/create-session', async (c) => {
    const req = getPluginRequestContext(c);
    // req.agentId is null when the surface belongs to no agent (a preview, for
    // example). Handle that case rather than treating it as a default agent.
    if (!req.agentId) return c.json({ error: 'this surface has no agent yet' }, 400);
    const result = await req.bus.request('session:create', { agentId: req.agentId });
    return c.json(result);
  });
}
```

`req.bus` validates sensitive system capability calls against the plugin
manifest and the current full-access grant for this HTTP request.

## External HTTP APIs

Use `ctx.network.fetch()` when runtime plugin code needs public HTTP data such as
live scores, weather, prices, search, or third-party platform APIs. Browser
iframe code should call this plugin's own route with `luc.api.fetch(...)`; the
route then calls `ctx.network.fetch(...)`.

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

```ts
route.get('/live-scores', async (c) => {
  const ctx = c.get('pluginCtx');
  const res = await ctx.network.fetch(
    'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
    { cacheTtlMs: 30_000 },
  );
  return c.json(await res.json());
});
```

`ctx.network.fetch()` returns a standard `Response`. It validates the
`network.fetch` capability, manifest host allowlist, HTTP method, HTTPS scheme,
private-network targets, timeout, cache TTL, and response byte limit. Keep API
keys in plugin configuration and read them from route or lifecycle code; do not
ship secrets in iframe assets.

## User resource access

Use `ctx.resources` when runtime plugin code needs user resources such as local
workspace files, mounted files, `SessionFile` references, Resource records, or
URLs.

```json
{
  "capabilities": ["resource.read", "resource.search", "resource.write"]
}
```

```ts
export const updateNote = defineTool({
  name: 'update_note',
  description: 'Update a mounted note',
  async execute(input: { mountId: string; path: string }, ctx) {
    const ref = { kind: 'mount' as const, mountId: input.mountId, path: input.path };
    const file = await ctx.resources.read(ref);
    await ctx.resources.write(ref, file.content.toString() + '\nupdated\n');
    return 'updated';
  },
});
```

`resource.read` covers `stat`, `read`, and `list`; `resource.search` covers
search, including filename search through provider options; `resource.write`
covers `write`, `writeExpectedVersion`, `edit`, `mkdir`, `delete`, `copy`,
`rename`, `move`, and `trash`;
`resource.materialize` is required before asking the host for a concrete local
path; `resource.watch` covers backend watch subscriptions through
`ctx.resources.watch()` / `ctx.resources.subscribe()`. URL resources are read-only.
Resource mutations run with `principal.kind = "plugin"` and the current plugin id
so ResourceIO audit logs can identify the source. Plugin-generated artifacts can
still be written under `ctx.dataDir` and returned with `stageFile()`, but user
resource edits should go through `ctx.resources`.

Lifecycle plugins should release resource watches through the lifecycle
disposable helper:

```ts
export default definePlugin({
  async onload(ctx, { register }) {
    const watch = ctx.resources.watch({ kind: 'mount', mountId: 'docs', path: '' });
    register(watch.unsubscribe);
    register(ctx.bus.subscribe((event) => {
      if (event.type === 'resource.changed' && watch.resourceKeys.includes(event.resourceKey)) {
        ctx.log.info('resource changed', event.resourceKey);
      }
    }, { types: ['resource.changed', 'resource.deleted', 'resource.renamed'] }));
  },
});
```

Resource refs are identity objects. A `mount`, `session-file`, `resource`, or
`url` input should not be converted to a guessed local path by plugin code.
`stageFile()` is for generated output delivery, while `ctx.resources` is for
reading, writing, searching, watching, or materializing user resources. When
`materialize()` is needed for a parser or CLI, treat the returned path as an
execution boundary and perform any source mutation through ResourceIO.

## Tool session permissions

Declare `sessionPermission` on Agent-callable tools so Luc can apply the current
session permission mode before the tool runs. Prefer an invocation resolver and
classify each concrete action as `read`, `routine`, or `review`:

- `read` only inspects already-authorized data and also runs in Read-only mode.
- `routine` declares that the action stays within the current workspace/sandbox.
  Plugin invocations remain automatically reviewed in Auto unless the host has
  explicitly preauthorized that exact capability; Ask prompts and Read-only
  blocks it.
- `review` crosses a trust boundary, such as an external service, account,
  notification route, or destructive target. Auto sends only this invocation to
  the automatic reviewer.

Static `readOnly`, `kind`, and `auto` fields remain the compatibility path for
existing tools without an invocation resolver. For example, use `readOnly: true`
for pure reads, `kind: 'plugin_output'` for bounded plugin-data writes returned
through `stageFile()`, and `kind: 'external_side_effect'` for provider, network,
platform, or account actions. The host accepts that legacy path only from
resolver-less, plain own-data metadata and copies the supported fields before
policy evaluation; accessors, inherited resolvers, and class instances fail
closed.

```ts
export const renderImage = defineTool({
  name: 'render_image',
  description: 'Render an image and return it as SessionFile media.',
  sessionPermission: {
    kind: 'plugin_output',
    describeSideEffect: () => ({
      kind: 'session_file_output',
      summary: 'Writes output under plugin data and registers SessionFile media.',
      ruleId: 'plugin-output-session-file',
    }),
  },
  async execute(input, ctx) {
    // write under ctx.dataDir, then ctx.stageFile(...)
  },
});
```

Multi-action tools should additionally resolve each concrete call with the
synchronous, non-mutating `resolveInvocation(input)` contract. The capability is
the tool's local definition name plus the resolved action. Luc strips the plugin
prefix before checking this relation, so a plugin tool named `team_message`
declares `team_message.send`, not `<plugin-id>_team_message.send`.

```ts
export const teamMessage = defineTool({
  name: 'team_message',
  description: 'Read or send a team-channel message.',
  sessionPermission: {
    resolveInvocation(input: { action: string; channelId?: string }) {
      if (input.action === 'read' && input.channelId) {
        return {
          action: 'read',
          kind: 'read',
          capability: 'team_message.read',
          target: { type: 'channel', id: input.channelId },
        };
      }
      if (input.action === 'send' && input.channelId) {
        return {
          action: 'send',
          kind: 'review',
          capability: 'team_message.send',
          target: { type: 'channel', id: input.channelId, label: input.channelId },
        };
      }
      return null;
    },
  },
  async execute(input, ctx) {
    // ...
  },
});
```

Resolvers must return a plain descriptor synchronously. Returning `null`,
throwing, returning a Promise/thenable, using an unknown kind, or declaring a
capability that does not match `<tool-name>.<action>` fails closed; Luc attaches
a rejection consumer to asynchronous results and never falls back to the legacy
static policy once a resolver exists. The resolver owns the mapping from its
input schema to this stable permission action; the host does not infer aliases.

Targets use a stable, wildcard-free `{ type, id, label? }` identity, with `id`
limited to 4096 characters. Sort multi-target inputs before deriving `id`;
`label` is display-only reviewer context and never participates in identity.
Context-default or otherwise dynamic routes stay per-invocation reviews. Actor,
server, and session identity are derived by the host and must never appear in a
resolver descriptor or its `sideEffect` metadata.

## Session, Agent, model, and media helpers

Plugins that need their own chat surface should use the typed helpers instead of
writing session files or importing host internals. `createSession()` creates a
detached Luc session, so it does not switch the main UI focus.

```ts
import {
  createAgent,
  createSession,
  generateMedia,
  generateImage,
  transcribeAudio,
  sampleText,
  sendSessionMessage,
  subscribeSessionEvents,
} from '@luccode/plugin-runtime';

export default definePlugin({
  async onload(ctx, { register }) {
    const agent = await createAgent(ctx, {
      name: 'Tavern Character',
      visibility: 'plugin_private',
      memoryPolicy: { enabled: true },
    });

    const session = await createSession(ctx, {
      agentId: (agent as any).agent.id,
      kind: 'tavern',
      visibility: 'plugin_private',
      cwd: ctx.dataDir,
    });

    const query = await sampleText(ctx, {
      operation: 'tavern-rag-query',
      messages: [{ role: 'user', content: 'Extract world-lore keywords for this turn' }],
      maxTokens: 80,
    });

    const sessionTarget = (session as any).sessionRef ?? { sessionId: (session as any).sessionId };

    await sendSessionMessage(ctx, sessionTarget, {
      text: 'I push the door open.',
      context: {
        beforeUser: [
          { label: 'world', text: 'Rainy city night; the old theater is still open.' },
          { label: 'rag_query', text: (query as any).text },
        ],
      },
    });

    register(subscribeSessionEvents(ctx, sessionTarget, (event) => {
      ctx.log.info('session event', event);
    }));

    await generateImage(ctx, {
      sessionId: (session as any).sessionId,
      sessionRef: (session as any).sessionRef,
      prompt: 'A handwritten character card on warm paper',
      referenceImages: [
        { kind: 'session_file', fileId: 'sf_reference_a' },
        { kind: 'session_file', fileId: 'sf_reference_b' },
      ],
      ratio: '3:2',
    });

    await generateMedia(ctx, {
      kind: 'video',
      sessionId: (session as any).sessionId,
      sessionRef: (session as any).sessionRef,
      prompt: 'A slow page-turn animation on warm paper',
    });

    const transcription = await transcribeAudio(ctx, {
      sessionId: (session as any).sessionId,
      sessionRef: (session as any).sessionRef,
      fileId: 'session-file-id',
    });
    ctx.log.info('transcription', transcription);
  },
});
```

For backend code, prefer these helpers so permission checks and delivery semantics stay explicit. Plugin pages or plugin route handlers that already have host HTTP credentials can call the native facade directly: `POST /api/media/image/generate`, `POST /api/media/video/generate`, `POST /api/media/generate`, and `POST /api/media/asr/transcribe`. The submit routes require chat scope, image references must use `SessionFile` references such as `{ kind: 'session_file', fileId }`, and all requests forward into the same native Media Manager pipeline. Image and video models must declare reference-image support on the selected mode through `modes[].inputLimits.referenceImages`, such as `{ min: 0, max: 0 }` for text-only generation or `{ min: 1, max: 1 }` for a single-reference mode.

Image and video generation default to `delivery: { mode: 'session' }`, which requires `sessionId` or legacy `sessionPath` and delivers completed files as `SessionFile` records. For plugin-owned jobs that only need a generated artifact, use `delivery: { mode: 'response' }` and omit session identity; poll `GET /api/media/tasks/:taskId` until `task.status === 'done'`, then fetch filenames from `task.files[]` via `GET /api/media/generated/:filename`.

```ts
const result = await generateImage(ctx, {
  prompt: 'A small icon on transparent background',
  delivery: { mode: 'response' },
});
```

Declare ordinary needs in manifest `capabilities`, such as `session`, `agent`,
`model.sample`, and `media.generate`. `sensitiveCapabilities` records future
user-granted permission intent. `session:send.context` is injected only into the
current provider request; it does not rewrite the visible user message or the
persisted user text.

## Usage ledger helpers

Plugins that declare `usage.read` can inspect persisted LLM usage records and
subscribe to new usage events:

```ts
import { definePlugin, listUsageEntries, subscribeUsageEvents } from '@luccode/plugin-runtime';

export default definePlugin({
  async onload(ctx, { register }) {
    const usage = await listUsageEntries(ctx, {
      since: '2026-05-01T00:00:00.000Z',
      limit: 100,
    });

    ctx.log.info('usage records', usage.entries.length);

    register(subscribeUsageEvents(ctx, (entry, meta) => {
      ctx.log.info('new usage entry', entry.requestId, meta.sessionId, meta.sessionPath);
    }));
  },
});
```

`listUsageEntries()` calls the host `usage:list` capability. `subscribeUsageEvents()`
subscribes to live `llm_usage` events. Restricted plugins must include
`"permissions": ["usage.read"]` in `manifest.json`; otherwise the host rejects
the request or subscription.

## SessionFile media helpers

```ts
import { createMediaDetails, defineTool } from '@luccode/plugin-runtime';

export const renderImage = defineTool({
  name: 'render_image',
  description: 'Render an image',
  async execute(_input, ctx) {
    const staged = ctx.stageFile?.({
      sessionId: ctx.sessionId,
      sessionRef: ctx.sessionRef,
      filePath: '/absolute/path/to/image.png',
      label: 'image.png',
    });
    if (!staged) throw new Error('stageFile unavailable');

    return {
      content: [{ type: 'text', text: 'Image generated' }],
      details: createMediaDetails([staged]),
    };
  },
});
```

Use `stageFile()` for plugin-generated local files. `createMediaDetails()` normalizes staged files, existing `session_file` media items, and serialized `SessionFile` records into the `details.media.items` shape consumed by desktop, Bridge, Mobile PWA, and future remote clients.

## Plugin-private chat surfaces

Use `createChatSurfaceCard()` when a tool creates or updates a plugin-owned private session and wants to show its transcript in the current chat stream:

```ts
import { createChatSurfaceCard, createSession, defineTool } from '@luccode/plugin-runtime';

export const startRun = defineTool({
  name: 'start_run',
  description: 'Start a plugin-private chat run',
  async execute(_input, ctx) {
    const child = await createSession(ctx, {
      kind: 'plugin-run',
      visibility: 'plugin_private',
      cwd: ctx.dataDir,
    });

    return {
      content: [{ type: 'text', text: 'Created a plugin-private run.' }],
      details: {
        card: createChatSurfaceCard(ctx, child.sessionRef ?? child, {
          title: 'Plugin run',
          description: 'Plugin-private transcript',
        }),
      },
    };
  },
});
```

The helper requires `sessionId` / `sessionRef`; passing only a legacy `sessionPath` throws. Luc resolves the current path through the session manifest and only renders sessions owned by the same plugin with `plugin_private` or `private` visibility. Main currently provides a thin native transcript surface; richer composer and native card composition are not part of the public runtime contract yet.

## Provider contributions

Provider plugins live in `providers/*.js` and require `trust: "full-access"`.
The runtime package exposes provider types and `defineProvider()` for authoring, but the host loader still reads named exports from each provider file.
Provider declarations are the canonical discovery layer for models and media capabilities. Media adapters execute a declared `protocolId`; adapter registration alone does not make a model discoverable in provider settings, default media model selectors, or media helper APIs.

```ts
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
      timeoutMs: 120_000,
      output: { kind: 'file_glob', directory: 'outputDir', pattern: '*.png' },
    },
  },
  capabilities: {
    chat: { projection: 'none' },
    media: {
      imageGeneration: {
        models: [
          {
            id: 'my-image-model',
            displayName: 'My Image Model',
            protocolId: 'local-cli-media',
            inputs: ['text'],
            outputs: ['image'],
            modes: [
              {
                id: 'text2image',
                label: 'Text to image',
                inputLimits: { referenceImages: { min: 0, max: 0 } },
                parameterSchema: {
                  type: 'object',
                  properties: {
                    ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'], default: '1:1' },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
});

export const { id, displayName, authType, runtime, capabilities } = provider;
```

Keep chat and media capabilities explicit. Media-only providers should use `chat.projection = "none"`, and CLI providers must use structured argument bindings rather than shell command strings.

Chat providers may separate their Luc catalog identity from their execution identity. Use
`runtimeProviderId` for the execution/auth key and `credentialSource` to declare ownership:
`provider-catalog` reads API-key configuration, `auth-storage` uses the OAuth store without
copying tokens into `models.json`, and `none` is for providers that require no credential.
The `models` field has three states: missing uses the provider declaration defaults, `[]`
explicitly disables chat models, and a non-empty array is the exact user allowlist.
`sdk-auth-alias` remains a legacy compatibility mode whose model list is owned by the
runtime SDK catalog. New OAuth providers should use `projection: "models-json"` together
with `credentialSource: "auth-storage"` so the host owns the model catalog while the
OAuth store owns request credentials.

Legacy image-generation plugins may still use `media-gen:register-adapter` as a compatibility execution path. New plugins and Agent-generated scaffolds must not call `media-gen:*`; declare a ProviderPlugin with `capabilities.media.*` for discovery, then use the stable media helpers or the formal Adapter Plugin API when that execution surface is available.

## Pi SDK extensions

Pipeline extensions live in `extensions/*.js` and require `trust: "full-access"`. They receive Pi SDK's `ExtensionAPI` and can observe or transform request-pipeline events such as provider requests, context construction, and tool calls.

```ts
export default function(pi) {
  pi.on('before_provider_request', (event) => {
    event.payload.metadata = {
      ...(event.payload.metadata || {}),
      source: 'my-plugin',
    };
    return event.payload;
  });
}
```

Use extensions only when the plugin needs to run inside the LLM pipeline. Ordinary Agent actions should stay in `tools/*.js` so they can use the restricted permission tier. After a full-access plugin is installed, enabled, or reloaded, Luc rebinds extension runners for idle sessions; in-flight sessions pick up the change on the next safe rebuild.
