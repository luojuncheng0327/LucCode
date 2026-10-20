import { principalHasScope as principalHasNormalizedScope } from "../../core/security-principal.ts";
import { isLocalOwnerPrincipal, scopeAllows } from "./route-security.ts";

export function principalHasScope(principal, scope) {
  if (isLocalOwnerPrincipal(principal)) return true;
  if (!principal || typeof principal !== "object") return false;
  if (principal.principalId) return principalHasNormalizedScope(principal, scope);
  const scopes = Array.isArray(principal.scopes) ? principal.scopes : [];
  return scopeAllows(scopes, scope);
}

export function readAuthPrincipal(c) {
  if (typeof c?.get !== "function") return null;
  try {
    return c.get("authPrincipal") || null;
  } catch {
    return null;
  }
}

export function denySecretMutationWithoutScope(c, secretFields, {
  scope = "secrets.write",
} = {}) {
  const fields = Array.isArray(secretFields) ? secretFields.filter(Boolean) : [];
  if (fields.length === 0) return null;

  const principal = readAuthPrincipal(c);
  if (!principal) return null;
  if (principalHasScope(principal, scope)) return null;

  return c.json({
    error: "secret_write_scope_required",
    scope,
    fields,
  }, 403);
}

export function denyWithoutScope(c, scope, {
  error = "insufficient_scope",
} = {}) {
  const principal = readAuthPrincipal(c);
  if (!principal) return null;
  if (principalHasScope(principal, scope)) return null;
  return c.json({ error, scope }, 403);
}
