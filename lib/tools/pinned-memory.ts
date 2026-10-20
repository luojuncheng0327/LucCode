/**
 * pinned-memory.js — pin_memory / unpin_memory 自定义工具
 *
 * 让 agent 通过工具调用来管理置顶记忆，替代之前在 yuan.md 中
 * 指导 agent 手动 read→append→write pinned.md 的方式。
 */

import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import { scrubPII } from "../pii-guard.ts";
import { createModuleLogger } from "../debug-log.ts";
import {
  addPinnedMemoryItem,
  readPinnedMemoryItems,
  removePinnedMemoryItems,
} from "../memory/pinned-memory-store.ts";

const log = createModuleLogger("pin_memory");

function stableMemoryTargetId(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

/**
 * 创建 pin_memory + unpin_memory 工具
 * @param {string} agentDir - agent 数据目录（pinned.md 在这里）
 * @returns {[import('../pi-sdk/index.ts').ToolDefinition, import('../pi-sdk/index.ts').ToolDefinition]}
 */
export function createPinnedMemoryTools(agentDir: string) {
  const pinTool = {
    name: "pin_memory",
    label: "Pin Memory",
    description: "Save an item to pinned memory. Use when the user says 'remember this', 'note this down', 'don't forget this later'. Pinned memories are always kept in context.",
    sessionPermission: {
      resolveInvocation: (params: any = {}) => {
        if (typeof params.content !== "string" || !params.content.trim()) return null;
        return {
          action: "pin",
          kind: "routine",
          capability: "pin_memory.pin",
          target: { type: "memory_store", id: "pinned", label: "Pinned memory" },
        };
      },
    },
    parameters: Type.Object({
      content: Type.String({ description: "Content to remember" }),
    }),
    execute: async (_toolCallId, params) => {
      const { cleaned, detected } = scrubPII(params.content);
      if (detected.length > 0) {
        log.warn(`PII detected (${detected.join(", ")}), redacted before storage`);
      }

      const content = cleaned;
      const result = addPinnedMemoryItem(agentDir, content);
      if (result.alreadyExists) {
        return {
          content: [{ type: "text", text: t("error.pinnedAlreadyExists") }],
          details: {},
        };
      }

      return {
        content: [{ type: "text", text: t("error.pinnedAdded", { content }) }],
        details: { item: result.item },
      };
    },
  };

  const unpinTool = {
    name: "unpin_memory",
    label: "Unpin Memory",
    description: "Remove an item from pinned memory. Use when the user says 'forget xxx' or 'delete this memory'. Supports fuzzy matching: any line containing the keyword you provide will be removed.",
    sessionPermission: {
      resolveInvocation: (params: any = {}) => {
        const id = typeof params.id === "string" ? params.id.trim() : "";
        const keyword = typeof params.keyword === "string" ? params.keyword.trim() : "";
        if (!id && !keyword) return null;
        if (id && !keyword) {
          return {
            action: "unpin",
            kind: "review",
            capability: "unpin_memory.unpin",
            target: { type: "pinned_memory_item", id, label: id },
          };
        }
        return {
          action: "unpin",
          kind: "review",
          capability: "unpin_memory.unpin",
          target: {
            type: "pinned_memory_query",
            id: stableMemoryTargetId({ ...(id ? { id } : {}), keyword }),
            label: keyword || id,
          },
        };
      },
    },
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Pinned memory entity id returned by pin_memory" })),
      keyword: Type.Optional(Type.String({ description: "Keyword of the memory to remove, matched fuzzily" })),
    }),
    execute: async (_toolCallId, params) => {
      const existing = readPinnedMemoryItems(agentDir);
      if (existing.length === 0) {
        return {
          content: [{ type: "text", text: t("error.pinnedEmpty") }],
          details: {},
        };
      }

      const result = removePinnedMemoryItems(agentDir, params);
      const removed = result.removed;

      if (removed.length === 0) {
        const keyword = params.keyword || params.id || "";
        return {
          content: [{ type: "text", text: t("error.pinnedNotFound", { keyword }) }],
          details: {},
        };
      }

      return {
        content: [{ type: "text", text: t("error.pinnedRemoved", { count: removed.length, items: removed.map(item => item.content).join(", ") }) }],
        details: { removedCount: removed.length, removedItems: removed },
      };
    },
  };

  return [pinTool, unpinTool];
}
