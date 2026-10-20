const CHAT_SURFACE_TYPE = "chat.surface";
const UNAVAILABLE_SURFACE_TYPE = "chat.surface.unavailable";
const PRIVATE_VISIBILITIES = new Set(["plugin_private", "private"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cardSessionId(card: Record<string, unknown>): string | null {
  const sessionRef = isRecord(card.sessionRef) ? card.sessionRef : null;
  return textOrNull(card.sessionId) || textOrNull(sessionRef?.sessionId);
}

function unavailableCard(card: Record<string, unknown>, reason: string): Record<string, unknown> {
  return {
    ...card,
    type: UNAVAILABLE_SURFACE_TYPE,
    unavailableReason: reason,
    description: textOrNull(card.description)
      || "This plugin chat surface is unavailable because its target session is not a private session owned by the plugin.",
  };
}

function normalizePluginChatSurfaceCard(card: Record<string, unknown>, engine: any): Record<string, unknown> {
  const pluginId = textOrNull(card.pluginId);
  const sessionId = cardSessionId(card);
  if (!pluginId) return unavailableCard(card, "missing_plugin_id");
  if (!sessionId) return unavailableCard(card, "missing_session_id");
  if (typeof engine?.getSessionManifest !== "function") return unavailableCard(card, "session_manifest_unavailable");

  const manifest = engine.getSessionManifest(sessionId);
  const currentPath = textOrNull(manifest?.currentLocator?.path);
  const ownerPluginId = textOrNull(manifest?.plugin?.ownerPluginId);
  const visibility = textOrNull(manifest?.plugin?.visibility) || "public";

  if (!currentPath) return unavailableCard(card, "session_not_found");
  if (ownerPluginId !== pluginId) return unavailableCard(card, "session_owner_mismatch");
  if (!PRIVATE_VISIBILITIES.has(visibility)) return unavailableCard(card, "session_not_private");

  return {
    ...card,
    type: CHAT_SURFACE_TYPE,
    pluginId,
    sessionId,
    sessionPath: currentPath,
    sessionRef: {
      sessionId,
      sessionPath: currentPath,
    },
  };
}

export function normalizePluginChatSurfaceBlocks(blocks: unknown, engine: any): any[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return Array.isArray(blocks) ? blocks : [];
  return blocks.map((block) => {
    if (!isRecord(block) || block.type !== "plugin_card" || !isRecord(block.card)) return block;
    const cardType = textOrNull(block.card.type) || "iframe";
    if (cardType !== CHAT_SURFACE_TYPE) return block;
    return {
      ...block,
      card: normalizePluginChatSurfaceCard(block.card, engine),
    };
  });
}
