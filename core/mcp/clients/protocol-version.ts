import { MCP_PROTOCOL_VERSION } from "./stdio-client.ts";

export const MCP_PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";

// The first revision that carries protocol version, client identity and client
// capabilities as per-request metadata instead of establishing a session with an
// initialize handshake. The spec calls these two worlds "modern" and "legacy";
// we use the same words so the code reads like the document it implements.
export const MCP_PROTOCOL_VERSION_2026_07_28 = "2026-07-28";

export const MCP_ERA_MODERN = "modern";
export const MCP_ERA_LEGACY = "legacy";

// Reserved _meta keys carrying the per-request protocol fields.
export const MCP_META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const MCP_META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

// Modern revisions are dated on or after 2026-07-28. Protocol versions are
// YYYY-MM-DD strings, so lexicographic order is chronological order.
export function isModernMcpProtocolVersion(version) {
  const value = stringOrEmpty(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return value >= MCP_PROTOCOL_VERSION_2026_07_28;
}

export function mcpEraForProtocolVersion(version) {
  return isModernMcpProtocolVersion(version) ? MCP_ERA_MODERN : MCP_ERA_LEGACY;
}

// Strictly read supportedVersions out of a server/discover result. Anything that
// is not a non-empty array of non-empty strings returns null, which the caller
// treats as "unproven" and answers with the legacy handshake. Deliberately
// unforgiving: a half-understood probe must never be read as a modern server.
export function readDiscoverSupportedVersions(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const versions = (result as any).supportedVersions;
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const normalized = [];
  for (const entry of versions) {
    const value = stringOrEmpty(entry);
    if (!value) return null;
    normalized.push(value);
  }
  return normalized;
}

// Which version we will speak given what the server advertises. We only claim a
// revision we actually implement, so this is an exact-match check rather than a
// "pick the newest" heuristic: a server offering only some future revision gets
// the legacy handshake and an honest error, not a version we cannot speak.
export function negotiateMcpProtocolVersion(supportedVersions, { preferred = MCP_PROTOCOL_VERSION_2026_07_28 } = {}) {
  const versions = readDiscoverSupportedVersions({ supportedVersions });
  if (!versions) return "";
  return versions.includes(preferred) ? preferred : "";
}

export function resolveInitialMcpProtocolVersion({ headers = {}, protocolVersion = "" } = {}) {
  const explicit = stringOrEmpty(protocolVersion);
  if (explicit) return explicit;
  return headerValue(headers, MCP_PROTOCOL_VERSION_HEADER) || MCP_PROTOCOL_VERSION;
}

// A version the operator pinned by hand, as connector config or as a literal
// protocol-version header. Pinned means "do not probe".
export function resolvePinnedMcpProtocolVersion({ headers = {}, protocolVersion = "" } = {}) {
  return stringOrEmpty(protocolVersion) || headerValue(headers, MCP_PROTOCOL_VERSION_HEADER);
}

export function headersWithoutMcpProtocolVersion( headers: any = {}) {
  const result: any = {};
  const protocolHeader = MCP_PROTOCOL_VERSION_HEADER.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (typeof key !== "string" || key.toLowerCase() === protocolHeader) continue;
    result[key] = value;
  }
  return result;
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  const found = Object.entries(headers || {}).find(([key, value]) => (
    typeof key === "string" &&
    key.toLowerCase() === lower &&
    typeof value === "string" &&
    value.trim()
  ));
  return (found?.[1] as string)?.trim() || "";
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}
