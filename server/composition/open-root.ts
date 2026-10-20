/**
 * server composition — open root.
 *
 * Mounts every open (redistributable) route/WS surface on the shared Hono
 * `app`. This is the file `server/index.ts` unconditionally, statically
 * imports — see `./contract.ts` for why that import is not a runtime
 * switch. Every line below is moved verbatim from `server/index.ts`'s old
 * inline mount block (same factory, same arguments, same relative order
 * among open routes); `server/routes/mobile-workbench.ts` deliberately
 * stays mounted directly in `server/index.ts` instead of here — it is
 * still `evidence-needed` (neither confirmed open nor confirmed
 * closed-product, see build/open-boundary-baseline.json), and this file
 * must not silently reclassify it by absorbing its mount call.
 */
import type { Hono } from "hono";
import type { CompositionContext } from "./contract.ts";
import { fromRoot } from "../../shared/luc-root.ts";
import { createChatRoute } from "../routes/chat.ts";
import { createSessionsRoute } from "../routes/sessions.ts";
import { createSessionCollabRoute } from "../routes/session-collab.ts";
import { createSessionProjectsRoute } from "../routes/session-projects.ts";
import { createModelsRoute } from "../routes/models.ts";
import { createConfigRoute } from "../routes/config.ts";
import { createUploadRoute } from "../routes/upload.ts";
import { createProvidersRoute } from "../routes/providers.ts";
import { createAgentsRoute } from "../routes/agents.ts";
import { createDevicesRoute } from "../routes/devices.ts";
import { createSkillsRoute } from "../routes/skills.ts";
import { createChannelsRoute } from "../routes/channels.ts";
import { createDmRoute } from "../routes/dm.ts";
import { createFsRoute } from "../routes/fs.ts";
import { createPreferencesRoute } from "../routes/preferences.ts";
import { createInputDraftsRoute } from "../routes/input-drafts.ts";
import { createSettingsSnapshotRoute } from "../routes/settings-snapshot.ts";
import { createExperimentsRoute } from "../routes/experiments.ts";
import { createBridgeRoute } from "../routes/bridge.ts";
import { createAuthRoute } from "../routes/auth.ts";
import { createConfirmRoute } from "../routes/confirm.ts";
import { createMediaRoute } from "../routes/media.ts";
import { createMcpRoute } from "../routes/mcp.ts";
import { createPluginsRoute } from "../routes/plugins.ts";
import { createCheckpointsRoute } from "../routes/checkpoints.ts";
import { createCommandsRoute } from "../routes/commands.ts";
import { createServerIdentityRoute } from "../routes/server-identity.ts";
import { createResourcesRoute } from "../routes/resources.ts";
import { createResourceIoRoute } from "../routes/resource-io.ts";
import { createFileHistoryRoute } from "../routes/file-history.ts";
import { createUsageRoute } from "../routes/usage.ts";
import { createWebAuthRoute } from "../routes/web-auth.ts";
import { createWebSocketAuthRoute } from "../routes/ws-auth.ts";
import { createStudioWorkspacesRoute } from "../routes/studio-workspaces.ts";
import { createMobileStaticRoute, resolveMobileStaticRouteOptions } from "../routes/mobile-static.ts";
import { createHtmlPreviewRoute } from "../routes/html-preview.ts";
import { createAccessRoute } from "../routes/access.ts";
import { createSpeechRecognitionRoute } from "../routes/speech-recognition.ts";
import { createMemoryDreamRoute } from "../routes/memory-dream.ts";

/**
 * `/mobile`、`/desktop` 网页客户端入口的供货模式，启动时决议一次 —— 见
 * server/index.ts 原有同名函数的注释（原样搬入，未改动判定逻辑）。
 */
function decideMobileStaticRouteOptions() {
  return resolveMobileStaticRouteOptions({
    env: process.env,
    devDistDir: fromRoot("desktop", "dist-renderer"),
  });
}

export function registerOpenRoutes(app: Hono, ctx: CompositionContext): void {
  const {
    engine,
    hub,
    upgradeWebSocket,
    wsTicketService,
    serverAuthService,
    serverRuntimeState,
    bridgeManagerRef,
    confirmStore,
    appVersion,
  } = ctx;

  const { restRoute: chatRestRoute, wsRoute: chatWsRoute } = createChatRoute(engine, hub, { upgradeWebSocket });
  app.route("", createMobileStaticRoute(decideMobileStaticRouteOptions()));
  app.route("", createHtmlPreviewRoute());
  app.route("/api", chatRestRoute);
  app.route("", chatWsRoute);
  app.route("/api", createWebSocketAuthRoute({ ticketService: wsTicketService }));
  app.route("/api", createWebAuthRoute({
    lucHome: engine.luccodeHome,
    authService: serverAuthService,
    getConnectionKind: (c: any) => c.get("transportConnectionKind"),
    getRuntimeContext: () => engine.getRuntimeContext(),
  } as any));
  app.route("/api", createAccessRoute({
    engine,
    runtimeState: serverRuntimeState,
  } as any));
  app.route("/api", createSessionsRoute(engine, hub));
  app.route("/api", createSessionCollabRoute(engine));
  app.route("/api", createSessionProjectsRoute(engine));
  app.route("/api", createModelsRoute(engine));
  app.route("/api", createConfigRoute(engine));
  app.route("/api", createMemoryDreamRoute(engine));
  app.route("/api", createUploadRoute(engine));
  app.route("/api", createProvidersRoute(engine));
  app.route("/api", createAgentsRoute(engine));
  app.route("/api", createDevicesRoute(engine));
  app.route("/api", createStudioWorkspacesRoute(engine));
  app.route("/api", createSkillsRoute(engine));
  app.route("/api", createChannelsRoute(engine, hub));
  app.route("/api", createDmRoute(engine, hub));
  app.route("/api", createFsRoute(engine));
  app.route("/api", createPreferencesRoute(engine));
  app.route("/api", createInputDraftsRoute(engine));
  app.route("/api", createSettingsSnapshotRoute(engine, {
    bridgeManagerRef,
    runtimeState: serverRuntimeState,
  }));
  app.route("/api", createExperimentsRoute(engine));
  app.route("/api", createBridgeRoute(engine, bridgeManagerRef));
  app.route("/api", createAuthRoute(engine));
  app.route("/api", createConfirmRoute(confirmStore, engine));
  app.route("/api", createMediaRoute(engine));
  // Must precede the plugin routes: it owns the /api/plugins/mcp alias, which
  // would otherwise be swallowed by the generic plugin proxy.
  app.route("/api", createMcpRoute(engine));
  app.route("/api", createPluginsRoute(engine));
  app.route("/api", createCheckpointsRoute(engine));
  app.route("/api", createCommandsRoute(engine));
  app.route("/api", createResourceIoRoute(engine));
  app.route("/api", createFileHistoryRoute(engine));
  app.route("/api", createResourcesRoute(engine));
  app.route("/api", createUsageRoute(engine));
  app.route("/api", createSpeechRecognitionRoute(engine));
  app.route("/api", createServerIdentityRoute({
    lucHome: engine.luccodeHome,
    appVersion,
    getRuntimeContext: () => engine.getRuntimeContext(),
  } as any));
}
