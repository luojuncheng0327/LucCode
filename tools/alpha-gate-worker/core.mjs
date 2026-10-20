/* global crypto, TextEncoder, Response, URL */

/**
 * Alpha invite gate: all of the redemption logic, with no runtime coupling to
 * the desktop app and no Cloudflare-specific imports.
 *
 * Everything the module touches from the outside world arrives through the
 * `deps` argument of `handleRequest`, so the same code runs on Workers and
 * inside a plain Node test with a Map-backed store:
 *
 *   deps.kv          KV namespace (get / put / delete / list)
 *   deps.env         configuration bag (see `readConfig`)
 *   deps.now         () => epoch milliseconds
 *   deps.randomBytes (length) => Uint8Array
 *
 * The invite code itself is the only credential; there is no account, no
 * session and no cookie. Failures are answered honestly, except on /redeem,
 * where every rejection collapses into one shape so a caller cannot mine the
 * endpoint for "this code exists but is taken" style information.
 */

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 glyphs, no 0/O/1/I
const CODE_PREFIX = "LUC";
const CODE_GROUPS = 3;
const CODE_GROUP_LENGTH = 4;
const CODE_PATTERN = new RegExp(
  `^${CODE_PREFIX}(?:-[${CODE_ALPHABET}]{${CODE_GROUP_LENGTH}}){${CODE_GROUPS}}$`,
);
const DEVICE_ID_HASH_PATTERN = /^[0-9a-f]{64}$/;

const CODE_KEY_PREFIX = "code:";
const TOTAL_KEY = "meta:total";
const RATE_LIMIT_KEY_PREFIX = "rl:";
const RATE_LIMIT_WINDOW_SECONDS = 3600;

// One wording for "not a code", "already spent", "revoked" and "bound to a
// different machine". Splitting these apart would turn the endpoint into a
// code oracle.
const INVALID_CODE_MESSAGE = "this invite code is invalid or already used up";

const MINT_BATCH_LIMIT = 500;
const CODE_COLLISION_RETRIES = 5;

class ConfigError extends Error {}

// ── configuration ──

function readIntSetting(env, key, fallback, minimum = 0) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < minimum) {
    throw new ConfigError(`${key} must be an integer no smaller than ${minimum}`);
  }
  return value;
}

export function readConfig(env = {}) {
  return {
    fissionCount: readIntSetting(env, "FISSION_COUNT", 2),
    maxGeneration: readIntSetting(env, "MAX_GENERATION", 5),
    globalCap: readIntSetting(env, "GLOBAL_CAP", 10000),
    rateLimitPerHour: readIntSetting(env, "RATE_LIMIT_PER_HOUR", 30),
    feedUrl: String(env?.FEED_URL || "").trim(),
    adminToken: String(env?.ADMIN_TOKEN || ""),
  };
}

// ── small helpers ──

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function failure(status, message, headers = {}) {
  return jsonResponse(status, { ok: false, error: message }, headers);
}

function invalidCodeResponse() {
  return failure(404, INVALID_CODE_MESSAGE);
}

function unauthorizedResponse() {
  return failure(401, "unauthorized");
}

function methodNotAllowed(allowed) {
  return failure(405, `this endpoint only accepts ${allowed}`, { allow: allowed });
}

function codeKey(code) {
  return `${CODE_KEY_PREFIX}${code}`;
}

export function normalizeCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function defaultRandomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * 32 glyphs divide 256 evenly, so the modulo carries no bias.
 */
export function generateCode(randomBytes = defaultRandomBytes) {
  const length = CODE_GROUPS * CODE_GROUP_LENGTH;
  const bytes = randomBytes(length);
  const groups = [];
  for (let group = 0; group < CODE_GROUPS; group += 1) {
    let text = "";
    for (let index = 0; index < CODE_GROUP_LENGTH; index += 1) {
      text += CODE_ALPHABET[bytes[group * CODE_GROUP_LENGTH + index] % CODE_ALPHABET.length];
    }
    groups.push(text);
  }
  return [CODE_PREFIX, ...groups].join("-");
}

async function kvGetJson(kv, key) {
  const raw = await kv.get(key);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`the stored record at ${key} is not valid JSON`);
  }
}

async function kvPutJson(kv, key, value, options) {
  await kv.put(key, JSON.stringify(value), options);
}

async function readTotal(kv) {
  const raw = await kv.get(TOTAL_KEY);
  if (raw === null || raw === undefined) return 0;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("the minted-code counter is corrupted; refusing to mint against an unknown total");
  }
  return value;
}

async function writeTotal(kv, value) {
  await kv.put(TOTAL_KEY, String(value));
}

async function readJsonObject(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, error: "the request body could not be read" };
  }
  if (!text || !text.trim()) {
    return { ok: false, error: "the request body must be a JSON object" };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "the request body must be valid JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "the request body must be a JSON object" };
  }
  return { ok: true, value };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

// ── minting ──

async function mintCodes(ctx, { count, generation, parent }) {
  const { kv, randomBytes } = ctx;
  const minted = [];
  for (let index = 0; index < count; index += 1) {
    let code = null;
    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt += 1) {
      const candidate = generateCode(randomBytes);
      const existing = await kv.get(codeKey(candidate));
      if (existing === null || existing === undefined) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error("could not draw an unused invite code");
    await kvPutJson(kv, codeKey(code), {
      status: "unused",
      parent: parent ?? null,
      generation,
      children: [],
    });
    minted.push(code);
  }
  if (minted.length > 0) {
    await writeTotal(kv, (await readTotal(kv)) + minted.length);
  }
  return minted;
}

/**
 * How many children this redemption may mint: the configured fission width,
 * clipped to zero past the generation ceiling, then clipped again to whatever
 * the global cap still allows. Running out of room is not an error — the
 * redemption succeeds and the response reports the children it really got.
 */
async function mintChildren(ctx, parentCode, parentRecord) {
  const { config, kv } = ctx;
  const generation = Number.isInteger(parentRecord.generation) ? parentRecord.generation + 1 : 1;
  let allowed = generation > config.maxGeneration ? 0 : config.fissionCount;
  if (allowed > 0) {
    const remaining = config.globalCap - (await readTotal(kv));
    allowed = Math.max(0, Math.min(allowed, remaining));
  }
  if (allowed === 0) return [];
  return mintCodes(ctx, { count: allowed, generation, parent: parentCode });
}

// ── rate limiting ──

/**
 * Fixed window per client IP. The reset instant lives inside the record, so a
 * burst of requests cannot slide the window forward, and the KV TTL only has
 * to outlive that instant.
 */
async function enforceRateLimit(ctx) {
  const { kv, config, request, now } = ctx;
  if (config.rateLimitPerHour <= 0) return null;

  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const key = `${RATE_LIMIT_KEY_PREFIX}${ip.split(",")[0].trim()}`;
  const nowMs = now();

  let count = 0;
  let resetAt = nowMs + RATE_LIMIT_WINDOW_SECONDS * 1000;
  const record = await kvGetJson(kv, key);
  if (record && Number.isFinite(record.resetAt) && record.resetAt > nowMs && Number.isFinite(record.count)) {
    count = record.count;
    resetAt = record.resetAt;
  }

  if (count >= config.rateLimitPerHour) {
    const retryAfter = Math.max(1, Math.ceil((resetAt - nowMs) / 1000));
    return failure(429, "too many redemption attempts from this address; try again later", {
      "retry-after": String(retryAfter),
    });
  }

  await kvPutJson(kv, key, { count: count + 1, resetAt }, {
    expirationTtl: Math.max(60, Math.ceil((resetAt - nowMs) / 1000)),
  });
  return null;
}

// ── /redeem ──

async function handleRedeem(ctx) {
  const { kv, config, now } = ctx;

  const throttled = await enforceRateLimit(ctx);
  if (throttled) return throttled;

  const parsed = await readJsonObject(ctx.request);
  if (!parsed.ok) return failure(400, parsed.error);

  const code = normalizeCode(parsed.value.code);
  const deviceIdHash =
    typeof parsed.value.deviceIdHash === "string" ? parsed.value.deviceIdHash.trim().toLowerCase() : "";
  if (!code || !deviceIdHash) {
    return failure(400, "the request must carry both a code and a deviceIdHash");
  }
  if (!DEVICE_ID_HASH_PATTERN.test(deviceIdHash)) {
    return failure(400, "deviceIdHash must be a sha-256 digest in lower-case hexadecimal");
  }
  // Refuse before touching any record: handing out a redemption without an
  // address to hand back would burn the code for nothing.
  if (!config.feedUrl) {
    return failure(500, "the redemption service has no update feed address configured");
  }
  if (!CODE_PATTERN.test(code)) return invalidCodeResponse();

  const record = await kvGetJson(kv, codeKey(code));
  if (!record || record.status === "revoked") return invalidCodeResponse();

  if (record.status === "redeemed") {
    if (typeof record.deviceIdHash === "string" && constantTimeEqual(record.deviceIdHash, deviceIdHash)) {
      return jsonResponse(200, {
        ok: true,
        feedUrl: config.feedUrl,
        childCodes: Array.isArray(record.children) ? [...record.children] : [],
      });
    }
    return invalidCodeResponse();
  }

  if (record.status !== "unused") return invalidCodeResponse();

  const childCodes = await mintChildren(ctx, code, record);
  await kvPutJson(kv, codeKey(code), {
    ...record,
    status: "redeemed",
    deviceIdHash,
    redeemedAt: new Date(now()).toISOString(),
    children: childCodes,
  });

  return jsonResponse(200, { ok: true, feedUrl: config.feedUrl, childCodes });
}

// ── admin ──

async function requireAdmin(ctx) {
  const token = ctx.config.adminToken;
  const header = ctx.request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.*)$/i.exec(header.trim());
  const presented = match ? match[1].trim() : "";
  if (!token || !presented) return unauthorizedResponse();
  // Compare fixed-length digests so neither the value nor its length leaks
  // through the comparison.
  const [expected, actual] = await Promise.all([sha256Hex(token), sha256Hex(presented)]);
  return constantTimeEqual(expected, actual) ? null : unauthorizedResponse();
}

async function handleAdminMint(ctx) {
  const parsed = await readJsonObject(ctx.request);
  if (!parsed.ok) return failure(400, parsed.error);

  const count = parsed.value.count;
  if (!Number.isInteger(count) || count < 1 || count > MINT_BATCH_LIMIT) {
    return failure(400, `count must be an integer between 1 and ${MINT_BATCH_LIMIT}`);
  }
  const generation = parsed.value.generation === undefined ? 0 : parsed.value.generation;
  if (!Number.isInteger(generation) || generation < 0 || generation > ctx.config.maxGeneration) {
    return failure(400, `generation must be an integer between 0 and ${ctx.config.maxGeneration}`);
  }

  const total = await readTotal(ctx.kv);
  const remaining = ctx.config.globalCap - total;
  if (count > remaining) {
    return failure(409, `the global cap allows only ${Math.max(0, remaining)} more codes`);
  }

  const codes = await mintCodes(ctx, { count, generation, parent: null });
  return jsonResponse(200, { ok: true, codes, generation, total: total + codes.length });
}

async function handleAdminRevoke(ctx) {
  const parsed = await readJsonObject(ctx.request);
  if (!parsed.ok) return failure(400, parsed.error);

  const code = normalizeCode(parsed.value.code);
  if (!code) return failure(400, "the request must carry a code");
  if (parsed.value.cascade !== undefined && typeof parsed.value.cascade !== "boolean") {
    return failure(400, "cascade must be a boolean");
  }
  const cascade = parsed.value.cascade === undefined ? true : parsed.value.cascade;

  const root = await kvGetJson(ctx.kv, codeKey(code));
  if (!root) return failure(404, "unknown code");

  const revokedAt = new Date(ctx.now()).toISOString();
  const visited = new Set();
  const revoked = [];
  const queue = [code];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const record = current === code ? root : await kvGetJson(ctx.kv, codeKey(current));
    if (!record) continue;
    if (record.status !== "revoked") {
      await kvPutJson(ctx.kv, codeKey(current), { ...record, status: "revoked", revokedAt });
    }
    revoked.push(current);
    if (cascade && Array.isArray(record.children)) {
      for (const child of record.children) queue.push(normalizeCode(child));
    }
  }

  return jsonResponse(200, { ok: true, revoked, cascade });
}

async function handleAdminTree(ctx) {
  const codes = {};
  let cursor;
  do {
    const page = await ctx.kv.list({ prefix: CODE_KEY_PREFIX, cursor });
    for (const key of page.keys || []) {
      codes[key.name.slice(CODE_KEY_PREFIX.length)] = await kvGetJson(ctx.kv, key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const names = Object.keys(codes).sort();
  const roots = names.filter((name) => !codes[name] || !codes[name].parent);
  return jsonResponse(200, {
    ok: true,
    total: await readTotal(ctx.kv),
    count: names.length,
    roots,
    codes,
  });
}

// ── entry point ──

export async function handleRequest(request, deps = {}) {
  const kv = deps.kv;
  if (!kv) return failure(500, "the invite store binding is missing");

  let config;
  try {
    config = readConfig(deps.env || {});
  } catch (error) {
    if (error instanceof ConfigError) return failure(500, error.message);
    throw error;
  }

  const ctx = {
    kv,
    config,
    request,
    now: typeof deps.now === "function" ? deps.now : () => Date.now(),
    randomBytes: typeof deps.randomBytes === "function" ? deps.randomBytes : defaultRandomBytes,
  };

  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  try {
    if (path === "/redeem") {
      return method === "POST" ? await handleRedeem(ctx) : methodNotAllowed("POST");
    }
    if (path === "/admin/mint") {
      if (method !== "POST") return methodNotAllowed("POST");
      return (await requireAdmin(ctx)) || (await handleAdminMint(ctx));
    }
    if (path === "/admin/revoke") {
      if (method !== "POST") return methodNotAllowed("POST");
      return (await requireAdmin(ctx)) || (await handleAdminRevoke(ctx));
    }
    if (path === "/admin/tree") {
      if (method !== "GET") return methodNotAllowed("GET");
      return (await requireAdmin(ctx)) || (await handleAdminTree(ctx));
    }
    return failure(404, "unknown endpoint");
  } catch (error) {
    return failure(500, error?.message || String(error));
  }
}

export const __internals = {
  CODE_ALPHABET,
  CODE_PATTERN,
  INVALID_CODE_MESSAGE,
  RATE_LIMIT_WINDOW_SECONDS,
  TOTAL_KEY,
};
