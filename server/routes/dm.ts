/**
 * dm.js — DM 私信 REST API
 *
 * DM 文件存在 agents/{agentId}/dm/{peerId}.md
 *
 * 端点：
 * GET  /api/dm           — 列出主 agent 的所有 DM 对话
 * GET  /api/dm/:peerId   — 获取主 agent 与某个 agent 的 DM 消息
 * POST /api/dm/:peerId/reset — 重置当前 agent 对该 DM 的 phone projection 可见边界
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { parseChannel } from "../../lib/channels/channel-store.ts";
import { resolveAgentStrict } from "../utils/resolve-agent.ts";
import {
  getAgentPhoneProjectionPath,
  readAgentPhoneProjection,
  resetAgentPhoneProjection,
} from "../../lib/conversations/agent-phone-projection.ts";
import { resetAgentPhoneRuntime } from "../../lib/conversations/agent-phone-runtime.ts";

function requestedAgentId(c) {
  const value = c.req.query("agentId");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveDmOwnerAgent(engine, c) {
  if (requestedAgentId(c)) {
    return resolveAgentStrict(engine, c);
  }

  // Without an explicit agentId the DM belongs to the primary agent. If there
  // is no primary agent there is no owner to speak of, and picking whichever
  // agent the server happens to be focused on would hand the caller a
  // different agent's DM. Say so instead.
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

export function createDmRoute(engine, hub = null) {
  const route = new Hono();

  function isPhoneEnabled() {
    return engine.isChannelsEnabled?.() !== false;
  }

  function phoneDisabledResponse(c) {
    return c.json({ error: "Agent phone is disabled" }, 503);
  }

  function invalidPeerId(peerId) {
    return !peerId || /[\/\\]|\.\./.test(peerId);
  }

  function dmProjectionMeta(agent, peerId): Record<string, any> {
    try {
      return readAgentPhoneProjection(getAgentPhoneProjectionPath(agent.agentDir, `dm:${peerId}`)).meta;
    } catch {
      return {};
    }
  }

  function filterVisibleDmMessages(agent, peerId, messages) {
    const visibleAfterTimestamp = dmProjectionMeta(agent, peerId).visibleAfterTimestamp;
    if (!visibleAfterTimestamp || typeof visibleAfterTimestamp !== "string") return messages;
    return messages.filter((message) => !message.timestamp || message.timestamp > visibleAfterTimestamp);
  }

  // ── 列出所有 DM 对话（包含未聊过的 agent 作为占位） ──
  route.get("/dm", async (c) => {
    try {
      if (!isPhoneEnabled()) return phoneDisabledResponse(c);
      const agent = resolveDmOwnerAgent(engine, c);
      if (!agent) {
        return c.json({ dms: [] });
      }

      const ownerAgentId = agent.id;
      const dmDir = path.join(agent.agentDir, "dm");

      // 已有 DM 文件 → 读取消息摘要
      const existingDms = new Map();
      if (fs.existsSync(dmDir)) {
        for (const f of fs.readdirSync(dmDir).filter(f => f.endsWith(".md"))) {
          const peerId = f.replace(".md", "");
          const filePath = path.join(dmDir, f);
          const content = fs.readFileSync(filePath, "utf-8");
          const { messages } = parseChannel(content);
          const visibleMessages = filterVisibleDmMessages(agent, peerId, messages);
          const lastMsg = visibleMessages[visibleMessages.length - 1];

          existingDms.set(peerId, {
            lastMessage: lastMsg?.body?.slice(0, 60) || "",
            lastSender: lastMsg?.sender || "",
            lastTimestamp: lastMsg?.timestamp || "",
            messageCount: visibleMessages.length,
          });
        }
      }

      // 所有其他 agent 都作为 DM 条目（没聊过的也显示）
      const allAgents = engine.listAgents?.() || [];
      const dms = allAgents
        .filter(a => a.id !== ownerAgentId)
        .map(a => {
          const existing = existingDms.get(a.id);
          return {
            ownerAgentId,
            peerId: a.id,
            peerName: a.name || a.agentName || a.id,
            lastMessage: existing?.lastMessage || "",
            lastSender: existing?.lastSender || "",
            lastTimestamp: existing?.lastTimestamp || "",
            messageCount: existing?.messageCount || 0,
          };
        });

      // 有消息的排前面（按最后消息时间倒序），没消息的按名字排
      dms.sort((a, b) => {
        if (a.lastTimestamp && !b.lastTimestamp) return -1;
        if (!a.lastTimestamp && b.lastTimestamp) return 1;
        if (a.lastTimestamp && b.lastTimestamp) return b.lastTimestamp.localeCompare(a.lastTimestamp);
        return a.peerName.localeCompare(b.peerName);
      });

      return c.json({ ownerAgentId, dms });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ── 获取 DM 消息 ──
  route.get("/dm/:peerId", async (c) => {
    try {
      if (!isPhoneEnabled()) return phoneDisabledResponse(c);
      const peerId = c.req.param("peerId");
      const agent = resolveDmOwnerAgent(engine, c);
      if (!agent) {
        return c.json({ error: "No active agent" }, 400);
      }
      const ownerAgentId = agent.id;

      // 安全校验
      if (invalidPeerId(peerId)) {
        return c.json({ error: "Invalid peerId" }, 400);
      }

      const dmFile = path.join(agent.agentDir, "dm", `${peerId}.md`);
      if (!fs.existsSync(dmFile)) {
        return c.json({ error: "DM not found" }, 404);
      }

      const content = fs.readFileSync(dmFile, "utf-8");
      const { messages } = parseChannel(content);
      const visibleMessages = filterVisibleDmMessages(agent, peerId, messages);

      const peerAgent = engine.getAgent(peerId);
      const peerName = peerAgent?.agentName || peerAgent?.name || peerId;

      return c.json({
        ownerAgentId,
        peerId,
        peerName,
        messages: visibleMessages,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/dm/:peerId/reset", async (c) => {
    try {
      if (!isPhoneEnabled()) return phoneDisabledResponse(c);
      const peerId = c.req.param("peerId");
      if (invalidPeerId(peerId)) {
        return c.json({ error: "Invalid peerId" }, 400);
      }

      const agent = resolveDmOwnerAgent(engine, c);
      if (!agent) {
        return c.json({ error: "No active agent" }, 400);
      }
      const ownerAgentId = agent.id;
      const dmFile = path.join(agent.agentDir, "dm", `${peerId}.md`);
      let visibleAfterTimestamp = "";
      if (fs.existsSync(dmFile)) {
        const content = fs.readFileSync(dmFile, "utf-8");
        const { messages } = parseChannel(content);
        visibleAfterTimestamp = messages[messages.length - 1]?.timestamp || "";
      }

      await resetAgentPhoneProjection({
        agentDir: agent.agentDir,
        agentId: ownerAgentId,
        conversationId: `dm:${peerId}`,
        conversationType: "dm",
        visibleAfterTimestamp,
        resetBy: ownerAgentId,
      });
      await resetAgentPhoneRuntime({
        agentDir: agent.agentDir,
        conversationId: `dm:${peerId}`,
      });
      hub?.abortAgentPhoneSessions?.("dm-reset", {
        agentId: ownerAgentId,
        conversationId: `dm:${peerId}`,
        conversationType: "dm",
      });

      return c.json({
        ok: true,
        ownerAgentId,
        peerId,
        visibleAfterTimestamp,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
