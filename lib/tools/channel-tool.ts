/**
 * channel-tool.js — Agent 使用的频道工具
 *
 * 操作：
 * - read：读取频道最近消息
 * - post：往频道发送消息
 * - create：创建新频道
 * - list：查看加入的频道列表
 */

import { Type, StringEnum } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import {
  appendMessage,
  createChannel,
  addBookmarkEntry,
  getRecentMessages,
  getChannelMeta,
  formatMessagesForLLM,
  normalizeChannelMembers,
  readBookmarks,
} from "../channels/channel-store.ts";
import fs from "fs";
import path from "path";

interface ChannelMeta {
  name?: string;
  description?: string;
  members?: string[];
}

function safeChannelFilePath(channelsDir, channelId) {
  if (!channelId || /[/\\]|\.\./.test(channelId)) return null;
  const filePath = path.resolve(channelsDir, `${channelId}.md`);
  const base = path.resolve(channelsDir);
  if (!filePath.startsWith(base + path.sep) && filePath !== base) return null;
  return filePath;
}

function safeAgentDir(agentsDir, agentId) {
  if (!agentId || /[/\\]|\.\./.test(agentId)) return null;
  const dirPath = path.resolve(agentsDir, agentId);
  const base = path.resolve(agentsDir);
  if (!dirPath.startsWith(base + path.sep) && dirPath !== base) return null;
  return fs.existsSync(dirPath) ? dirPath : null;
}

function listJoinedChannels({ channelsDir, agentsDir, agentId }) {
  if (!fs.existsSync(channelsDir)) return [];

  const bookmarks = readBookmarks(path.join(agentsDir, agentId, "channels.md"));
  return fs.readdirSync(channelsDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => {
      const id = fileName.replace(/\.md$/, "");
      const filePath = path.join(channelsDir, fileName);
      const meta = getChannelMeta(filePath) as ChannelMeta;
      const members = Array.isArray(meta.members) ? meta.members : [];
      return {
        id,
        name: meta.name || id,
        description: meta.description || "",
        members,
        lastRead: bookmarks.get(id) || "never",
        filePath,
      };
    })
    .filter((channel) => channel.members.includes(agentId))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function formatChannelList(channels) {
  const lines = [t("tool.channel.heading"), ""];
  for (const channel of channels) {
    const parts = [
      `name: ${channel.name}`,
      `members: ${channel.members.join(", ")}`,
      `last: ${channel.lastRead}`,
    ];
    if (channel.description) parts.push(`description: ${channel.description}`);
    lines.push(`- ${channel.id} (${parts.join("; ")})`);
  }
  return lines.join("\n");
}

function resolveChannelReference({ channelsDir, agentsDir, agentId, channel }) {
  const requested = typeof channel === "string" ? channel.trim() : "";
  if (!requested) {
    return { ok: false, error: "missing params" };
  }

  const exactPath = safeChannelFilePath(channelsDir, requested);
  if (exactPath && fs.existsSync(exactPath)) {
    const meta = getChannelMeta(exactPath) as ChannelMeta;
    const members = Array.isArray(meta.members) ? meta.members : [];
    if (!members.includes(agentId)) {
      return {
        ok: false,
        error: "not a member",
        channelId: requested,
        name: meta.name || requested,
      };
    }
    return {
      ok: true,
      id: requested,
      name: meta.name || requested,
      filePath: exactPath,
      members,
    };
  }

  const matches = listJoinedChannels({ channelsDir, agentsDir, agentId })
    .filter((entry) => entry.name === requested);
  if (matches.length === 1) {
    const match = matches[0];
    return {
      ok: true,
      id: match.id,
      name: match.name,
      filePath: match.filePath,
      members: match.members,
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: "ambiguous channel name",
      name: requested,
      matches: matches.map((entry) => entry.id),
    };
  }

  return {
    ok: false,
    error: "channel not found",
    name: requested,
  };
}

function channelResolveErrorResult(action, requested, resolved) {
  if (resolved.error === "ambiguous channel name") {
    const choices = resolved.matches.join(", ");
    return {
      content: [{
        type: "text",
        text: t("tool.channel.ambiguousName", { name: resolved.name, choices }),
      }],
      details: { action, error: resolved.error, matches: resolved.matches },
    };
  }

  if (resolved.error === "not a member") {
    return {
      content: [{ type: "text", text: t("error.agentNotChannelMember", { channel: requested }) }],
      details: { action, error: resolved.error },
    };
  }

  return {
    content: [{ type: "text", text: t("error.channelNotExists", { channel: requested }) }],
    details: { action, error: "channel not found" },
  };
}

function stableOpaqueId(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

function stableSort(values: string[]) {
  return [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

/**
 * 创建频道工具
 * @param {object} opts
 * @param {string} opts.channelsDir - 频道目录路径
 * @param {string} opts.agentsDir - agents 父目录
 * @param {string} opts.agentId - 当前 agent ID
 * @param {() => Array<{id: string, name: string}>} opts.listAgents - 列出所有 agent
 * @returns {import('../pi-sdk/index.ts').ToolDefinition}
 */
export function createChannelTool({
  channelsDir,
  agentsDir,
  agentId,
  listAgents: _listAgents,
  onPost,
  isEnabled,
  createChannelEntry,
}) {
  function resolveInvocation(params: any = {}) {
    const action = typeof params?.action === "string" ? params.action : "";
    if (action === "list") {
      return { action, kind: "read", capability: "channel.list" };
    }
    if (action === "read" || action === "post") {
      const resolved = resolveChannelReference({
        channelsDir,
        agentsDir,
        agentId,
        channel: params.channel,
      });
      if (!resolved.ok) return null;
      return {
        action,
        kind: action === "read" ? "read" : "review",
        capability: `channel.${action}`,
        target: {
          type: "channel",
          id: resolved.id,
          label: resolved.name,
        },
      };
    }
    if (action === "create") {
      if (typeof params.name !== "string" || params.name !== params.name.trim() || !params.name) return null;
      if (!Array.isArray(params.members)) return null;
      try {
        const members = stableSort(normalizeChannelMembers([agentId, ...params.members]));
        return {
          action,
          kind: "review",
          capability: "channel.create",
          target: {
            type: "channel_draft",
            id: stableOpaqueId({ name: params.name, members }),
            label: params.name,
          },
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  return {
    name: "channel",
    label: "Channel",
    description: "Manage channel messages for broadcasts and group discussions. This tool cannot read or send one-on-one Agent Phone conversations.",
    sessionPermission: { resolveInvocation },
    parameters: Type.Object({
      action: StringEnum(
        ["read", "post", "create", "list"],
        { description: "Action type" },
      ),
      channel: Type.Optional(Type.String({
        description: "Channel name (required for read/post)"
      })),
      content: Type.Optional(Type.String({
        description: "Message content (required for post)"
      })),
      name: Type.Optional(Type.String({
        description: "New channel name (required for create)"
      })),
      members: Type.Optional(Type.Array(Type.String(), {
        description: "Member list (required for create), e.g. [\"luc\", \"butter\"]"
      })),
      intro: Type.Optional(Type.String({
        description: "Channel description (optional for create)"
      })),
      count: Type.Optional(Type.Number({
        description: "Number of messages to read (optional for read, default 20)"
      })),
    }),

    execute: async (_toolCallId, params) => {
      if (isEnabled && !isEnabled()) {
        return {
          content: [{ type: "text", text: t("error.channelsDisabled") }],
          details: { action: params.action, error: "channels disabled" },
        };
      }

      switch (params.action) {
        case "read": {
          if (!params.channel) {
            return {
              content: [{ type: "text", text: t("error.channelReadNeedChannel") }],
              details: { action: "read", error: "missing params" },
            };
          }

          const resolved = resolveChannelReference({
            channelsDir,
            agentsDir,
            agentId,
            channel: params.channel,
          });
          if (!resolved.ok) return channelResolveErrorResult("read", params.channel, resolved);

          const count = params.count || 20;
          const messages = getRecentMessages(resolved.filePath, count, undefined);
          const text = messages.length > 0
            ? formatMessagesForLLM(messages)
            : t("error.channelNoMessages");

          return {
            content: [{ type: "text", text }],
            details: { action: "read", channel: resolved.id, name: resolved.name, messageCount: messages.length },
          };
        }

        case "post": {
          if (!params.channel || !params.content) {
            return {
              content: [{ type: "text", text: t("error.channelPostNeedParams") }],
              details: { action: "post", error: "missing params" },
            };
          }

          const resolved = resolveChannelReference({
            channelsDir,
            agentsDir,
            agentId,
            channel: params.channel,
          });
          if (!resolved.ok) return channelResolveErrorResult("post", params.channel, resolved);

          const { timestamp } = await appendMessage(resolved.filePath, agentId, params.content);

          // 触发频道手机送达，让其他 agent 看到新消息并自行行动
          if (onPost) {
            try {
              onPost(resolved.id, agentId, {
                sender: agentId,
                timestamp,
                body: params.content,
              });
            } catch {
              // Posting to the channel already succeeded; delivery notification is best-effort.
            }
          }

          return {
            content: [{ type: "text", text: t("error.channelPosted", { channel: resolved.name }) }],
            details: { action: "post", channel: resolved.id, name: resolved.name, timestamp },
          };
        }

        case "create": {
          if (!params.name || !params.members) {
            return {
              content: [{ type: "text", text: t("error.channelCreateNeedParams") }],
              details: { action: "create", error: "missing params" },
            };
          }

          try {
            const members = normalizeChannelMembers([agentId, ...params.members]);
            const missingMember = members.find((memberId) => !safeAgentDir(agentsDir, memberId));
            if (missingMember) {
              const message = `Agent not found: ${missingMember}`;
              return {
                content: [{ type: "text", text: t("error.channelCreateFailed", { msg: message }) }],
                details: { action: "create", error: message },
              };
            }
            const created = typeof createChannelEntry === "function"
              ? await createChannelEntry({
                name: params.name,
                members,
                intro: params.intro,
                addUserBookmark: true,
              })
              : await createChannel(channelsDir, {
                id: undefined,
                name: params.name,
                description: undefined,
                members,
                intro: params.intro,
              });
            const channelId = created.id;

            if (typeof createChannelEntry !== "function") {
              for (const memberId of members) {
                const memberChannelsMd = path.join(agentsDir, memberId, "channels.md");
                if (fs.existsSync(path.join(agentsDir, memberId))) {
                  await addBookmarkEntry(memberChannelsMd, channelId);
                }
              }
            }

            return {
              content: [{ type: "text", text: t("error.channelCreated", { name: params.name, id: channelId, members: members.join(", ") }) }],
              details: { action: "create", channel: channelId, members },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: t("error.channelCreateFailed", { msg: err.message }) }],
              details: { action: "create", error: err.message },
            };
          }
        }

        case "list": {
          const channels = listJoinedChannels({ channelsDir, agentsDir, agentId });
          if (channels.length === 0) {
            return {
              content: [{ type: "text", text: t("error.channelNoJoined") }],
              details: { action: "list", channels: [] },
            };
          }

          return {
            content: [{ type: "text", text: formatChannelList(channels) }],
            details: {
              action: "list",
              channels: channels.map(({ filePath: _filePath, ...channel }) => channel),
            },
          };
        }

        default:
          return {
            content: [{ type: "text", text: t("error.unknownAction", { action: params.action }) }],
            details: { action: params.action },
          };
      }
    },
  };
}
