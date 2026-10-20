export const STUDIO_OWNER_SCOPE = "studio.owner";

export const MOBILE_REMOTE_ACCESS_SCOPES = Object.freeze([
  "chat",
  "resources.read",
  "files.read",
  "files.write",
] as const);

export const LEGACY_DESKTOP_OWNER_SCOPES = Object.freeze([
  "chat",
  "resources.read",
  "files.read",
  "files.write",
  "settings.read",
  "settings.write",
  "providers.manage",
  "secrets.write",
  "bridge.manage",
] as const);

export const DESKTOP_REMOTE_ACCESS_SCOPES = Object.freeze([
  "chat",
  "resources.read",
  "files.read",
  "files.write",
  STUDIO_OWNER_SCOPE,
  "settings.read",
  "settings.write",
  "providers.manage",
  "secrets.write",
  "bridge.manage",
] as const);

export type AccessScopeProfile = "mobile" | "desktop";

export function scopesForAccessProfile(profile: AccessScopeProfile | string | null | undefined): string[] {
  return profile === "desktop"
    ? [...DESKTOP_REMOTE_ACCESS_SCOPES]
    : [...MOBILE_REMOTE_ACCESS_SCOPES];
}

export function normalizeAccessProfile(value: unknown, fallback: AccessScopeProfile = "mobile"): AccessScopeProfile {
  return value === "desktop" ? "desktop" : fallback;
}

export function scopeSetAllows(scopes: readonly string[] | null | undefined, required: string): boolean {
  if (!required) return true;
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.includes(required)) return true;
  const [namespace] = required.split(".");
  return list.includes(namespace) || list.includes(`${namespace}.*`);
}

export function hasLegacyDesktopOwnerScopes(scopes: readonly string[] | null | undefined): boolean {
  const list = Array.isArray(scopes) ? scopes : [];
  return LEGACY_DESKTOP_OWNER_SCOPES.every((scope) => scopeSetAllows(list, scope));
}

export function hasStudioOwnerScope(scopes: readonly string[] | null | undefined): boolean {
  return scopeSetAllows(scopes, STUDIO_OWNER_SCOPE) || hasLegacyDesktopOwnerScopes(scopes);
}
