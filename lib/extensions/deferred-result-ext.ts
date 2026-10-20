/**
 * Deferred Result Pi SDK Extension
 *
 * On session_start:
 *   1. 扫描未送达的已完成任务，作为旧 session-start 兼容补发
 *   2. 如果还有 pending 任务，提醒 LLM
 *
 * 实时投递由 DeferredResultCoordinator 统一处理，避免后台结果依赖
 * 单个 Pi session extension 的生命周期。
 */

import {
  buildDeferredResultMessage,
  isUiOnlyDeferredResultTask,
  shouldNotifyAgentOnFailure,
} from "../deferred-result-notification.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("deferred-result-ext");

function isExternallyDeliveredTask(task) {
  return task?.meta?.deliveryTarget?.kind === "bridge";
}

/**
 * 尝试 steer 送达一个任务结果，成功后 markDelivered
 * @returns {boolean} 是否送达成功
 */
function tryDeliver(pi, store, taskId, task) {
  try {
    pi.sendMessage(
      buildDeferredResultMessage(taskId, task),
      { deliverAs: "steer", triggerTurn: true },
    );
    store.markDelivered(taskId);
    return true;
  } catch (err) {
    log.error(`steer failed for ${taskId}: ${err.message || err} ${err.stack?.split('\n').slice(0, 3).join('\n') || ''}`);
    return false;
  }
}

/**
 * @param {import("../deferred-result-store.ts").DeferredResultStore} deferredStore
 * @returns {(pi: object) => void}
 */
export function createDeferredResultExtension(deferredStore) {
  return function (pi) {
    let sessionPath = null;

    pi.on("session_start", (event, ctx) => {
      sessionPath = ctx.sessionManager.getSessionFile();

      // ── 补发未送达的已完成任务 ──
      setTimeout(() => {
        const undelivered = deferredStore.listUndelivered(sessionPath);
        for (const task of undelivered) {
          if (isUiOnlyDeferredResultTask(task) && !shouldNotifyAgentOnFailure(task)) continue;
          if (isExternallyDeliveredTask(task)) continue;
          tryDeliver(pi, deferredStore, task.taskId, task);
        }

        // 如果还有 pending 任务，提醒 LLM
        const pending = deferredStore.listPending(sessionPath);
        if (pending.length) {
          try {
            pi.sendMessage(
              {
                customType: "luc-deferred-task-reminder",
                content: `<luc-deferred-tasks>${pending.length} 个后台任务进行中；使用 check_pending_tasks 工具可查看详情。</luc-deferred-tasks>`,
                display: false,
              },
              { deliverAs: "steer", triggerTurn: false },
            );
          } catch { /* best effort */ }
        }
      }, 500);
    });

    pi.on("session_shutdown", () => {
      sessionPath = null;
    });
  };
}
