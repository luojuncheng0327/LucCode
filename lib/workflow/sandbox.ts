import vm from "node:vm";
import { extractMeta } from "./meta.ts";
import { WORKFLOW_RUNTIME_CONTRACT } from "./host-api.ts";

/**
 * 只是兜底值。正常调用方会传 totalTimeoutMs + 一分钟余量：超时语义以 abort 为主，
 * 资源判定（节点超时 / 无进展 / 总量）都在调用方，先 abort 再让这里的 race 收场。
 * 这条 deadline 只覆盖"连 abort 都没能唤醒脚本 promise"的极端情况。
 */
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;

/**
 * 在 node:vm 能力沙箱里执行 workflow 脚本。
 *
 * 安全说明：这不是对抗级沙箱（见 spec 非目标）。脚本由 Luc 自家模型生成，
 * 真正的安全边界是子 agent 跑在其中的现有工具权限系统。本沙箱只负责：
 * 干净执行、防意外读写（不注入 require/process/fs/net）、资源边界（deadline/abort）、
 * 去非确定性（禁 Math.random / Date.now）。
 *
 * @param {string} script
 * @param {Record<string, any>} hostApi  注入沙箱的全局
 * @param {{ signal?: AbortSignal, deadlineMs?: number }} [opts]
 * @returns {Promise<{ meta: object, result: any }>}
 */
export async function runWorkflowScript(script, hostApi, opts: { signal?: AbortSignal, deadlineMs?: number } = {}) {
  const { meta, body } = extractMeta(script);
  const { signal, deadlineMs = DEFAULT_DEADLINE_MS } = opts;
  if (signal?.aborted) throw new Error(`workflow "${meta.name}" 被中止`);

  // 沙箱全局：null 原型 + 只注入 hostApi。不放 require/process/module/global。
  const sandbox = Object.create(null);
  for (const key of Object.keys(hostApi || {})) sandbox[key] = hostApi[key];
  // __wf_api：完整 host API 对象，供 `export default function(api){...}` 形态解构入参
  // （meta.normalizeExports 把 export default 转成 `__wf_default(__wf_api)` 调用）。
  sandbox.__wf_api = hostApi || {};
  const context = vm.createContext(sandbox);

  // 包成 async IIFE：让脚本里的 await / return 合法；前缀禁用非确定性 API。
  const wrapped =
    "(async () => {\n" +
    "'use strict';\n" +
    "const __nd = () => { throw new Error('workflow 脚本内禁止非确定性 API（Math.random/Date.now）'); };\n" +
    "Math.random = __nd; Date.now = __nd;\n" +
    body +
    "\n})()";

  let scriptPromise;
  try {
    scriptPromise = vm.runInContext(wrapped, context, {
      filename: `workflow:${meta.name}`,
      timeout: deadlineMs, // 仅对同步阶段有效；async 整体超时靠下方 race
    });
  } catch (err) {
    throw new Error(`workflow "${meta.name}" 脚本错误: ${err.message}`);
  }

  const result = await raceDeadline(scriptPromise, { signal, deadlineMs, name: meta.name });
  hostApi?.[WORKFLOW_RUNTIME_CONTRACT]?.assertNoUnawaitedAgentCalls?.();
  return { meta, result };
}

/**
 * 让 promise 与 deadline / abort 赛跑，先到先 settle。
 * @param {Promise<any>} promise
 * @param {{ signal?: AbortSignal, deadlineMs: number, name: string }} o
 */
function raceDeadline(promise, { signal, deadlineMs, name }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error(`workflow "${name}" 超时（${deadlineMs}ms）`)), deadlineMs);
    const onAbort = () => finish(reject, new Error(`workflow "${name}" 被中止`));
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}
