const RESOURCE_EVENT_TYPES = new Set([
  "resource.changed",
  "resource.deleted",
  "resource.renamed",
]);

export function toResourceEventWsMessage(event, sessionPath = null) {
  if (!event || typeof event !== "object") return null;
  if (!RESOURCE_EVENT_TYPES.has(event.type)) return null;
  if (event.sessionPath || !sessionPath) return event;
  return { ...event, sessionPath };
}
