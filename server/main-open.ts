/**
 * server/main-open.ts — open composition process entry.
 *
 * The thin entry an open-composition server distribution spawns/imports —
 * the dual of server/main-full.ts, which does the same for the closed
 * product. It statically imports only server/index.ts's `startServer`
 * export and calls it with an empty composition root: no
 * `registerClosedRoutes` hook, no `builtinMediaAdapters` — exactly the
 * open route/WS surface `composition/open-root.ts` mounts unconditionally,
 * nothing closed-product layered on top. See composition/contract.ts for
 * why `root.registerClosedRoutes?.()` in server/index.ts is a static
 * composition-time parameter, not a runtime switch: which composition
 * boots is decided once, by which entry file gets spawned — this file vs.
 * main-full.ts — never by an env var or config flag read inside
 * startServer() itself.
 *
 * scripts/build-server-open.mjs's Vite bundle uses this file as its entry
 * (via vite.config.server.js's LUC_SERVER_BUNDLE_ENTRY override) to
 * produce an open-composition packaged bundle; scripts/build-server.mjs
 * (full) continues to bundle server/main-full.ts and never imports this
 * file.
 */
import { startServer } from "./index.ts";

await startServer({});
