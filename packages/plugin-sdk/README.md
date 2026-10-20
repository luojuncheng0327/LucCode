# @luccode/plugin-sdk

Browser-side SDK for Luc WebView/iframe plugins.

```ts
import { luc } from '@luccode/plugin-sdk';

luc.ready();
const logoUrl = luc.assets.url('images/logo.svg');
luc.ui.resize({ height: 320 });

await luc.toast.show({ message: 'Saved', type: 'success' });
await luc.external.open('https://example.com');
await luc.clipboard.writeText('Copied text');
await luc.resources.open({ resource: { kind: 'session-file', fileId: 'sf_1' }, mode: 'preview' });
```

## Assets

Use `luc.assets.url(path)` for files bundled under the plugin's `assets/` directory:

```ts
const js = luc.assets.url('dist/app.js');
const logo = luc.assets.url('/images/logo.svg');
```

The helper returns `/api/plugins/{pluginId}/assets/{path}` for the current iframe plugin. It accepts only relative, non-dotfile paths. Luc serves these resources through a path-scoped, HttpOnly asset session cookie, so Vite chunks, lazy imports, CSS, fonts, images, JSON, wasm, and browser-playable video files such as MP4 should live under `assets/`. The host asset route supports byte ranges for video playback.

Do not put secrets, source files, or source maps in `assets/`. Agent-generated plugins and newly edited plugin UI should not create custom route handlers just to serve static files such as CSS, JS, images, or MP4. Existing plugins that already expose static-file compatibility handlers remain loadable; treat the official `assets/` route plus `luc.assets.url(...)` as the documented contract for new work.

## Plugin API Routes

Use `luc.api.fetch(path, init)` when browser code calls this plugin's own route handlers:

```ts
const res = await luc.api.fetch('api/translate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ domain: 'football' }),
});
```

The helper builds `/api/plugins/{pluginId}/{path}` for the current iframe plugin and sends the `X-Luc-Plugin-Surface-Session` header from the iframe URL. Do not reuse `pluginIframeTicket` for `fetch()` calls, and do not hard-code `/api/plugins/{pluginId}/...` in browser code. `luc.api.url(path)` is available when you only need the current plugin route URL.

## Host Requests

Stable helpers are thin wrappers around `luc.host.request(type, payload)`.

| Helper | Capability | Grant |
| --- | --- | --- |
| `luc.toast.show(input)` | `toast.show` | no |
| `luc.external.open(input)` | `external.open` | yes |
| `luc.clipboard.writeText(input)` | `clipboard.writeText` | yes |
| `luc.resources.open(input)` | `resource.open` | yes |
| `luc.resources.pick(input)` | `resource.pick` | yes |
| `luc.resources.requestAccess(input)` | `resource.requestAccess` | yes |

Grant-required capabilities must be declared in `manifest.json`:

```json
{
  "manifestVersion": 1,
  "ui": {
    "hostCapabilities": ["external.open", "clipboard.writeText", "resource.open"]
  }
}
```

Browser-side resource helpers are host requests only. They can ask Luc to open
or reveal local/session/url resources, show the host picker, or request access,
but they do not expose direct filesystem read or write APIs inside the iframe.
Runtime code that actually reads or edits user resources should use
`ctx.resources` from `@luccode/plugin-runtime`.

Do not mirror runtime ResourceIO operations into iframe code. The browser SDK is
for presentation and host-mediated actions; server-side plugin tools, routes, or
lifecycle code own the actual resource read/write path.

## Theme

Use `luc.theme.getSnapshot()` for initial theme data and `luc.theme.subscribe(callback)` for host theme updates. The host also passes `luc-theme` and `luc-css` query parameters for compatibility with simple iframe pages.
