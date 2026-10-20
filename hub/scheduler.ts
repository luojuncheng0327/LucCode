/**
 * Scheduler — Heartbeat + Cron 调度（v2）
 *
 * Heartbeat：所有有 desk 的 agent 各自并行跑，不依赖焦点 agent
 * Cron：Studio 级任务列表统一调度，不随 active agent / workspace 切换而变化
 *
 * 通知策略：Automation 统一作为后台 Agent session 执行。
 * 固定通知和插件动作也会在迁移阶段包装成 Agent Run prompt。
 */

import fs from "fs";
import path from "path";
import { createHeartbeat } from "../lib/desk/heartbeat.ts";
import { createCronScheduler } from "../lib/desk/cron-scheduler.ts";
import { getAutomationExecutor } from "../lib/desk/automation-executors.ts";
import {
  automationExecutionScopeKey,
  normalizeAutomationExecutionContext,
} from "../lib/desk/automation-execution-context.ts";
import { getLocale, t } from "../lib/i18n.ts";
import { createFreshCompactDailyScheduler } from "../lib/fresh-compact/daily-scheduler.ts";
import { FreshCompactMaintainer } from "./fresh-compact-maintainer.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { WORKSPACE_OUTPUT_ROOT_DIRNAME } from "../shared/workspace-output.ts";
import { sessionLocatorKey } from "../core/session-manifest/path-normalizer.ts";

const log = createModuleLogger("scheduler");
const freshCompactLog = createModuleLogger("fresh-compact");

function scopedCronJobKey(job) {
  const studioId = typeof job?.studioId === "string" && job.studioId.trim()
    ? job.studioId.trim()
    : "missing-studio";
  const jobId = typeof job?.id === "string" && job.id.trim()
    ? job.id.trim()
    : "missing-job";
  return `${studioId}\u0000${jobId}`;
}

export class Scheduler {
  declare _cronScheduler: any;
  declare _executingJobs: any;
  declare _freshCompactMaintainer: any;
  declare _freshCompactScheduler: any;
  declare _heartbeats: any;
  declare _hub: any;
  /**
   * @param {object} opts
   * @param {import('./index.ts').Hub} opts.hub
   */
  constructor({ hub }) {
    this._hub = hub;
    this._heartbeats = new Map(); // agentId → heartbeat instance
    this._cronScheduler = null; // Studio CronScheduler
    this._executingJobs = new Map(); // Studio + jobId → AbortController（per-job 锁 + abort 控制）
    this._freshCompactMaintainer = new FreshCompactMaintainer({ hub });
    this._freshCompactScheduler = createFreshCompactDailyScheduler({
      runDaily: (opts) => this._freshCompactMaintainer.runDaily(opts),
      warn: (msg) => freshCompactLog.warn(msg),
    });
  }

  /** @returns {import('../core/engine.ts').LucEngine} */
  get _engine() { return this._hub.engine; }

  /** 获取某个 agent 的 heartbeat 实例 */
  getHeartbeat(agentId) {
    if (!agentId) return null;
    return this._heartbeats.get(agentId) ?? null;
  }

  /** 暴露 Studio cronScheduler（agentId 参数仅为兼容旧调用方） */
  getCronScheduler(agentId) {
    return this._cronScheduler ?? null;
  }

  // ──────────── 生命周期 ────────────

  start() {
    this.startHeartbeat();
    this._startStudioCron();
    this._freshCompactScheduler.start();
  }

  async stop() {
    this._freshCompactScheduler.stop();
    await this.stopHeartbeat();
    if (this._cronScheduler) {
      await this._cronScheduler.stop();
      this._cronScheduler = null;
    }
  }

  /** 兼容旧 agent 生命周期调用：Studio cron 只有一个 scheduler */
  startAgentCron(agentId) { this._startStudioCron(); }

  /** 为指定 agent 启动 heartbeat（公共 API，供 createAgent 等场景使用） */
  startAgentHeartbeat(agentId, agent) {
    this._startAgentHeartbeat(agentId, agent);
  }

  /** 兼容旧 agent 生命周期调用：删除 agent 不停止 Studio cron scheduler */
  async removeAgentCron(agentId) {
    return undefined;
  }

  /** 重建 heartbeat（支持指定 agentId 或全量） */
  async reloadHeartbeat(agentId) {
    if (agentId) {
      await this.stopHeartbeat(agentId);
      const agent = this._engine.getAgent(agentId);
      if (agent) this._startAgentHeartbeat(agentId, agent);
      return;
    }
    await this.stopHeartbeat();
    this.startHeartbeat();
  }

  startHeartbeat() {
    for (const [agentId, agent] of this._engine.agents || []) {
      this._startAgentHeartbeat(agentId, agent);
    }
  }

  _startAgentHeartbeat(agentId, agent) {
    if (this._heartbeats.has(agentId)) return; // 幂等

    const engine = this._engine;
    const hbInterval = agent.config?.desk?.heartbeat_interval;
    const masterEnabled = engine.getHeartbeatMaster() !== false;
    const hbEnabled = masterEnabled && (agent.config?.desk?.heartbeat_enabled === true);
    // per-agent workspace（fallback: 主 agent → ~/Desktop）
    const getWorkspace = () => engine.getHomeCwd(agentId);
    const hb = createHeartbeat({
      getDeskFiles: async () => {
        try {
          const dir = getWorkspace();
          if (!dir) return [];
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
          catch { return []; }
          const items = await Promise.all(
            entries
              .filter(e => !e.name.startsWith(".") && e.name !== WORKSPACE_OUTPUT_ROOT_DIRNAME)
              .map(async (e) => {
                const fp = path.join(dir, e.name);
                let mtime = 0;
                try { mtime = (await fs.promises.stat(fp)).mtimeMs; } catch {}
                return { name: e.name, isDir: e.isDirectory(), mtime };
              })
          );
          return items;
        } catch { return []; }
      },
      getWorkspacePath: getWorkspace,
      getAgentName: () => agent.agentName,
      registryPath: path.join(agent.deskDir, "jian-registry.json"),
      overwatchPath: path.join(agent.deskDir, "overwatch.md"),
      // 巡检/笺巡检不传 withMemory：executeIsolated 默认走 agent.systemPrompt，
      // 而该 cache 始终按 master 开关构建，与 per-session 开关解耦。
      // 用户关 master 时自动不带记忆；只关某个 session 的开关不影响这里。
      onBeat: (prompt, runTools: any = {}) => this._executeActivityForAgent(agentId, prompt, "heartbeat", null, {
        extraCustomTools: Array.isArray(runTools.customTools) ? runTools.customTools : [],
      }),
      onJianBeat: (prompt, cwd, runTools: any = {}) => {
        const isZh = getLocale().startsWith("zh");
        this._executeActivityForAgent(agentId, prompt, "heartbeat", `${isZh ? "笺" : "jian"}:${path.basename(cwd)}`, {
          cwd,
          extraCustomTools: Array.isArray(runTools.customTools) ? runTools.customTools : [],
        });
      },
      intervalMinutes: hbInterval,
      emitDevLog: (text, level) => engine.emitDevLog(text, level),
      locale: agent.config?.locale,
    });
    this._heartbeats.set(agentId, hb);
    if (hbEnabled) hb.start();
  }

  async stopHeartbeat(agentId?) {
    if (agentId) {
      const hb = this._heartbeats.get(agentId);
      if (hb) { await hb.stop(); this._heartbeats.delete(agentId); }
      return;
    }
    // 并行停止所有 heartbeat，减少总关闭时间
    await Promise.all([...this._heartbeats.values()].map(hb => hb.stop()));
    this._heartbeats.clear();
  }

  // ──────────── Studio Cron ────────────

  _startStudioCron() {
    if (this._cronScheduler) return;
    const engine = this._engine;
    const cronStore = engine.getStudioCronStore?.();
    if (!cronStore) return;

    const sched = createCronScheduler({
      cronStore,
      executeJob: (job) => this._executeCronJob(job),
      abortJob: (job) => {
        const key = scopedCronJobKey(job);
        const ac = this._executingJobs.get(key);
        if (ac) { ac.abort(); log.log(`cron abort ${job.studioId}/${job.id} (timeout)`); }
      },
      onJobDone: (job, result) => {
        this._hub.eventBus.emit(
          {
            type: "cron_job_done",
            studioId: job.studioId,
            jobId: job.id,
            label: job.label,
            agentId: job.actorAgentId,
            actorAgentId: job.actorAgentId,
            result,
          },
          null,
        );
      },
    } as any);
    this._cronScheduler = sched;
    sched.start();
    log.log("Studio cron 已启动");
  }

  // ──────────── 执行 ────────────

  async _executeCronJob(job) {
    const executor = getAutomationExecutor(job);
    if (executor.kind !== "agent_session") {
      throw new Error(`unsupported automation executor: ${executor.kind}`);
    }
    const actorAgentId = typeof job.actorAgentId === "string" && job.actorAgentId.trim()
      ? job.actorAgentId.trim()
      : null;
    if (!actorAgentId) {
      throw new Error(`cron job ${job.id} missing actorAgentId`);
    }
    if (executor.agentId !== actorAgentId) {
      throw new Error(`cron job ${job.id} executor does not match actorAgentId`);
    }
    if (!this._engine.getAgent?.(actorAgentId) || this._engine.isAgentDeleted?.(actorAgentId) === true) {
      throw new Error(`cron job ${job.id} actor is unavailable`);
    }
    if (
      !job.executionContext
      || job.executionContext.createdByAgentId !== actorAgentId
      || (
        executor.executionContext
        && automationExecutionScopeKey(executor.executionContext)
          !== automationExecutionScopeKey(job.executionContext)
      )
    ) {
      throw new Error(`cron job ${job.id} execution context does not match its actor`);
    }
    await this._executeCronJobForAgent(actorAgentId, job, executor);
    return { executorKind: "agent_session" };
  }

  /**
   * 执行某个 agent 的 cron 任务（active 或非 active 均可）
   * 同一 agent 同时只运行一个 cron，防止并发写冲突
   */
  async _executeCronJobForAgent(agentId, job, executor = getAutomationExecutor(job)) {
    // per-job 锁：同一 job 不并发，但同一 agent 的不同 job 可以并行
    const executionKey = scopedCronJobKey(job);
    if (this._executingJobs.has(executionKey)) {
      log.log(`cron 跳过 ${job.studioId}/${job.id}：上一次仍在执行`);
      const err = new Error(`cron job ${job.studioId}/${job.id} 仍在执行，跳过`);
      (err as any).skipped = true;
      throw err;
    }
    const ac = new AbortController();
    this._executingJobs.set(executionKey, ac);
    try {
      const isZh = getLocale().startsWith("zh");
      const promptBody = executor.prompt || job.prompt || "";
      const model = executor.model || job.model || undefined;
      const prompt = isZh
        ? [
            `[定时任务 ${job.id}: ${job.label}]`,
            "",
            "**注意：这是系统自动触发的定时任务，不是用户发来的。**",
            "**不要在执行过程中创建新的定时任务。**",
            "",
            promptBody,
          ].join("\n")
        : [
            `[Cron job ${job.id}: ${job.label}]`,
            "",
            "**Note: This is an automated cron job, NOT a user message.**",
            "**Do not create new cron jobs during execution.**",
            "",
            promptBody,
          ].join("\n");
      await this._executeActivityForAgent(agentId, prompt, "cron", job.label, {
        model,
        signal: ac.signal,
        ...this._cronExecutionOptions(job, executor),
      });
    } finally {
      this._executingJobs.delete(executionKey);
    }
  }

  _resolveCronExecutionScope(job, ctx, actorAgentId) {
    const sourceSessionId = typeof ctx.sourceSessionId === "string" && ctx.sourceSessionId.trim()
      ? ctx.sourceSessionId.trim()
      : null;
    if (!sourceSessionId) {
      const actorHome = this._engine.getHomeCwd?.(actorAgentId) || null;
      return {
        sessionId: null,
        sessionPath: null,
        cwd: actorHome,
        workspaceFolders: actorHome ? [actorHome] : [],
        authorizedFolders: [],
      };
    }
    const manifest = this._engine.getSessionManifest?.(sourceSessionId) || null;
    const currentPath = manifest?.currentLocator?.path || null;
    let locatorIsValid = false;
    try {
      locatorIsValid = manifest?.currentLocator?.type === "jsonl"
        && fs.statSync(currentPath).isFile()
        && sessionLocatorKey(currentPath) === manifest.currentLocator.key;
    } catch {
      locatorIsValid = false;
    }
    if (
      !manifest
      || manifest.lifecycle === "deleted"
      || manifest.health !== "ok"
      || !currentPath
      || !locatorIsValid
      || manifest.ownerAgentId !== actorAgentId
      || this._engine.getSessionIdForPath?.(currentPath) !== sourceSessionId
    ) {
      throw new Error(`cron job ${job.id} source session is unavailable or no longer belongs to its actor`);
    }
    const folderScope = this._engine.getSessionFolderScope?.(currentPath) || null;
    return {
      sessionId: sourceSessionId,
      sessionPath: currentPath,
      cwd: folderScope?.cwd ?? null,
      workspaceFolders: Array.isArray(folderScope?.workspaceFolders)
        ? folderScope.workspaceFolders
        : [],
      authorizedFolders: Array.isArray(folderScope?.authorizedFolders)
        ? folderScope.authorizedFolders
        : [],
    };
  }

  _cronExecutionOptions(job, executor = getAutomationExecutor(job)) {
    const actorAgentId = job.actorAgentId;
    const ctx = normalizeAutomationExecutionContext(
      job.executionContext,
      { actorAgentId },
    );
    const executionScope = this._resolveCronExecutionScope(job, ctx, actorAgentId);
    const effectiveContext = {
      ...ctx,
      cwd: executionScope.cwd,
      workspaceFolders: executionScope.workspaceFolders,
      authorizedFolders: executionScope.authorizedFolders,
      sourceSessionId: executionScope.sessionId,
      sourceSessionPath: executionScope.sessionPath,
    };
    const opts: any = {};
    if (executionScope.cwd) opts.cwd = executionScope.cwd;
    opts.workspaceFolders = executionScope.workspaceFolders;
    opts.authorizedFolders = executionScope.authorizedFolders;
    if (executionScope.sessionId) opts.parentSessionId = executionScope.sessionId;
    if (executionScope.sessionPath) opts.parentSessionPath = executionScope.sessionPath;
    if (ctx.notificationContext) opts.notificationContext = ctx.notificationContext;
    opts.permissionMode = this._engine.getAutomationPermissionMode?.() || "auto";
    opts.approvalPolicy = "deny_on_prompt";
    opts.allowHumanApproval = false;
    opts.permissionContext = {
      surface: "automation",
      automationJob: {
        studioId: job.studioId,
        id: job.id,
        actorAgentId,
        configRevision: job.configRevision,
        executionScopeKey: automationExecutionScopeKey(effectiveContext),
      },
    };
    return opts;
  }

  async _deliverActivityCompletionNotification({ entry, sessionPath }) {
    if (entry.type !== "cron" && entry.type !== "heartbeat") return;
    const engine = this._engine;
    const preferenceKey = entry.type === "cron" ? "scheduledTaskCompletion" : "patrolCompletion";
    const mode = engine.getNotificationPreferences?.()?.[preferenceKey];
    if (mode !== "when_unfocused" && mode !== "always") return;
    if (typeof engine.deliverNotification !== "function") return;

    const bodyKey = entry.type === "cron"
      ? (entry.status === "error"
          ? "notification.scheduledTaskCompletionFailedBody"
          : "notification.scheduledTaskCompletionBody")
      : (entry.status === "error"
          ? "notification.patrolCompletionFailedBody"
          : "notification.patrolCompletionBody");
    const completionIdentity = typeof sessionPath === "string" && sessionPath
      ? sessionPath
      : entry.id;
    try {
      await engine.deliverNotification({
        title: entry.agentName || "LucCode",
        body: t(bodyKey, { label: entry.label || entry.summary }),
        channels: ["desktop"],
        desktopFocusPolicy: mode,
        ...(typeof sessionPath === "string" && sessionPath ? { sessionPath } : {}),
        idempotencyKey: `activity-completion:${entry.type}:${entry.agentId}:${completionIdentity}`,
      }, {
        agentId: entry.agentId,
      });
    } catch (error) {
      log.warn(`${entry.type} completion notification failed: ${error?.message || error}`);
    }
  }

  /**
   * 执行活动（任意 agent，统一走 executeIsolated）
   */
  async _executeActivityForAgent(agentId, prompt, type, label, opts: any = {}) {
    const engine = this._engine;
    await engine.ensureAgentRuntime?.(agentId, {
      priority: "background",
      reason: type,
    });
    const agentDir = path.join(engine.agentsDir, agentId);
    const activityDir = path.join(agentDir, "activity");
    const startedAt = Date.now();
    const id = `${type === "heartbeat" ? "hb" : "cron"}_${startedAt}`;

    // 所有 agent 统一走 executeIsolated（支持 agentId + signal 参数）
    const { signal, ...restOpts } = opts;
    let result;
    try {
      result = await engine.executeIsolated(prompt, {
        agentId,
        persist: activityDir,
        signal,
        activityType: type,
        ...restOpts,
      });
    } catch (error) {
      const ag = engine.getAgent(agentId);
      await this._deliverActivityCompletionNotification({
        entry: {
          id,
          type,
          label: label || null,
          agentId,
          agentName: ag?.agentName || agentId,
          summary: label || (type === "heartbeat" ? "patrol" : "scheduled task"),
          status: "error",
        },
        sessionPath: null,
      });
      throw error;
    }
    const { sessionPath, error } = result;

    const finishedAt = Date.now();
    const failed = !!error;

    // 取 agentName（从长驻实例获取，fallback agentId）
    const ag = engine.getAgent(agentId);
    const agentName = ag?.agentName || agentId;

    // 生成摘要
    let summary = null;
    if (typeof sessionPath === "string" && sessionPath) {
      try {
        summary = await engine.summarizeActivity(sessionPath, undefined, { agentId });
      } catch {}
    }

    const entry = {
      id,
      type,
      label: label || null,
      agentId,
      agentName,
      startedAt,
      finishedAt,
      summary: (() => {
        const isZhS = getLocale().startsWith("zh");
        const hbLabel = isZhS ? "日常巡检" : "routine patrol";
        const cronLabel = isZhS ? "定时任务" : "cron job";
        const failSuffix = isZhS ? "执行失败" : "execution failed";
        if (failed) return `${label || (type === "heartbeat" ? hbLabel : cronLabel)} ${failSuffix}`;
        return summary || (type === "heartbeat" ? hbLabel : (label || cronLabel));
      })(),
      sessionFile: typeof sessionPath === "string" ? path.basename(sessionPath) : null,
      status: failed ? "error" : "done",
      error: error || null,
    };

    // 写入对应 agent 的 ActivityStore
    engine.getActivityStore(agentId).add(entry);

    // WS 广播
    this._hub.eventBus.emit({ type: "activity_update", activity: entry }, null);

    await this._deliverActivityCompletionNotification({ entry, sessionPath });

    if (failed) {
      const isZhR = getLocale().startsWith("zh");
      const reason = error || (isZhR ? "后台任务未生成 session" : "background task produced no session");
      engine.emitDevLog(`[${type}] ${label || "后台任务"} 失败: ${reason}`, "error");
      throw new Error(reason);
    }

    engine.emitDevLog(`活动记录: ${entry.summary}`, "heartbeat");
  }

}
