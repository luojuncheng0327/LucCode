/**
 * dm-tool.js — Agent 私信工具
 *
 * 向另一个 agent 发送私信。消息写入双方的 dm/ 目录，
 * 通过 DM Router 异步通知对方回复。
 *
 * 和 ask_agent 的区别：
 * - ask_agent：同步、单次、无记忆、借用对方模型做任务
 * - dm：异步、有聊天记录、对方以频道模式回复、像发微信
 */

import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import fs from "fs";
import path from "path";
import { appendMessage } from "../channels/channel-store.ts";
import { resolveAgentParam } from "./agent-id-resolver.ts";

/**
 * 确保 DM 文件存在，不存在则创建（含 frontmatter）
 */
function ensureDmFile(dmDir, peerId) {
  fs.mkdirSync(dmDir, { recursive: true });
  const filePath = path.join(dmDir, `${peerId}.md`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `---\npeer: ${peerId}\n---\n`, "utf-8");
  }
  return filePath;
}

/**
 * @param {object} opts
 * @param {string} opts.agentId - 当前 agent ID
 * @param {string} opts.agentsDir - agents 根目录
 * @param {() => Array<{id: string, name: string}>} opts.listAgents
 * @param {(fromId: string, toId: string) => void} [opts.onDmSent] - 发送后回调（触发 DM Router）
 * @param {() => boolean} [opts.isEnabled] - Phone/DM 总闸
 */
export function createDmTool({ agentId, agentsDir, listAgents, onDmSent, isEnabled }) {
  return {
    name: "dm",
    label: "Direct Message",
    description: "Send a single direct message to another agent to inform them of something.\nDo not use this tool to assign tasks or get results; that is subagent's job.",
    sessionPermission: {
      resolveInvocation: (params: any = {}) => {
        const agents = listAgents();
        const resolved = resolveAgentParam(agents, params.to);
        if (!resolved.ok || !resolved.agentId || resolved.agentId === agentId) return null;
        const target = agents.find((candidate) => candidate.id === resolved.agentId);
        return {
          action: "send",
          kind: "review",
          capability: "dm.send",
          target: {
            type: "agent",
            id: resolved.agentId,
            label: target?.name || resolved.agentId,
          },
        };
      },
    },
    parameters: Type.Object({
      to: Type.String({ description: "Target agent's id field value (the one in parentheses in the team roster, not the bold display name)" }),
      message: Type.String({ description: "Message content" }),
    }),

    execute: async (_toolCallId, params) => {
      if (isEnabled && !isEnabled()) {
        return {
          content: [{ type: "text", text: t("error.channelsDisabled") }],
          details: { action: "dm", error: "phone disabled" },
        };
      }

      const agents = listAgents();
      // 解析 to 参数：先按 id，找不到再按 name 唯一匹配兜底
      const resolved = resolveAgentParam(agents, params.to);
      if (!resolved.ok) {
        const candidates = resolved.ambiguous
          ? resolved.byName
          : agents.filter(a => a.id !== agentId);
        const lines = candidates.map(a => {
          const label = a.name && a.name !== a.id ? `${a.id} (${a.name})` : a.id;
          const parts = [label];
          if (a.model) parts.push(`[${a.model}]`);
          if (a.summary) parts.push(a.summary);
          return parts.join(" — ");
        });
        return {
          content: [{ type: "text", text: t("error.agentNotFoundAvailable", { id: params.to, ids: lines.join("\n") || "(none)" }) }],
        };
      }
      const toId = resolved.agentId;
      if (toId === agentId) {
        return { content: [{ type: "text", text: t("error.cannotSelfDm") }] };
      }
      const target = agents.find(a => a.id === toId);

      // 写入自己的 dm/{toId}.md
      const myDmDir = path.join(agentsDir, agentId, "dm");
      const myDmFile = ensureDmFile(myDmDir, toId);
      await appendMessage(myDmFile, agentId, params.message);

      // 写入对方的 dm/{myId}.md
      const peerDmDir = path.join(agentsDir, toId, "dm");
      const peerDmFile = ensureDmFile(peerDmDir, agentId);
      await appendMessage(peerDmFile, agentId, params.message);

      // 通知 DM Router
      if (onDmSent) {
        try { onDmSent(agentId, toId); } catch {}
      }

      return {
        content: [{ type: "text", text: t("error.dmSent", { name: target.name }) }],
        details: { from: agentId, to: toId },
      };
    },
  };
}
