/**
 * check-deferred-tool.js — 查询当前 session 的异步任务状态
 *
 * 通用工具，覆盖所有通过 DeferredResultStore 注册的后台任务：
 * 图片/视频生成、subagent、后台终端等。
 * 按当前 sessionPath 隔离，不跨 session。
 */

import { Type } from "../pi-sdk/index.ts";
import { getToolSessionPath } from "./tool-session.ts";
import { t } from "../i18n.ts";

/**
 * @param {{
 *   getDeferredStore: () => import("../deferred-result-store.ts").DeferredResultStore | null,
 *   getSessionPath: () => string | null,
 * }} opts
 */
export function createCheckDeferredTool({ getDeferredStore, getSessionPath }) {
  return {
    name: "check_pending_tasks",
    label: "Check Pending Tasks",
    description: "Check the status of all background async tasks in the current conversation (image/video generation, subagent, etc.). Only returns tasks from the current conversation.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: "Filter by status: pending / resolved / failed. Omit to return all." }),
      ),
    }),
    sessionPermission: {
      resolveInvocation: () => ({
        action: "read",
        kind: "read",
        capability: "check_pending_tasks.read",
      }),
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const store = getDeferredStore();
      if (!store) {
        return { content: [{ type: "text", text: t("tool.checkDeferred.storeNotInitialized") }] };
      }

      const sessionPath = getToolSessionPath(ctx);
      if (!sessionPath) {
        return { content: [{ type: "text", text: t("tool.checkDeferred.noActiveSession") }] };
      }

      const all = store.listBySession(sessionPath);
      const filtered = params.status
        ? all.filter((t) => t.status === params.status)
        : all;

      if (!filtered.length) {
        const qualifier = params.status ? t("tool.checkDeferred.noTasksQualifier", { status: params.status }) : "";
        return { content: [{ type: "text", text: t("tool.checkDeferred.noTasks", { qualifier }) }] };
      }

      const summary = filtered.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        type: t.meta?.type || "unknown",
        deferredAt: new Date(t.deferredAt).toISOString(),
        ...(t.result != null && { result: t.result }),
        ...(t.reason != null && { reason: t.reason }),
        ...(t.meta && Object.keys(t.meta).length > 1 && { meta: t.meta }),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    },
  };
}
