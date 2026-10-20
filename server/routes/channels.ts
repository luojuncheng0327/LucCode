/**
 * channels.js — 频道 REST API
 *
 * Channel ID 化：文件名为 ch_{id}.md，frontmatter 含 id/name/description/members。
 *
 * 端点：
 * GET    /channels              — 列出所有频道 + 用户 bookmark + 未读数
 * POST   /channels              — 创建新频道
 * GET    /channels/:id          — 获取频道消息 + 成员列表
 * POST   /channels/:id/members  — 添加频道成员
 * DELETE /channels/:id/members/:agentId — 移除频道成员
 * POST   /channels/:id/messages — 用户发送群聊消息
 * POST   /channels/:id/read     — 更新用户已读 bookmark
 * DELETE /channels/:id          — 删除频道
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { debugLog } from "../../lib/debug-log.ts";
import {
  parseChannel,
  appendMessage,
  readBookmarks,
  updateBookmark,
  addBookmarkEntry,
  removeBookmarkEntry,
  getChannelMembers,
  getChannelMeta,
  assertValidChannelMembers,
  addChannelMember,
  removeChannelMember,
  updateChannelMeta,
} from "../../lib/channels/channel-store.ts";
import { extractMentionedAgentIds } from "../../lib/channels/channel-mentions.ts";
import { buildConversationMarkdownExport } from "../../lib/channels/conversation-export.ts";
import { normalizeAgentPhoneToolMode } from "../../lib/conversations/agent-phone-session.ts";
import {
  DEFAULT_AGENT_PHONE_SETTINGS,
  defaultAgentPhoneGuardLimit,
  normalizeAgentPhoneModelOverride,
  positiveIntegerOrDefault,
  readBoolean,
  resolveAgentPhoneGuardLimit,
} from "../../lib/conversations/agent-phone-prompt.ts";
import {
  getAgentPhoneProjectionPath,
  readAgentPhoneProjection,
  updateAgentPhoneProjectionMeta,
} from "../../lib/conversations/agent-phone-projection.ts";
import { resolveAgentStrict } from "../utils/resolve-agent.ts";
import { findModel } from "../../shared/model-ref.ts";
import { createModuleLogger } from "../../lib/debug-log.ts";

const log = createModuleLogger("channel");

function normalizeOptionalPositiveInt(value: any, fieldName: any) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return Math.floor(num);
}

function readOptionalPositiveInt(value: any) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function requestedAgentId(c: any) {
  const value = c.req.query("agentId");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveConversationOwnerAgent(engine: any, c: any) {
  if (requestedAgentId(c)) {
    return resolveAgentStrict(engine, c);
  }

  // Without an explicit agentId the conversation belongs to the primary agent.
  // If there is no primary agent there is no owner to speak of, and picking
  // whichever agent the server happens to be focused on would hand the caller
  // a different agent's DM. Say so instead.
  const primaryAgentId = engine.getPrimaryAgentId?.() || null;
  if (!primaryAgentId) {
    throw new Error("no primary agent configured");
  }

  const agent = engine.getAgent(primaryAgentId);
  if (!agent) {
    throw new Error(`primary agent "${primaryAgentId}" not found`);
  }
  return agent;
}

function normalizePhoneSettingsPayload(body: any = {}) {
  const replyMinChars = normalizeOptionalPositiveInt(body.replyMinChars, "replyMinChars");
  const replyMaxChars = normalizeOptionalPositiveInt(body.replyMaxChars, "replyMaxChars");
  if (replyMinChars && replyMaxChars && replyMinChars > replyMaxChars) {
    throw new Error("replyMinChars must be <= replyMaxChars");
  }
  const reminderIntervalMinutes = normalizeOptionalPositiveInt(
    body.reminderIntervalMinutes ?? DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes,
    "reminderIntervalMinutes",
  ) || DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes;
  const guardLimit = normalizeOptionalPositiveInt(body.guardLimit, "guardLimit");
  const proactiveEnabled = body.proactiveEnabled === undefined
    ? DEFAULT_AGENT_PHONE_SETTINGS.proactiveEnabled
    : readBoolean(body.proactiveEnabled);
  const override = normalizeAgentPhoneModelOverride({
    enabled: body.modelOverrideEnabled,
    id: body.modelOverrideModel?.id ?? body.modelOverrideId,
    provider: body.modelOverrideModel?.provider ?? body.modelOverrideProvider,
  });
  return {
    mode: normalizeAgentPhoneToolMode(body.mode),
    replyMinChars,
    replyMaxChars,
    proactiveEnabled,
    reminderIntervalMinutes,
    guardLimit,
    modelOverrideEnabled: override.enabled,
    modelOverrideModel: override.model,
  };
}

function readChannelPhoneSettingsFromMeta(meta: any) {
  const memberCount = Array.isArray(meta.members) ? meta.members.length : 3;
  const override = normalizeAgentPhoneModelOverride({
    enabled: meta.agentPhoneModelOverrideEnabled,
    id: meta.agentPhoneModelOverrideId,
    provider: meta.agentPhoneModelOverrideProvider,
  });
  return {
    mode: normalizeAgentPhoneToolMode(meta.agentPhoneToolMode),
    replyMinChars: readOptionalPositiveInt(meta.agentPhoneReplyMinChars),
    replyMaxChars: readOptionalPositiveInt(meta.agentPhoneReplyMaxChars),
    proactiveEnabled: meta.agentPhoneProactiveEnabled === undefined
      ? DEFAULT_AGENT_PHONE_SETTINGS.proactiveEnabled
      : readBoolean(meta.agentPhoneProactiveEnabled),
    reminderIntervalMinutes: positiveIntegerOrDefault(
      meta.agentPhoneReminderIntervalMinutes,
      DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes,
    ),
    guardLimit: resolveAgentPhoneGuardLimit(meta.agentPhoneGuardLimit, memberCount),
    modelOverrideEnabled: override.enabled,
    modelOverrideModel: override.model,
  };
}

function readDmPhoneSettingsFromMeta(meta: any) {
  const override = normalizeAgentPhoneModelOverride({
    enabled: meta.modelOverrideEnabled,
    id: meta.modelOverrideId,
    provider: meta.modelOverrideProvider,
  });
  return {
    mode: normalizeAgentPhoneToolMode(meta.toolMode),
    replyMinChars: readOptionalPositiveInt(meta.replyMinChars),
    replyMaxChars: readOptionalPositiveInt(meta.replyMaxChars),
    proactiveEnabled: meta.proactiveEnabled === undefined
      ? DEFAULT_AGENT_PHONE_SETTINGS.proactiveEnabled
      : readBoolean(meta.proactiveEnabled),
    reminderIntervalMinutes: positiveIntegerOrDefault(
      meta.reminderIntervalMinutes,
      DEFAULT_AGENT_PHONE_SETTINGS.reminderIntervalMinutes,
    ),
    guardLimit: resolveAgentPhoneGuardLimit(meta.guardLimit, 2),
    modelOverrideEnabled: override.enabled,
    modelOverrideModel: override.model,
  };
}

function assertAvailableModelOverride(engine: any, settings: any) {
  if (!settings.modelOverrideEnabled || !settings.modelOverrideModel) return;
  const { id, provider } = settings.modelOverrideModel;
  try {
    const found = findModel(engine.availableModels || [], id, provider);
    if (found) return;
  } catch {
    // Fall through to the explicit 400 below.
  }
  const err: any = new Error(`Model override not available: ${provider}/${id}`);
  err.status = 400;
  throw err;
}

export function createChannelsRoute(engine: any, hub: any) {
  const route = new Hono();

  function isPhoneEnabled() {
    return engine.isChannelsEnabled?.() !== false;
  }

  function phoneDisabledResponse(c) {
    return c.json({ error: "Agent phone is disabled" }, 503);
  }

  function requirePhoneEnabled(c) {
    return isPhoneEnabled() ? null : phoneDisabledResponse(c);
  }

  /** 用户 bookmark 文件路径 */
  function userBookmarkPath() {
    return path.join(engine.userDir, "channel-bookmarks.md");
  }

  /** 安全路径校验：id 不能穿越出 channelsDir */
  function safeChannelPath(id) {
    const filePath = path.join(engine.channelsDir, `${id}.md`);
    const resolved = path.resolve(filePath);
    const base = path.resolve(engine.channelsDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return null;
    }
    return resolved;
  }

  function safeAgentDir(agentId) {
    if (!agentId || /[/\\]|\.\./.test(agentId)) return null;
    const resolved = path.resolve(path.join(engine.agentsDir, agentId));
    const base = path.resolve(engine.agentsDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
    if (engine.getAgent?.(agentId)) return resolved;
    if (fs.existsSync(resolved)) return resolved;
    return null;
  }

  route.get("/conversations/:id/export", async (c) => {
    try {
      const id = c.req.param("id");
      let archive;
      if (id.startsWith("dm:")) {
        const peerId = id.slice(3);
        if (!peerId || /[/\\]|\.\./.test(peerId)) {
          return c.json({ error: "Invalid DM peer id" }, 400);
        }
        const owner = resolveConversationOwnerAgent(engine, c);
        const filePath = path.join(owner.agentDir, "dm", `${peerId}.md`);
        if (!fs.existsSync(filePath)) return c.json({ error: "DM not found" }, 404);
        const peer = engine.getAgent?.(peerId);
        archive = await buildConversationMarkdownExport({
          filePath,
          type: "dm",
          conversationId: id,
          displayName: peer?.agentName || peer?.name || peerId,
          ownerAgentId: owner.id,
          peerAgentId: peerId,
        });
      } else {
        const filePath = safeChannelPath(id);
        if (!filePath) return c.json({ error: "Invalid channel id" }, 400);
        if (!fs.existsSync(filePath)) return c.json({ error: "Channel not found" }, 404);
        const meta: any = getChannelMeta(filePath);
        archive = await buildConversationMarkdownExport({
          filePath,
          type: "channel",
          conversationId: id,
          displayName: meta.name || id,
        });
      }
      c.header("Content-Type", archive.mediaType);
      c.header("Content-Disposition", `attachment; filename="${archive.filename}"; filename*=UTF-8''${encodeURIComponent(archive.filename)}`);
      c.header("Cache-Control", "private, no-store");
      return c.body(archive.markdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  });

  route.get("/conversations/:id/agent-activities", async (c) => {
    const disabled = requirePhoneEnabled(c);
    if (disabled) return disabled;
    const id = c.req.param("id");
    return c.json({
      activities: hub?.agentPhoneActivities?.snapshot?.(id) || [],
      ticker: hub?.channelRouter?.tickerSnapshot?.(id) || hub?.tickerSnapshot?.(id) || null,
    });
  });

  async function readConversationPhoneSettings(id: any, c: any) {
    if (id.startsWith("dm:")) {
      const agent = resolveConversationOwnerAgent(engine, c);
      const projection = readAgentPhoneProjection(getAgentPhoneProjectionPath(agent.agentDir, id));
      return readDmPhoneSettingsFromMeta(projection.meta || {});
    }
    const filePath = safeChannelPath(id);
    if (!filePath) {
      const err: any = new Error("Invalid conversation id");
      err.status = 400;
      throw err;
    }
    if (!fs.existsSync(filePath)) {
      const err: any = new Error("Channel not found");
      err.status = 404;
      throw err;
    }
    return readChannelPhoneSettingsFromMeta(getChannelMeta(filePath));
  }

  async function writeConversationPhoneSettings(id: any, settings: any, c: any) {
    if (id.startsWith("dm:")) {
      const peerId = id.slice(3);
      if (!peerId || /[/\\]|\.\./.test(peerId)) {
        const err: any = new Error("Invalid DM peer id");
        err.status = 400;
        throw err;
      }
      const agent = resolveConversationOwnerAgent(engine, c);
      assertAvailableModelOverride(engine, settings);
      const guardLimit = settings.guardLimit || defaultAgentPhoneGuardLimit(2);
      await updateAgentPhoneProjectionMeta({
        agentDir: agent.agentDir,
        agentId: agent.id,
        conversationId: id,
        conversationType: "dm",
        patch: {
          toolMode: settings.mode,
          replyMinChars: settings.replyMinChars || "",
          replyMaxChars: settings.replyMaxChars || "",
          proactiveEnabled: settings.proactiveEnabled ? "true" : "false",
          reminderIntervalMinutes: settings.reminderIntervalMinutes,
          guardLimit,
          modelOverrideEnabled: settings.modelOverrideEnabled ? "true" : "false",
          modelOverrideId: settings.modelOverrideEnabled && settings.modelOverrideModel ? settings.modelOverrideModel.id : "",
          modelOverrideProvider: settings.modelOverrideEnabled && settings.modelOverrideModel ? settings.modelOverrideModel.provider : "",
        },
      });
      return { ...settings, guardLimit };
    }
    const filePath = safeChannelPath(id);
    if (!filePath) {
      const err: any = new Error("Invalid conversation id");
      err.status = 400;
      throw err;
    }
    if (!fs.existsSync(filePath)) {
      const err: any = new Error("Channel not found");
      err.status = 404;
      throw err;
    }
    assertAvailableModelOverride(engine, settings);
    const memberCount = getChannelMembers(filePath).length;
    const guardLimit = settings.guardLimit || defaultAgentPhoneGuardLimit(memberCount);
    await updateChannelMeta(filePath, {
      agentPhoneToolMode: settings.mode,
      agentPhoneReplyMinChars: settings.replyMinChars || "",
      agentPhoneReplyMaxChars: settings.replyMaxChars || "",
      agentPhoneProactiveEnabled: settings.proactiveEnabled ? "true" : "false",
      agentPhoneReminderIntervalMinutes: settings.reminderIntervalMinutes,
      agentPhoneGuardLimit: guardLimit,
      agentPhoneModelOverrideEnabled: settings.modelOverrideEnabled ? "true" : "false",
      agentPhoneModelOverrideId: settings.modelOverrideEnabled && settings.modelOverrideModel ? settings.modelOverrideModel.id : "",
      agentPhoneModelOverrideProvider: settings.modelOverrideEnabled && settings.modelOverrideModel ? settings.modelOverrideModel.provider : "",
    });
    if (hub?.refreshChannelProactiveSchedule) {
      hub.refreshChannelProactiveSchedule();
    } else {
      hub?.channelRouter?.refreshProactiveSchedule?.();
    }
    return { ...settings, guardLimit };
  }

  route.get("/conversations/:id/agent-phone-settings", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const id = c.req.param("id");
      return c.json(await readConversationPhoneSettings(id, c));
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.post("/conversations/:id/agent-phone-settings", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const id = c.req.param("id");
      const body = await safeJson(c);
      const settings = normalizePhoneSettingsPayload(body);
      const saved = await writeConversationPhoneSettings(id, settings, c);
      return c.json({ ok: true, ...(saved || settings) });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.get("/conversations/:id/agent-phone-tool-mode", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const settings = await readConversationPhoneSettings(c.req.param("id"), c);
      return c.json({ mode: settings.mode });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.post("/conversations/:id/agent-phone-tool-mode", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const id = c.req.param("id");
      const current = await readConversationPhoneSettings(id, c).catch(() => ({
        ...DEFAULT_AGENT_PHONE_SETTINGS,
        mode: DEFAULT_AGENT_PHONE_SETTINGS.toolMode,
      }));
      const body = await safeJson(c);
      const settings = { ...current, mode: normalizeAgentPhoneToolMode(body.mode) };
      await writeConversationPhoneSettings(id, settings, c);
      return c.json({ ok: true, mode: settings.mode });
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  // ── 列出所有频道 ──
  route.get("/channels", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const channelsDir = engine.channelsDir;
      if (!channelsDir || !fs.existsSync(channelsDir)) {
        return c.json({ channels: [], bookmarks: {} });
      }

      const files = fs.readdirSync(channelsDir).filter(f => f.endsWith(".md"));
      const bookmarks = readBookmarks(userBookmarkPath());

      const channels = [];
      for (const f of files) {
        const channelId = f.replace(".md", "");
        const filePath = path.join(channelsDir, f);
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed = parseChannel(content);
        const meta: any = parsed.meta;
        const messages: any[] = parsed.messages;
        const members = Array.isArray(meta.members) ? meta.members : [];

        const lastMsg = messages[messages.length - 1];
        const bookmark = bookmarks.get(channelId);

        let newMessageCount = 0;
        if (bookmark && bookmark !== "never") {
          newMessageCount = messages.filter(m => m.timestamp > bookmark).length;
        } else {
          newMessageCount = messages.length;
        }

        channels.push({
          id: channelId,
          name: meta.name || channelId,
          description: meta.description || "",
          members,
          messageCount: messages.length,
          newMessageCount,
          lastMessage: lastMsg?.body?.slice(0, 60) || "",
          lastSender: lastMsg?.sender || "",
          lastTimestamp: lastMsg?.timestamp || "",
        });
      }

      channels.sort((a, b) =>
        (b.lastTimestamp || "").localeCompare(a.lastTimestamp || "")
      );

      const bookmarksObj = {};
      for (const [k, v] of bookmarks) bookmarksObj[k] = v;

      return c.json({ channels, bookmarks: bookmarksObj });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 创建新频道 ──
  route.post("/channels", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const body = await safeJson(c);
      const { name, description, members, intro } = body;

      if (!name || typeof name !== "string") {
        return c.json({ error: "name is required" }, 400);
      }
      let normalizedMembers;
      try {
        normalizedMembers = assertValidChannelMembers(members);
      } catch (err) {
        return c.json({ error: err.message }, 400);
      }

      for (const memberId of normalizedMembers) {
        if (!safeAgentDir(memberId)) {
          return c.json({ error: `Agent not found: ${memberId}`, code: "CHANNEL_AGENT_NOT_FOUND" }, 404);
        }
      }

      const { id: channelId } = await engine.createChannelEntry({
        name,
        description: description || undefined,
        members: normalizedMembers,
        intro: intro || undefined,
      });

      debugLog()?.log("api", `POST /channels — created "${channelId}" (${name}) members=[${normalizedMembers}]`);
      return c.json({ ok: true, id: channelId, name, members: normalizedMembers });
    } catch (err) {
      if (err.message?.includes("已存在")) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 获取频道消息 ──
  route.get("/channels/:name", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      if (!fs.existsSync(filePath)) {
        return c.json({ error: "Channel not found" }, 404);
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseChannel(content);
      const meta: any = parsed.meta;
      const messages = parsed.messages;
      const members = Array.isArray(meta.members) ? meta.members : [];

      return c.json({
        id: meta.id || name,
        name: meta.name || name,
        description: meta.description || "",
        messages,
        members,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 添加频道成员 ──
  route.post("/channels/:name/members", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);
      if (!fs.existsSync(filePath)) return c.json({ error: "Channel not found" }, 404);

      const body = await safeJson(c);
      const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
      if (!memberId) return c.json({ error: "memberId is required" }, 400);

      const agentDir = safeAgentDir(memberId);
      if (!agentDir) return c.json({ error: "Agent not found" }, 404);

      const members = getChannelMembers(filePath);
      assertValidChannelMembers([...members, memberId]);
      await addChannelMember(filePath, memberId);
      await addBookmarkEntry(path.join(agentDir, "channels.md"), name);

      const nextMembers = getChannelMembers(filePath);
      debugLog()?.log("api", `POST /channels/${name}/members member=${memberId}`);
      return c.json({ ok: true, members: nextMembers });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 移除频道成员 ──
  route.delete("/channels/:name/members/:memberId", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const memberId = c.req.param("memberId");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);
      if (!fs.existsSync(filePath)) return c.json({ error: "Channel not found" }, 404);
      if (!memberId || /[/\\]|\.\./.test(memberId)) return c.json({ error: "Invalid member id" }, 400);

      const members = getChannelMembers(filePath);
      if (!members.includes(memberId)) {
        return c.json({ ok: true, members });
      }
      const nextMembers = members.filter((id) => id !== memberId);
      try {
        assertValidChannelMembers(nextMembers);
      } catch (err) {
        return c.json({ error: err.message }, 400);
      }

      await removeChannelMember(filePath, memberId);
      const agentDir = safeAgentDir(memberId);
      if (agentDir) {
        await removeBookmarkEntry(path.join(agentDir, "channels.md"), name);
      }
      hub?.abortAgentPhoneSessions?.("channel-member-removed", {
        agentId: memberId,
        conversationId: name,
        conversationType: "channel",
      });

      debugLog()?.log("api", `DELETE /channels/${name}/members/${memberId}`);
      return c.json({ ok: true, members: nextMembers });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 用户发送消息 ──
  route.post("/channels/:name/messages", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      const reqBody = await safeJson(c);
      const { body } = reqBody;

      if (!body) {
        return c.json({ error: "body is required" }, 400);
      }

      if (!fs.existsSync(filePath)) {
        return c.json({ error: "Channel not found" }, 404);
      }

      const senderName = engine.userName || "user";
      const result = await appendMessage(filePath, senderName, body);

      debugLog()?.log("api", `POST /channels/${name}/messages`);

      const mentionedAgents = extractMentionedAgentIds(body, {
        channelMembers: getChannelMembers(filePath),
        agents: engine.listAgents?.() || [],
      });

      const triggerDelivery = hub.triggerChannelDelivery || hub.triggerChannelTriage;
      triggerDelivery.call(hub, name, { mentionedAgents })?.catch(err =>
        log.error(`触发手机送达失败: ${err.message}`)
      );

      return c.json({ ok: true, timestamp: result.timestamp });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 更新用户已读 bookmark ──
  route.post("/channels/:name/read", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      const body = await safeJson(c);
      const { timestamp } = body;

      if (!timestamp) {
        return c.json({ error: "timestamp is required" }, 400);
      }

      await updateBookmark(userBookmarkPath(), name, timestamp);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 删除频道 ──
  route.delete("/channels/:name", async (c) => {
    try {
      const disabled = requirePhoneEnabled(c);
      if (disabled) return disabled;
      const name = c.req.param("name");
      const filePath = safeChannelPath(name);
      if (!filePath) return c.json({ error: "Invalid channel id" }, 400);

      await engine.deleteChannelByName(name);
      debugLog()?.log("api", `DELETE /channels/${name}`);
      return c.json({ ok: true });
    } catch (err) {
      if (err.message?.includes("不存在")) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 频道开关（唯一入口：engine.setChannelsEnabled）──
  // 写 preferences + 联动 ChannelRouter start/stop 由 config-coordinator 统一处理。
  route.post("/channels/toggle", async (c) => {
    const body = await safeJson(c);
    const { enabled } = body;
    await engine.setChannelsEnabled(!!enabled);
    debugLog()?.log("api", `POST /channels/toggle enabled=${!!enabled}`);
    return c.json({ ok: true, enabled: !!enabled });
  });

  return route;
}
