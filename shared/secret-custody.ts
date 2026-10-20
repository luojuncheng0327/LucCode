export const MASKED_SECRET = "********";

type SecretKeyInput = Set<string> | string[] | undefined;
type SecretRecord = Record<string, unknown>;

// This is intentionally an exact-key registry. Do not replace it with suffix or
// substring matching: callers may store non-secret metadata beside credentials.
const DEFAULT_SECRET_KEYS = new Set<string>([
  "api_key",
  "apiKey",
  "token",
  "botToken",
  "webhookToken",
  "robotToken",
  "appSecret",
  "clientSecret",
  "corpSecret",
  "webhookSecret",
  "oauthClientSecret",
  "suiteSecret",
  "secret",
  "password",
  "accessToken",
  "refreshToken",
]);

export function isMaskedSecretValue(value: unknown): value is typeof MASKED_SECRET {
  return typeof value === "string" && value.trim() === MASKED_SECRET;
}

export function hasSecretValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function maskSecretValue(value: unknown): string {
  return hasSecretValue(value) ? MASKED_SECRET : "";
}

export function maskObjectSecrets(value: unknown, secretKeys: SecretKeyInput = DEFAULT_SECRET_KEYS): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => maskObjectSecrets(item, secretKeys));
  const keySet = normalizeSecretKeySet(secretKeys);
  const out: SecretRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (keySet.has(key)) {
      out[key] = maskSecretValue(entry);
    } else if (entry && typeof entry === "object") {
      out[key] = maskObjectSecrets(entry, keySet);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

export function resolveSecretPatch({
  patch,
  existing = {},
  secretKeys = DEFAULT_SECRET_KEYS,
}: {
  patch?: unknown;
  existing?: SecretRecord;
  secretKeys?: SecretKeyInput;
}): SecretRecord {
  const source = patch && typeof patch === "object" ? patch : {};
  const saved = existing && typeof existing === "object" ? existing : {};
  const keySet = normalizeSecretKeySet(secretKeys);
  const out: SecretRecord = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = keySet.has(key) && isMaskedSecretValue(value)
      ? saved[key] || ""
      : value;
  }
  return out;
}

export function collectSecretPatchPaths(value: unknown, secretKeys: SecretKeyInput = DEFAULT_SECRET_KEYS): string[] {
  const keySet = normalizeSecretKeySet(secretKeys);
  const paths: string[] = [];
  collectSecretPatchPathsInto(value, keySet, "", paths);
  return paths;
}

export function hasSecretPatch(value: unknown, secretKeys: SecretKeyInput = DEFAULT_SECRET_KEYS): boolean {
  return collectSecretPatchPaths(value, secretKeys).length > 0;
}

function normalizeSecretKeySet(secretKeys: SecretKeyInput): Set<string> {
  if (secretKeys instanceof Set) return secretKeys;
  if (Array.isArray(secretKeys)) return new Set(secretKeys);
  return DEFAULT_SECRET_KEYS;
}

function collectSecretPatchPathsInto(
  value: unknown,
  secretKeys: Set<string>,
  prefix: string,
  paths: string[],
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectSecretPatchPathsInto(entry, secretKeys, prefix ? `${prefix}.${index}` : String(index), paths);
    });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (secretKeys.has(key)) {
      if (!isMaskedSecretValue(entry)) paths.push(path);
      continue;
    }
    collectSecretPatchPathsInto(entry, secretKeys, path, paths);
  }
}
