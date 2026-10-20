
import { createStructuredOutputTool } from "./structured-output.ts";
import { WorkflowJournal } from "./journal.ts";
import { resolveSubagentToolAccess } from "../tools/subagent-tool-policy.ts";
import {
  assertNodeWriteFoldersShape,
  assertNodeWriteScopeDeclared,
  resolveNodeFolderScope,
} from "./node-folder-scope.ts";
import { DEFAULT_RUN_LIMITS, isRetryableNodeError, retryDelayMs } from "./run-limits.ts";

export const WORKFLOW_RUNTIME_CONTRACT = Symbol.for("luc.workflow.runtimeContract");

const AGENT_OPTION_KEYS = new Set(["label", "model", "agentType", "toolFilter", "access", "schema", "writeFolders", "retries"]);

/** 节点重试次数硬上限：脚本写多少都不允许超过，避免一个坏节点把整条 run 拖死。 */
const MAX_NODE_RETRIES = 5;

function normalizeAgentOptions(rawOpts) {
  if (rawOpts == null) return {};
  if (typeof rawOpts !== "object" || Array.isArray(rawOpts)) {
    throw new Error("workflow agent(prompt, opts) 的 opts 必须是对象。");
  }
  for (const key of Object.keys(rawOpts)) {
    if (!AGENT_OPTION_KEYS.has(key)) {
      throw new Error(
        `workflow agent() unsupported option "${key}". ` +
        "Use agent(prompt, { label?, model?, agentType?, access?, writeFolders?, schema?, toolFilter?, retries? }); " +
        "put the task instructions in the first prompt argument.",
      );
    }
  }
  if (rawOpts.access != null && rawOpts.access !== "read" && rawOpts.access !== "write") {
    throw new Error('workflow agent() access must be "read" or "write".');
  }
  if (rawOpts.retries != null && (!Number.isInteger(rawOpts.retries) || rawOpts.retries < 0)) {
    throw new Error("workflow agent() retries must be a non-negative integer.");
  }
  assertNodeWriteFoldersShape(rawOpts.writeFolders, rawOpts.access);
  return rawOpts;
}

/**
 * 把一次尝试的原始失败翻译成带正确重试语义的错误。
 *
 * 三种收场必须区分清楚，否则要么该重试的不重试，要么该死的不死：
 * - 父 signal 已 abort：整条 workflow 被叫停，节点没有第二次机会。
 * - 节点自己的超时：只有这一个节点卡住，换一次还有机会。消息措辞刻意避开
 *   "中止 / aborted"——run-limits 的分类器按词判定，带上这些词就会被判成不可重试。
 * - 其余：原样上抛，由分类器决定。
 */
function classifyNodeFailure(err, { signal, nodeAbort, nodeTimeoutMs }) {
  if (signal?.aborted) return new Error("workflow 已中止");
  if (nodeAbort.signal.aborted) {
    return Object.assign(
      new Error(`节点超时（${nodeTimeoutMs}ms）：节点未在时限内完成`),
      { cause: err },
    );
  }
  return err;
}

function normalizeAgentPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("workflow agent(prompt, opts) requires a non-empty prompt string as the first argument.");
  }
  return prompt;
}

function createWorkflowRuntimeContract() {
  const calls = [];

  function trackAgentCall(meta, start) {
    const record = { ...meta, consumed: false };
    calls.push(record);
    let promise = null;

    const consume = () => {
      record.consumed = true;
      if (!promise) {
        promise = Promise.resolve().then(start);
      }
      return promise;
    };

    return new Proxy(Object.create(null), {
      get(_target, prop) {
        if (prop === "then") return (onFulfilled, onRejected) => consume().then(onFulfilled, onRejected);
        if (prop === "catch") return (onRejected) => consume().catch(onRejected);
        if (prop === "finally") return (onFinally) => consume().finally(onFinally);
        if (prop === Symbol.toStringTag) return "Promise";
        if (prop === "result") {
          throw new Error(
            "workflow agent() returns a Promise. Use \"const result = await agent(...)\" before reading the result; " +
            "do not use agent(...).result.",
          );
        }
        throw new Error(
          `workflow agent() returns a Promise. Await agent("${record.promptPreview}") before reading property "${String(prop)}".`,
        );
      },
    });
  }

  function assertNoUnawaitedAgentCalls() {
    const unawaited = calls.filter((call) => !call.consumed);
    if (!unawaited.length) return;
    const first = unawaited[0];
    throw new Error(
      `workflow agent() call ${first.nodeId} was not awaited. ` +
      'Use `const result = await agent("task prompt", { access, agentType })`; ' +
      "agent() does not return { result }.",
    );
  }

  return { trackAgentCall, assertNoUnawaitedAgentCalls };
}

/**
 * 组装注入沙箱的宿主 API。引擎层不认识 agent 名字，agentType→agentId 的解析由调用方注入 resolveAgentId。
 * @param {{
 *   executeIsolated: (prompt: string, isoOpts: object) => Promise<{ replyText?: string, error?: string|null }>,
 *   baseIsoOpts: object,
 *   limiter: { run: (thunk: () => Promise<any>) => Promise<any> },
 *   signal?: AbortSignal,
 *   onProgress?: (evt: object) => void,
 *   onAgentEvent?: (evt: { phase: 'start'|'session'|'done'|'fail', nodeId: string, threadId?: string|null, threadKind?: string|null, label?: string|null, agentId?: string|null, phaseLabel?: string|null, childSessionId?: string|null, childSessionPath?: string|null }) => void,
 *   budget?: { total: number|null, spent: () => number, remaining: () => number },
 *   args?: any,
 *   resolveAgentId?: (agentType?: string) => string|undefined,
 *   journal?: import("./journal.ts").WorkflowJournal|null,
 *   replayJournal?: import("./journal.ts").WorkflowJournal|null,
 *   runWorkflow?: (script: string, args?: any) => Promise<any>,
 *   parentFolderScope?: { sandboxFolders?: string[] }|null,
 *   runLimits?: { nodeTimeoutMs?: number, nodeRetries?: number },
 * }} deps
 * @returns {{ agent: Function, parallel: Function, pipeline: Function, log: Function, phase: Function, workflow: Function, budget: any, args: any }}
 */
export function createHostApi(deps) {
  const { executeIsolated, baseIsoOpts, limiter, signal, budget, args, resolveAgentId, parentFolderScope, runLimits } = deps;
  const onAgentEvent = typeof deps.onAgentEvent === "function" ? deps.onAgentEvent : () => {};
  const onProgress = typeof deps.onProgress === "function" ? deps.onProgress : () => {};
  const journal = deps.journal || null;
  const replayJournal = deps.replayJournal || null;
  const runtimeContract = createWorkflowRuntimeContract();
  let nodeSeq = 0;
  let currentPhase = null;

  function agent(prompt, rawOpts: { label?: string; model?: string; agentType?: string; toolFilter?: any; access?: "read"|"write"; writeFolders?: string[]; schema?: any; retries?: number } = {}) {
    const normalizedPrompt = normalizeAgentPrompt(prompt);
    const opts = normalizeAgentOptions(rawOpts);

    // nodeId 在调用入口分配：用纯计数器，不依赖沙箱里被禁用的 Date.now/Math.random。
    const seq = ++nodeSeq;
    const nodeId = `node-${seq}`;
    const parentTaskId = typeof baseIsoOpts.subagentTaskId === "string" && baseIsoOpts.subagentTaskId
      ? baseIsoOpts.subagentTaskId
      : null;
    const threadId = parentTaskId ? `${parentTaskId}::${nodeId}` : null;
    const threadKind = threadId ? "workflow_node" : null;
    const label = typeof opts.label === "string" && opts.label ? opts.label : null;

    // default-deny：写能力节点必须点名写作用域。调用点同步判定（opts 此刻完全已知），
    // 拒绝发生在 spawn 子 session 之前；错误消息即给编排模型的纠正指引。
    assertNodeWriteScopeDeclared({
      writeFolders: opts.writeFolders ?? null,
      access: opts.access ?? null,
      parentPermissionMode: baseIsoOpts.permissionMode || null,
      nodeId,
      label,
    });

    const startAgentNode = async () => {
      // ── journal 回放：cache hit 不消耗 limiter slot，瞬间返回 ──
      if (replayJournal) {
        const replayKey = WorkflowJournal.computeKey(normalizedPrompt, opts);
        const cached = replayJournal.tryReplay(seq, replayKey);
        if (cached) {
          onAgentEvent({ phase: "start", nodeId, threadId, threadKind, label, agentId: baseIsoOpts.agentId ?? null, phaseLabel: currentPhase });
          onAgentEvent({ phase: "done", nodeId, threadId, threadKind });
          journal?.record(seq, replayKey, cached.result, "ok");
          return cached.result;
        }
      }

      return limiter.run(async () => {
        if (signal?.aborted) throw new Error("workflow 已中止");

        // budget 硬上限：spent >= total 时拒绝新 agent
        if (budget?.total != null && budget.remaining() <= 0) {
          throw new Error(`workflow token 预算耗尽（已用 ${budget.spent()}）`);
        }

        const isoOpts = { ...baseIsoOpts, signal };
        if (threadId) {
          isoOpts.subagentThreadId = threadId;
          isoOpts.subagentThreadKind = threadKind;
        }
        if (opts.access === "read" || opts.access === "write") {
          const toolAccess = resolveSubagentToolAccess({
            access: opts.access,
            parentPermissionMode: baseIsoOpts.permissionMode || null,
          });
          isoOpts.permissionMode = toolAccess.permissionMode;
          if (toolAccess.customToolFilter) isoOpts.toolFilter = toolAccess.customToolFilter;
          if (toolAccess.builtinToolFilter) isoOpts.builtinFilter = toolAccess.builtinToolFilter;
        }
        if (opts.writeFolders != null) {
          // attenuation：写作用域收窄到声明白名单；cwd 是沙盒写根，必须一并收进白名单第一项。
          const nodeScope = resolveNodeFolderScope({
            writeFolders: opts.writeFolders,
            parentFolderScope: parentFolderScope || null,
          });
          isoOpts.cwd = nodeScope.cwd;
          isoOpts.workspaceFolders = nodeScope.workspaceFolders;
          isoOpts.authorizedFolders = nodeScope.authorizedFolders;
        }
        if (opts.model) isoOpts.model = opts.model;
        let nodeAgentId = isoOpts.agentId ?? null;
        if (opts.agentType) {
          if (typeof resolveAgentId !== "function") {
            throw new Error(`workflow agentType "${opts.agentType}" cannot be resolved in this environment.`);
          }
          const id = resolveAgentId(opts.agentType);
          if (!id) throw new Error(`workflow agentType "${opts.agentType}" was not found.`);
          isoOpts.agentId = id;
          nodeAgentId = id;
        }
        if (opts.toolFilter) isoOpts.toolFilter = opts.toolFilter;

        // 节点级活动上报（→ workflow-tool → ActivityHub 子 entry，右侧 WorkflowCard 的每个 agent 节点行）。
        onAgentEvent({ phase: "start", nodeId, threadId, threadKind, label, agentId: nodeAgentId, phaseLabel: currentPhase });
        // 子 session 创建后回补稳定身份 + locator：ID 用于内部归属，path 用于实时流定位。
        isoOpts.onSessionReady = (sp, meta: any = {}) => onAgentEvent({
          phase: "session",
          nodeId,
          threadId,
          threadKind,
          childSessionId: typeof meta?.sessionId === "string" && meta.sessionId.trim() ? meta.sessionId.trim() : null,
          childSessionPath: sp,
        });

        const finalPrompt = opts.schema
          ? normalizedPrompt + "\n\n完成后必须调用一次 structured_output 工具，返回严格符合所需 schema 的结果。"
          : normalizedPrompt;

        const journalKey = journal ? WorkflowJournal.computeKey(normalizedPrompt, opts) : null;

        const limits = { ...DEFAULT_RUN_LIMITS, ...(runLimits || {}) };
        const maxRetries = Math.min(
          Number.isInteger(opts.retries) ? opts.retries : limits.nodeRetries,
          MAX_NODE_RETRIES,
        );

        /**
         * 一次尝试。节点级超时用独立 AbortController，链到父 signal 上：
         * 超时只杀这一个节点（可重试），父 abort 杀整条 run（不可重试）。
         * structured_output 工具每次尝试新建一份，否则失败尝试写进去的残留会被下一次读到。
         */
        const attemptOnce = async () => {
          const attemptIsoOpts = { ...isoOpts };
          let structured = null;
          if (opts.schema) {
            structured = createStructuredOutputTool(opts.schema);
            attemptIsoOpts.extraCustomTools = [...(isoOpts.extraCustomTools || []), structured.tool];
          }

          const nodeAbort = new AbortController();
          const onParentAbort = () => nodeAbort.abort();
          if (signal) signal.addEventListener("abort", onParentAbort, { once: true });
          const nodeTimer = setTimeout(() => nodeAbort.abort(), limits.nodeTimeoutMs);
          if (typeof (nodeTimer as any).unref === "function") (nodeTimer as any).unref();
          attemptIsoOpts.signal = nodeAbort.signal;

          try {
            let res;
            try {
              res = await executeIsolated(finalPrompt, attemptIsoOpts);
            } catch (err) {
              throw classifyNodeFailure(err, { signal, nodeAbort, nodeTimeoutMs: limits.nodeTimeoutMs });
            }
            if (res?.error) {
              throw classifyNodeFailure(
                new Error(`agent 失败: ${res.error}`),
                { signal, nodeAbort, nodeTimeoutMs: limits.nodeTimeoutMs },
              );
            }
            if (structured) {
              const out = structured.getResult();
              if (out === undefined) throw new Error("agent 未调用 structured_output 返回结构化结果");
              return out;
            }
            return res?.replyText ?? "";
          } finally {
            clearTimeout(nodeTimer);
            if (signal) signal.removeEventListener("abort", onParentAbort);
          }
        };

        let lastErr = null;
        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
          if (signal?.aborted) throw lastErr ?? new Error("workflow 已中止");
          try {
            const result = await attemptOnce();
            onAgentEvent({ phase: "done", nodeId, threadId, threadKind });
            if (journalKey) journal.record(seq, journalKey, result, "ok", { attempts: attempt });
            return result;
          } catch (err) {
            lastErr = err;
            const retryable = !signal?.aborted && attempt <= maxRetries && isRetryableNodeError(err);
            if (!retryable) {
              onAgentEvent({ phase: "fail", nodeId, threadId, threadKind });
              if (journalKey) journal.record(seq, journalKey, null, "error", { attempts: attempt, error: String((err as any)?.message || err) });
              throw err;
            }
            const delay = retryDelayMs(attempt);
            onProgress({
              type: "log",
              message: `节点 ${label || nodeId} 第 ${attempt} 次失败，${Math.round(delay / 1000)}s 后重试: ${String((err as any)?.message || err).slice(0, 120)}`,
            });
            await new Promise((r) => {
              const t = setTimeout(r, delay);
              if (typeof (t as any).unref === "function") (t as any).unref();
            });
          }
        }
        throw lastErr;
      });
    };

    return runtimeContract.trackAgentCall(
      { nodeId, promptPreview: normalizedPrompt.slice(0, 80) },
      startAgentNode,
    );
  }

  async function parallel(thunks) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "parallel", phaseLabel: currentPhase });
    try {
      const result = await Promise.all((thunks || []).map((thunk) =>
        Promise.resolve().then(thunk).catch(() => null)
      ));
      onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "parallel" });
      return result;
    } catch (err) {
      onAgentEvent({ phase: "fail", nodeId: stepNodeId, stepKind: "parallel" });
      throw err;
    }
  }

  async function pipeline(items, ...stages) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "pipeline", phaseLabel: currentPhase });
    try {
      const result = await Promise.all((items || []).map(async (item, index) => {
        let cur = item;
        for (const stage of stages) {
          try { cur = await stage(cur, item, index); }
          catch { return null; }
        }
        return cur;
      }));
      onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "pipeline" });
      return result;
    } catch (err) {
      onAgentEvent({ phase: "fail", nodeId: stepNodeId, stepKind: "pipeline" });
      throw err;
    }
  }

  // ── workflow 嵌套：子 workflow 共享 limiter / signal / budget，限一层 ──
  async function workflow(script, childArgs) {
    if (typeof deps.runWorkflow !== "function") {
      throw new Error("当前环境不支持 workflow 嵌套调用");
    }
    return deps.runWorkflow(script, childArgs);
  }

  function log(message) {
    const seq = ++nodeSeq;
    const stepNodeId = `step-${seq}`;
    const msg = String(message);
    onAgentEvent({ phase: "start", nodeId: stepNodeId, stepKind: "log", label: msg, phaseLabel: currentPhase });
    onAgentEvent({ phase: "done", nodeId: stepNodeId, stepKind: "log" });
    onProgress({ type: "log", message: msg });
  }
  function phase(title) {
    // 记住最近一次 phase 标题，作为后续 agent 节点的弱分组标签（best-effort，非契约）。
    currentPhase = String(title);
    onProgress({ type: "phase", title: currentPhase });
  }

  const api = { agent, parallel, pipeline, workflow, log, phase, budget, args };
  Object.defineProperty(api, WORKFLOW_RUNTIME_CONTRACT, {
    value: runtimeContract,
    enumerable: false,
  });
  return api;
}
