# SDK Showcase Plugin

This example demonstrates the four SDK layers together:

- `@luccode/plugin-runtime` for lifecycle, EventBus, tools, and SessionFile media details.
- `@luccode/plugin-sdk` for iframe handshake and host capabilities.
- `@luccode/plugin-components` for Luc-styled React iframe UI.
- `@luccode/plugin-protocol` indirectly through the iframe SDK.

The `routes/page.js` file serves a minimal iframe shell. In a real plugin, bundle the UI from `ui/Panel.tsx` into `assets/panel.js` and `assets/panel.css`, then copy this directory into `${LUC_HOME}/plugins/sdk-showcase`.

Luc serves plugin static files through `/api/plugins/{pluginId}/assets/...` with a path-scoped asset session cookie. Keep only built UI files and public media under `assets/`; use `luc.assets.url(path)` from browser code for images, JSON, wasm, or other static files referenced after the iframe has loaded.

Useful checks from the repo root:

```bash
npm run typecheck
npm run build:packages
```

The example requests `external.open` and `clipboard.writeText` in `manifest.json`. `toast.show` is available without a grant.
