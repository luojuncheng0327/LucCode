/**
 * session-key.js — bridge sessionKey 解析工具
 *
 * 从 sessionKey 中提取平台、聊天类型、chatId。
 * 数据驱动：新增平台只需在 SESSION_PREFIX_MAP 注册前缀。
 */

// sessionKey 前缀 → [platform, chatType]
export const SESSION_PREFIX_MAP = [
  ["tg_dm_",       "telegram", "dm"],
  ["tg_group_",    "telegram", "group"],
  ["fs_dm_",       "feishu",   "dm"],
  ["fs_group_",    "feishu",   "group"],
  ["dt_dm_",       "dingtalk", "dm"],
  ["dt_group_",    "dingtalk", "group"],
  ["qq_dm_",       "qq",       "dm"],
  ["qq_group_",    "qq",       "group"],
  ["wx_dm_",       "wechat",   "dm"],
];

/** 已知平台列表（从前缀表去重） */
export const KNOWN_PLATFORMS = [...new Set(SESSION_PREFIX_MAP.map(([, p]) => p))];

/** 从 sessionKey 解析平台 + 类型 + chatId + agentId
 *  新格式: `tg_dm_123@luc` → chatId="123", agentId="luc"
 *  旧格式: `tg_dm_123`      → chatId="123", agentId=null
 */
export function parseSessionKey(sessionKey) {
  for (const [prefix, platform, chatType] of SESSION_PREFIX_MAP) {
    if (sessionKey.startsWith(prefix)) {
      const tail = sessionKey.slice(prefix.length);
      const atIdx = tail.lastIndexOf("@");
      if (atIdx !== -1) {
        return { platform, chatType, chatId: tail.slice(0, atIdx), agentId: tail.slice(atIdx + 1) };
      }
      return { platform, chatType, chatId: tail, agentId: null };
    }
  }
  return { platform: "unknown", chatType: "dm", chatId: sessionKey, agentId: null };
}

const PLACEHOLDER_NAMES = new Set(["user"]);

function cleanDisplayName(name) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value) return null;
  if (PLACEHOLDER_NAMES.has(value.toLowerCase())) return null;
  return value;
}

function shortId(id) {
  const value = String(id || "");
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function addAlias(aliases, value) {
  const alias = typeof value === "string" ? value.trim() : "";
  if (!alias || aliases.includes(alias)) return;
  aliases.push(alias);
}

function qqPrincipalFromEntry(entry, parsed) {
  const principal = entry.qqPrincipal && typeof entry.qqPrincipal === "object"
    ? entry.qqPrincipal
    : {};
  const principalId = cleanString(principal.principalId) || cleanString(entry.principalId) || cleanString(entry.userId);
  if (!principalId) return null;

  const aliases = [];
  addAlias(aliases, principalId);
  if (Array.isArray(principal.aliases)) {
    for (const alias of principal.aliases) addAlias(aliases, alias);
  }
  if (parsed.chatType === "dm") {
    addAlias(aliases, entry.chatId);
    addAlias(aliases, parsed.chatId);
  }

  const displayName = cleanDisplayName(principal.displayName) || cleanDisplayName(entry.displayName) || cleanDisplayName(entry.name);
  const avatarUrl = cleanString(principal.avatarUrl) || cleanString(entry.avatarUrl);
  return {
    principalId,
    aliases,
    displayName,
    avatarUrl,
    fallbackName: `QQ ${shortId(principalId)}`,
  };
}

function cleanString(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s || null;
}

/**
 * 解析 bridge index entry 的平台身份。UI 与 route 只读这个结果，不从 chatId 猜展示名。
 */
export function resolveBridgeSessionIdentity(raw, { sessionKey = null, parsed = null } = {}) {
  const entry: any = typeof raw === "string" ? { file: raw } : raw || {};
  const parsedKey = parsed || (sessionKey ? parseSessionKey(sessionKey) : { platform: "unknown", chatType: "dm", chatId: entry.chatId || null });
  const userId = cleanString(entry.userId) || (parsedKey.platform === "wechat" && parsedKey.chatType === "dm" ? cleanString(parsedKey.chatId) : null);

  if (parsedKey.platform === "qq") {
    const principal = qqPrincipalFromEntry(entry, parsedKey);
    if (principal) {
      return {
        userId: principal.principalId,
        principalId: principal.principalId,
        aliases: principal.aliases,
        displayName: principal.displayName || cleanDisplayName(entry.displayName) || cleanDisplayName(entry.name) || principal.fallbackName,
        avatarUrl: principal.avatarUrl || null,
      };
    }
  }

  const displayName = cleanDisplayName(entry.displayName) || cleanDisplayName(entry.name);
  return {
    userId,
    principalId: cleanString(entry.principalId) || userId,
    aliases: [],
    displayName,
    avatarUrl: cleanString(entry.avatarUrl),
  };
}

/**
 * 从 bridge index 中按 userId 去重收集已知用户
 * @param {object} index - bridge-index.json 的内容
 * @returns {Record<string, Array<{userId: string, name: string|null}>>}
 */
export function collectKnownUsers(index) {
  const byPlatform: Record<string, any> = {};

  for (const [sessionKey, raw] of Object.entries(index)) {
    const entry: any = typeof raw === "string" ? { file: raw } : raw;
    const parsed = parseSessionKey(sessionKey);
    const { platform } = parsed;
    if (platform === "unknown") continue;

    if (platform === "qq") {
      const principal = qqPrincipalFromEntry(entry, parsed);
      if (!principal) continue;
      if (!byPlatform[platform]) byPlatform[platform] = new Map();
      const map = byPlatform[platform];
      const existing = map.get(principal.principalId);
      if (existing) {
        for (const alias of principal.aliases) addAlias(existing.aliases, alias);
        if (!existing.name && principal.displayName) {
          existing.name = principal.displayName;
          existing.displayName = principal.displayName;
        }
        if (!existing.avatarUrl && principal.avatarUrl) existing.avatarUrl = principal.avatarUrl;
        continue;
      }
      const user: any = {
        userId: principal.principalId,
        principalId: principal.principalId,
        aliases: principal.aliases,
        name: principal.displayName,
        displayName: principal.displayName,
        fallbackName: principal.fallbackName,
      };
      if (principal.avatarUrl) user.avatarUrl = principal.avatarUrl;
      map.set(principal.principalId, user);
      continue;
    }

    const identity = resolveBridgeSessionIdentity(entry, { sessionKey, parsed });
    if (!identity.userId) continue;
    if (!byPlatform[platform]) byPlatform[platform] = new Map();
    const map = byPlatform[platform];
    const existing = map.get(identity.userId);
    if (!existing || (!existing.name && identity.displayName)) {
      const user: any = {
        userId: identity.userId,
        name: identity.displayName || null,
      };
      if (identity.avatarUrl || existing?.avatarUrl) user.avatarUrl = identity.avatarUrl || existing.avatarUrl;
      map.set(identity.userId, user);
    } else if (existing && !existing.avatarUrl && identity.avatarUrl) {
      existing.avatarUrl = identity.avatarUrl;
    }
  }

  const result: Record<string, any> = {};
  for (const [platform, map] of Object.entries(byPlatform)) {
    result[platform] = [...map.values()];
  }
  return result;
}
