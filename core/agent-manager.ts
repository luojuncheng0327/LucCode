/**
 * AgentManager — 多 Agent 生命周期管理
 *
 * 从 Engine 提取，负责 agent 的扫描/初始化/创建/切换/删除。
 * 不持有 engine 引用，通过构造器注入依赖。
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import YAML from "js-yaml";
import { Agent } from "./agent.ts";
import { safeReadYAMLSync } from "../shared/safe-fs.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { clearConfigCache } from "../lib/memory/config-loader.ts";
import { hasCompiledMemory, writeCompiledMemorySnapshot } from "../lib/memory/compiled-memory-snapshot.ts";
import { t } from "../lib/i18n.ts";
import { ActivityStore } from "../lib/desk/activity-store.ts";
import { createHash } from "crypto";
import { readDirectoryLikeDirentsSync } from "../shared/link-aware-fs.ts";
import {
  generateAgentId as _generateAgentId,
  generateDescription,
} from "./llm-utils.ts";
import { findModel, parseModelRef } from "../shared/model-ref.ts";
import { DEFAULT_HEARTBEAT_INTERVAL_MINUTES } from "../shared/default-workspace.ts";
import { relativePathInsideBase } from "./message-utils.ts";
import { detachAgentFromBundles } from "../lib/skill-bundles/store.ts";
import { assertKnownYuan, getAgentConfigRepairState } from "./yuan-registry.ts";
import { assertValidAgentId, isValidAgentId } from "../shared/agent-id.ts";
import {
  PUBLIC_PERSONA_FILE_NAME,
  PUBLIC_PERSONA_TEMPLATE_DIR,
  resolvePersonaLocale,
  resolvePersonaSource,
} from "./persona-source.ts";

const log = createModuleLogger("agent-mgr");
const DELETED_AGENT_TOMBSTONE = ".deleted-agent.json";
const AGENT_AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

function readAgentAvatarState(avatarDir) {
  for (const ext of AGENT_AVATAR_EXTENSIONS) {
    const avatarPath = path.join(avatarDir, `agent.${ext}`);
    try {
      const stat = fs.statSync(avatarPath);
      if (!stat.isFile()) continue;
      return {
        hasAvatar: true,
        avatarRevision: `${stat.mtimeMs}-${stat.size}`,
      };
    } catch {
      continue;
    }
  }
  return { hasAvatar: false, avatarRevision: null };
}

function writeStartupLog(startupLog, message) {
  if (typeof startupLog === "function") {
    startupLog(message);
  } else if (typeof startupLog?.log === "function") {
    startupLog.log(message);
  }
}

function writeStartupError(startupLog, message) {
  if (typeof startupLog?.error === "function") {
    startupLog.error(message);
  } else {
    writeStartupLog(startupLog, message);
  }
}

function normalizeAgentPluginMeta(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ownerPluginId: null,
      visibility: "public",
    };
  }
  const ownerPluginId = typeof raw.ownerPluginId === "string" && raw.ownerPluginId.trim()
    ? raw.ownerPluginId.trim()
    : null;
  const visibility = typeof raw.visibility === "string" && raw.visibility.trim()
    ? raw.visibility.trim()
    : "public";
  return {
    ownerPluginId,
    visibility,
    ...(typeof raw.kind === "string" && raw.kind.trim() ? { kind: raw.kind.trim() } : {}),
  };
}

function agentMatchesListOptions(agent, options: any = {}) {
  const ownerPluginId = typeof options.ownerPluginId === "string" && options.ownerPluginId.trim()
    ? options.ownerPluginId.trim()
    : null;
  const includePluginPrivate = options.includePluginPrivate === true;
  const plugin = normalizeAgentPluginMeta(agent?.plugin);
  if (ownerPluginId && plugin.ownerPluginId !== ownerPluginId) return false;
  if (
    (plugin.visibility === "plugin_private" || plugin.visibility === "private")
    && !includePluginPrivate
    && plugin.ownerPluginId !== ownerPluginId
  ) {
    return false;
  }
  return true;
}

// 与 Agent.resolveLocale() 同一条链条：config.locale（显式覆盖）→ 全局 prefs
// 的 locale → "en"。这里没有 Agent 实例，globalLocale 由调用方（_scanAgentList）
// 传入 engine.getLocale() 的结果，读不到时按 resolveLocale 的末端语义落 "en"。
function fallbackUserNameForLocale(locale, globalLocale = "") {
  const effective = locale || globalLocale || "en";
  return String(effective).startsWith("zh") ? "用户" : "User";
}

function renderIdentityTemplateForList(identityMd, cfg, agentId, globalLocale = "", globalUserName = "") {
  const agentName = cfg?.agent?.name || agentId;
  // 与 Agent.resolveUserName() 同一条链条：全局 prefs 的 userName → 按语言兜底。
  // 不读 agent config 的 user.name，否则列表里显示的称呼会和 agent 实际用的
  // 那个对不上。
  const userName = globalUserName || fallbackUserNameForLocale(cfg?.locale, globalLocale);
  return String(identityMd || "")
    .replace(/\{\{userName\}\}/g, userName)
    .replace(/\{\{agentName\}\}/g, agentName)
    .replace(/\{\{agentId\}\}/g, agentId);
}

export class AgentManager {
  declare _activeAgentId: any;
  declare _activityStores: any;
  declare _agentListCache: any;
  declare _agents: any;
  declare _d: any;
  declare _descRefreshPending: any;
  declare _memoryMaintenanceConcurrency: any;
  declare _memoryMaintenanceQueue: any;
  declare _memoryMaintenanceQueued: any;
  declare _memoryMaintenanceRunning: any;
  declare _invalidAgentIdsWarned: any;
  declare _runtimeInitConcurrency: any;
  declare _runtimeInitPromises: any;
  declare _runtimeInitQueue: any;
  declare _runtimeInitRunning: any;
  declare _switchQueue: any;
  /**
   * @param {object} deps
   * @param {string} deps.agentsDir
   * @param {string} deps.productDir
   * @param {string} deps.userDir
   * @param {string} deps.channelsDir
   * @param {() => import('./preferences-manager.ts').PreferencesManager} deps.getPrefs
   * @param {() => import('./model-manager.ts').ModelManager} deps.getModels
   * @param {() => object|null} deps.getHub
   * @param {() => import('./skill-manager.ts').SkillManager} deps.getSkills
   * @param {() => object} deps.getSearchConfig
   * @param {() => object} deps.resolveUtilityConfig
   * @param {() => Promise<object>} deps.resolveUtilityConfigFresh
   * @param {() => object} deps.getSharedModels
   * @param {() => import('./channel-manager.ts').ChannelManager} deps.getChannelManager
   * @param {() => import('./session-coordinator.ts').SessionCoordinator} deps.getSessionCoordinator
   */
  constructor(deps) {
    this._d = deps;
    this._agents = new Map();
    this._activeAgentId = null;
    this._switchQueue = Promise.resolve();
    this._activityStores = new Map();
    this._agentListCache = null;       // { raw: [{id,name,yuan,identity}], ts: number }
    this._descRefreshPending = false;
    this._runtimeInitPromises = new Map();
    this._runtimeInitQueue = [];
    this._runtimeInitRunning = 0;
    this._runtimeInitConcurrency = 2;
    this._memoryMaintenanceQueue = [];
    this._memoryMaintenanceQueued = new Set();
    this._memoryMaintenanceRunning = 0;
    this._memoryMaintenanceConcurrency = 1;
    this._invalidAgentIdsWarned = new Set();
  }

  /** 清除 listAgents 缓存（agent 增删改时调用） */
  invalidateAgentListCache() { this._agentListCache = null; }

  /**
   * 用户改名后让所有在内存里的 agent 立刻改口（全局 userName 变更时调用）。
   *
   * 名字的正源在全局 preferences，但每个 Agent 实例把解析结果缓存在
   * agent.userName 上（prompt、MOOD 模板、花名册都读它）。只写 prefs 不刷新，
   * 已加载的 agent 会一直用旧称呼直到重启。持有显式覆盖的 agent 重新解析后
   * 仍然拿到自己的覆盖值，不受影响。
   */
  refreshResolvedUserNames() {
    for (const [id, agent] of this._agents) {
      try {
        agent.userName = agent.resolveUserName();
      } catch (err) {
        log.warn(`refresh userName for ${id} failed: ${err?.message || err}`);
      }
    }
    this.invalidateAgentListCache();
    this._rebuildAllAgentSystemPrompts();
  }

  /** 重建所有已初始化 agent 的 _systemPrompt（花名册变更时调用） */
  _rebuildAllAgentSystemPrompts() {
    for (const [id, agent] of this._agents) {
      if (!agent.runtimeInitialized) continue;
      try {
        agent._systemPrompt = agent.buildSystemPrompt({
          forceMemoryEnabled: agent._memoryMasterEnabled,
        });
      } catch (err) {
        log.warn(`rebuild systemPrompt for ${id} failed: ${err?.message || err}`);
      }
    }
  }

  get agents() { return this._agents; }
  get activeAgentId() { return this._activeAgentId; }
  set activeAgentId(id) { this._activeAgentId = id; }
  get switching() { return this._switchQueue !== Promise.resolve(); }

  /** 当前焦点 agent */
  get agent() { return this._agents.get(this._activeAgentId); }

  /** 按 ID 获取 agent */
  getAgent(agentId) { return this._agents.get(agentId) || null; }

  _deletedAgentTombstonePath(agentId) {
    return path.join(this._d.agentsDir, agentId, DELETED_AGENT_TOMBSTONE);
  }

  _readDeletedAgentInfo(agentId) {
    const agentDir = path.join(this._d.agentsDir, agentId);
    const tombstonePath = this._deletedAgentTombstonePath(agentId);
    if (!fs.existsSync(tombstonePath)) return null;
    let tombstone: any = {};
    try {
      tombstone = JSON.parse(fs.readFileSync(tombstonePath, "utf-8"));
    } catch {}
    let cfg: any = {};
    try {
      cfg = safeReadYAMLSync(path.join(agentDir, "config.yaml"), {}, YAML);
    } catch {}
    const name = tombstone.agentName || cfg.agent?.name || agentId;
    return {
      id: agentId,
      name,
      agentName: name,
      yuan: tombstone.yuan || cfg.agent?.yuan || "luc",
      deletedAt: tombstone.deletedAt || null,
    };
  }

  isAgentDeleted(agentId) {
    if (!agentId) return false;
    return !!this._readDeletedAgentInfo(agentId);
  }

  getDeletedAgentInfo(agentId) {
    if (!agentId) return null;
    return this._readDeletedAgentInfo(agentId);
  }

  // ── Activity Store（per-agent 懒缓存） ──

  get activityStores() { return this._activityStores; }

  getActivityStore(agentId) {
    let store = this._activityStores.get(agentId);
    if (!store) {
      const agDir = path.join(this._d.agentsDir, agentId);
      store = new ActivityStore(
        path.join(agDir, "desk", "activities.json"),
        path.join(agDir, "activity"),
      );
      this._activityStores.set(agentId, store);
    }
    return store;
  }

  // ── Init ──

  async initAllAgents(log, startId) {
    this._activeAgentId = startId;

    const entries = this._scanAgentDirs();
    const ids = new Set([this._activeAgentId, ...entries.map(e => e.name)].filter(Boolean));
    for (const agentId of ids) {
      await this._loadAgentConfigOnly(agentId, { required: agentId === this._activeAgentId });
    }

    let activeRuntimeReady = false;
    // 焦点 agent 先初始化 — 失败不阻塞启动，让用户能进应用修配置
    try {
      await this.ensureAgentRuntime(this._activeAgentId, {
        log,
        priority: "foreground",
        reason: "startup",
      });
      activeRuntimeReady = true;
    } catch (err) {
      writeStartupError(log, `焦点 agent "${this._activeAgentId}" init 失败: ${err.message}`);
      if (err.stack) writeStartupError(log, err.stack);
      // 仍然创建实例放入 map，让应用能启动。
      // 关键：必须至少把 config 加载进来，否则 agent.config.models.chat 读不到，
      // 下游会误判为"没配模型"，触发 session 创建跳过 / 记忆系统未启动等连锁崩溃（#414）。
      if (!this._agents.has(this._activeAgentId)) {
        await this._loadAgentConfigOnly(this._activeAgentId, { required: true });
      }
    }

    writeStartupLog(log, `[init] ${this._agents.size} 个 agent 已加载配置，焦点 runtime ${activeRuntimeReady ? "已就绪" : "待修复"}`);
  }

  async _loadAgentConfigOnly(agentId, { required = false } = {}) {
    assertValidAgentId(agentId);
    if (this._agents.has(agentId)) return this._agents.get(agentId);
    if (this.isAgentDeleted(agentId)) {
      if (required) throw new Error(`agent "${agentId}" has been deleted`);
      return null;
    }

    const ag = this._createAgentInstance(agentId, () => ({}));
    ag.setGetOwnerIds(this._makeOwnerIdsFn(ag));
    try {
      ag.loadConfigOnly();
    } catch (err) {
      log.error(`agent "${agentId}" config load 失败: ${err.message}`);
      if (!required) return null;
    }
    this._registerAgent(agentId, ag);
    return ag;
  }

  async ensureAgentRuntime(agentId, options: any = {}) {
    if (!agentId) throw new Error("ensureAgentRuntime: agentId is required");
    let ag = this._agents.get(agentId);
    if (!ag) {
      ag = await this._loadAgentConfigOnly(agentId, { required: true });
    }
    if (!ag) throw new Error(t("error.agentNotFound", { id: agentId }));
    if (ag.runtimeInitialized === true) return ag;

    const existing = this._runtimeInitPromises.get(agentId);
    if (existing) return existing;

    const promise = new Promise((resolve, reject) => {
      this._runtimeInitQueue.push({
        agentId,
        priority: options.priority === "foreground" ? 0 : 1,
        log: options.log || (() => {}),
        resolve,
        reject,
      });
      this._pumpRuntimeInitQueue();
    });
    this._runtimeInitPromises.set(agentId, promise);
    return promise;
  }

  _pumpRuntimeInitQueue() {
    while (this._runtimeInitRunning < this._runtimeInitConcurrency && this._runtimeInitQueue.length) {
      this._runtimeInitQueue.sort((a, b) => a.priority - b.priority);
      const task = this._runtimeInitQueue.shift();
      this._runtimeInitRunning++;
      this._runRuntimeInitTask(task)
        .then(task.resolve, task.reject)
        .finally(() => {
          this._runtimeInitRunning--;
          this._runtimeInitPromises.delete(task.agentId);
          this._pumpRuntimeInitQueue();
        });
    }
  }

  async _runRuntimeInitTask(task) {
    const ag = this._agents.get(task.agentId);
    if (!ag) throw new Error(t("error.agentNotFound", { id: task.agentId }));
    if (ag.runtimeInitialized === true) return ag;
    if (typeof ag.init !== "function") return ag;

    const sharedModels = this._d.getSharedModels?.() || {};
    const resolveModel = (bareId) =>
      this._d.getModels().resolveModelWithCredentials(bareId);
    const resolveModelFresh = (bareId) =>
      this._d.getModels().resolveModelWithCredentialsFresh(bareId);
    await ag.init(task.log, sharedModels, resolveModel, resolveModelFresh);
    this._d.getSkills()?.syncAgentSkills?.(ag);
    this._d.getHub()?.scheduler?.startAgentHeartbeat?.(task.agentId, ag);
    return ag;
  }

  scheduleAgentMemoryMaintenance(agentId, reason = "manual", agentRef = null) {
    if (!agentId || this._memoryMaintenanceQueued.has(agentId)) return;
    this._memoryMaintenanceQueued.add(agentId);
    this._memoryMaintenanceQueue.push({ agentId, reason, agentRef });
    this._pumpMemoryMaintenanceQueue();
  }

  _pumpMemoryMaintenanceQueue() {
    while (this._memoryMaintenanceRunning < this._memoryMaintenanceConcurrency && this._memoryMaintenanceQueue.length) {
      const task = this._memoryMaintenanceQueue.shift();
      this._memoryMaintenanceRunning++;
      this._runMemoryMaintenanceTask(task)
        .catch((err) => {
          log.error(`记忆后台维护出错 (${task.agentId}, ${task.reason}): ${err.message}`);
        })
        .finally(() => {
          this._memoryMaintenanceQueued.delete(task.agentId);
          this._memoryMaintenanceRunning--;
          this._pumpMemoryMaintenanceQueue();
        });
    }
  }

  async _runMemoryMaintenanceTask({ agentId, agentRef }) {
    const ag = agentRef || this._agents.get(agentId);
    if (ag?.runtimeInitialized !== true || !ag.memoryTicker) return;
    await ag.memoryTicker.tick();
  }

  // ── List ──

  static AGENT_LIST_TTL = 30_000; // 30 秒

  listAgents(options: any = {}) {
    const now = Date.now();
    if (!this._agentListCache || now - this._agentListCache.ts > AgentManager.AGENT_LIST_TTL) {
      this._agentListCache = { raw: this._scanAgentList(), ts: now };
    }

    const prefs = this._d.getPrefs();
    const primaryId = prefs.getPrimaryAgent();
    const order = prefs.getPreferences()?.agentOrder || [];

    let agents = this._agentListCache.raw.map(a => ({
      ...a,
      isPrimary: a.id === primaryId,
      isCurrent: a.id === this._activeAgentId,
    }));
    agents = agents.filter((agent) => agentMatchesListOptions(agent, options));

    if (order.length) {
      agents.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    }

    // lazy refresh：在返回列表后，异步刷新缺少 description 的 agent（每次最多 1 个）
    if (!this._descRefreshPending) {
      const needsRefresh = agents.find(a => !this._hasDescription(a.id));
      if (needsRefresh) {
        this._descRefreshPending = true;
        this._refreshDescription(needsRefresh.id)
          .catch(() => {})
          .finally(() => { this._descRefreshPending = false; });
      }
    }

    return agents;
  }

  listDeletedAgents() {
    const entries = this._scanDeletedAgentDirs();
    return entries
      .map((entry) => this._readDeletedAgentInfo(entry.name))
      .filter(Boolean);
  }

  /**
   * 团队花名册唯一事实源：返回未删除、config 可用的 agent 轻量条目。
   * system prompt Team 区块、subagent 发现、DM、workflow、channel 工具
   * 都通过注入的回调消费这份列表，禁止在 Agent 内部私扫 agentsDir（#1657 / #1633）。
   */
  listActiveAgentsForRoster() {
    try {
      return this._scanAgentDirs().map((entry) => this._readRosterEntry(entry.name));
    } catch {
      return [];
    }
  }

  _readRosterEntry(agentId) {
    const dir = path.join(this._d.agentsDir, agentId);
    try {
      const cfg = safeReadYAMLSync(path.join(dir, "config.yaml"), {}, YAML);
      const chatRef = cfg.models?.chat;
      const model = typeof chatRef === "object"
        ? String(chatRef?.id || "")
        : String(chatRef || "");
      let summary = "";
      try {
        summary = fs.readFileSync(path.join(dir, "description.md"), "utf-8")
          .split("\n")
          .filter((l) => !l.trim().startsWith("<!--"))
          .join("\n")
          .trim();
      } catch {}
      return { id: agentId, name: cfg.agent?.name || agentId, summary, model };
    } catch {
      return { id: agentId, name: agentId, summary: "", model: "" };
    }
  }

  /** 扫盘读取所有 agent 元数据（I/O 密集，由缓存保护） */
  _scanAgentList() {
    const entries = readDirectoryLikeDirentsSync(this._d.agentsDir);
    // 每个 agent 都可能没有 config.locale，统一在扫描开始时读一次全局 prefs 的
    // locale 作为兜底，而不是每个 agent 各查一次。
    const globalLocale = this._d.getEngine?.()?.getLocale?.() || "";
    // 用户名同理：正源在全局 prefs，扫描开始时读一次给所有 agent 兜底。
    const globalUserName = this._d.getEngine?.()?.getUserName?.() || "";
    const agents = [];
    for (const entry of entries) {
      if (!this._acceptDiscoveredAgentId(entry.name)) continue;
      if (this.isAgentDeleted(entry.name)) continue;
      const configPath = path.join(this._d.agentsDir, entry.name, "config.yaml");
      if (!fs.existsSync(configPath)) continue;
      try {
        const cfg = safeReadYAMLSync(configPath, {}, YAML);
        let identity = "";
        try {
          // identity.md 不再保证落盘（惰性材料化）：没有活跃 Agent 实例可用时，
          // 直接用 core/persona-source.ts 的同一条回落链现读，未定制 agent 在
          // 花名册里必须显示其实际生效的模板摘要，不能空白。
          const { content: idMd } = resolvePersonaSource({
            agentDir: path.join(this._d.agentsDir, entry.name),
            productDir: this._d.productDir,
            yuanType: cfg.agent?.yuan || "luc",
            locale: resolvePersonaLocale(cfg.locale, globalLocale),
            kind: "identity",
          });
          const renderedIdMd = renderIdentityTemplateForList(idMd, cfg, entry.name, globalLocale, globalUserName);
          const lines = renderedIdMd.split("\n").filter(l => l.trim() && !l.startsWith("#"));
          identity = lines[0]?.trim() || "";
        } catch {}
        const avatarState = readAgentAvatarState(
          path.join(this._d.agentsDir, entry.name, "avatars"),
        );
        const chatRef = cfg.models?.chat;
        const chatModel = typeof chatRef === "object"
          ? { id: chatRef.id, provider: chatRef.provider }
          : (chatRef ? { id: chatRef } : null);
        const repairState = getAgentConfigRepairState(cfg, this._d.productDir);
        agents.push({
          id: entry.name,
          name: cfg.agent?.name || entry.name,
          yuan: cfg.agent?.yuan || "luc",
          plugin: normalizeAgentPluginMeta(cfg.plugin),
          needsRepair: !!repairState,
          repairState,
          identity,
          hasAvatar: avatarState.hasAvatar,
          avatarRevision: avatarState.avatarRevision,
          chatModel,
          homeFolder: cfg.desk?.home_folder || null,
          memoryMasterEnabled: cfg.memory?.enabled !== false,
        });
      } catch {}
    }
    return agents;
  }

  /** 检查 description.md 是否存在 */
  _hasDescription(agentId) {
    try {
      fs.accessSync(path.join(this._d.agentsDir, agentId, "description.md"));
      return true;
    } catch { return false; }
  }

  /**
   * 异步刷新 agent 的 description.md
   * 通过 hash 比对 descriptionSource + yuan 类型，变化时调用 LLM 重新生成。
   */
  async _refreshDescription(agentId) {
    try {
      const ag = this._agents.get(agentId);
      if (!ag) return;

      const source = ag.descriptionSource || ag.personality;
      const yuan = ag.config?.agent?.yuan || "luc";
      const hash = createHash("sha256").update(source + "\n" + yuan).digest("hex");

      const descPath = path.join(this._d.agentsDir, agentId, "description.md");

      // 读取已有 hash
      try {
        const firstLine = fs.readFileSync(descPath, "utf-8").split("\n")[0].trim();
        const match = firstLine.match(/^<!--\s*sourceHash:\s*(\S+)\s*-->$/);
        if (match?.[1] === hash) return; // 没变化，跳过
      } catch {} // 文件不存在，继续生成

      const utilConfig = await this._d.resolveUtilityConfigFresh({ agentId });
      const locale = ag.resolveLocale();
      const desc = await generateDescription(utilConfig, source, locale);
      if (!desc) {
        log.log(`[description] ${agentId}: 生成跳过（LLM 不可用或返回空）`);
        return;
      }

      fs.writeFileSync(descPath, `<!-- sourceHash: ${hash} -->\n${desc}`, "utf-8");
      log.log(`[description] ${agentId}: 已更新`);
    } catch (err) {
      log.warn(`_refreshDescription(${agentId}) failed: ${err.message}`);
    }
  }

  // ── Create ──

  /**
   * Best-effort rollback of createAgent's partial state.
   * Called when any step between fs.mkdirSync and this._agents.set fails.
   * All cleanup is wrapped in try/catch so a cleanup failure doesn't mask
   * the original error.
   */
  async _rollbackAgentCreation(agentDir, agentId) {
    try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch {}
    try { await this._d.getChannelManager().cleanupAgentFromChannels(agentId); } catch {}
  }

  async createAgent({ name, id, yuan, enabledSkills, initialFiles, avatarPath, initialMemory }) {
    if (!name?.trim()) throw new Error(t("error.agentNameEmpty"));

    const hasExplicitId = id !== undefined && id !== null;
    if (hasExplicitId) assertValidAgentId(id);
    const agentId = hasExplicitId ? id : await this._generateAgentId(name);
    // Generated IDs are trusted only after the same central contract check.
    // This catches a future generator regression before any filesystem write.
    assertValidAgentId(agentId);
    const agentDir = path.join(this._d.agentsDir, agentId);

    if (fs.existsSync(agentDir)) {
      throw new Error(t("error.agentAlreadyExists", { id: agentId }));
    }

    const yuanType = assertKnownYuan(this._d.productDir, yuan || "luc");

    // 创建目录结构
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });

    // 从模板复制 config.yaml
    const templateConfig = fs.readFileSync(path.join(this._d.productDir, "config.example.yaml"), "utf-8");
    const currentAgent = this.agent;
    const configSeed = YAML.load(templateConfig);
    if (!configSeed || typeof configSeed !== "object" || Array.isArray(configSeed)) {
      throw new Error("Invalid config.example.yaml");
    }
    const config = configSeed;
    config.agent = { ...(config.agent || {}), name: name.trim(), yuan: yuanType };
    config.memory = {
      ...(config.memory || {}),
      enabled: true,
    };
    config.desk = {
      ...(config.desk || {}),
      heartbeat_enabled: false,
      heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
    };
    // 不往新 agent 的 config 里抄用户名：名字的正源是全局 preferences，
    // 每个 agent 各存一份就会在用户改名后留下一堆对不上的旧副本。
    delete config.user;
    // migration #5 之后 models.chat 的唯一合法持久化格式是 {id, provider}。
    // 新建 agent 时必须直接写完整复合键，不能再把旧字符串格式重新带回磁盘。
    const chatRef = parseModelRef(currentAgent?.config?.models?.chat);
    const defaultModel = this._d.getModels().defaultModel;
    const inheritedChat = (chatRef?.id && chatRef.provider)
      ? { id: chatRef.id, provider: chatRef.provider }
      : (defaultModel?.id && defaultModel?.provider)
        ? { id: defaultModel.id, provider: defaultModel.provider }
        : null;
    if (inheritedChat) {
      config.models = { ...(config.models || {}), chat: inheritedChat };
    }
    fs.writeFileSync(
      path.join(agentDir, "config.yaml"),
      YAML.dump(config, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"' }),
      "utf-8",
    );

    // identity.md / AGENTS.md 不再在创建 agent 时播种落盘（惰性材料化）：
    // 缺失时运行时按 agent.resolveLocale() 现选 lib 模板（core/persona-source.ts
    // 的 resolvePersonaSource，与 core/agent.ts personality getter 同一条回落
    // 链），用户日后改语言，未定制人格自动跟着换。文件只在用户于设置页编辑
    // 保存时才落盘。AGENTS.public.md 的消费侧（Agent._readPublicAgentsMd）本来
    // 就有独立回落链，不受此改动影响，这里继续按原策略播种。
    const isZh = String(
      currentAgent?.resolveLocale?.() || this._d.getEngine?.()?.getLocale?.() || "en"
    ).startsWith("zh");
    const langDir = isZh ? "" : "en/";
    const firstExisting = (paths) => paths.find((p) => fs.existsSync(p));

    // AGENTS.public.md（对外人格模板）
    const publicAgentsSrc = firstExisting([
      path.join(this._d.productDir, PUBLIC_PERSONA_TEMPLATE_DIR, `${langDir}${yuanType}.md`),
      path.join(this._d.productDir, PUBLIC_PERSONA_TEMPLATE_DIR, `${yuanType}.md`),
    ]);
    if (publicAgentsSrc) {
      fs.copyFileSync(publicAgentsSrc, path.join(agentDir, PUBLIC_PERSONA_FILE_NAME));
    }

    if (initialFiles && typeof initialFiles === "object") {
      const fileMap = {
        identity: "identity.md",
        agents: "AGENTS.md",
        publicAgents: PUBLIC_PERSONA_FILE_NAME,
      };
      for (const [key, fileName] of Object.entries(fileMap)) {
        if (typeof initialFiles[key] === "string") {
          fs.writeFileSync(path.join(agentDir, fileName), initialFiles[key], "utf-8");
        }
      }
    }

    if (avatarPath) {
      const ext = path.extname(avatarPath).toLowerCase();
      const avatarExt = ext === ".jpeg" ? ".jpg" : ext;
      if (![".png", ".jpg", ".webp"].includes(avatarExt)) {
        await this._rollbackAgentCreation(agentDir, agentId);
        throw new Error("Unsupported avatar image type");
      }
      try {
        fs.copyFileSync(avatarPath, path.join(agentDir, "avatars", `agent${avatarExt}`));
      } catch (err) {
        await this._rollbackAgentCreation(agentDir, agentId);
        throw err;
      }
    }

    // 可选文件：确保存在（即使为空），避免运行时 ENOENT
    const touchIfMissing = (p) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
    touchIfMissing(path.join(agentDir, 'pinned.md'));

    if (initialMemory?.compiled && hasCompiledMemory(initialMemory.compiled)) {
      try {
        writeCompiledMemorySnapshot(path.join(agentDir, "memory"), initialMemory.compiled, {
          source: initialMemory.source || "character-card",
          sourceId: initialMemory.sourceId || `agent-create-${agentId}`,
          sourcePackage: initialMemory.sourcePackage || null,
        });
      } catch (err) {
        await this._rollbackAgentCreation(agentDir, agentId);
        throw err;
      }
    }

    // 频道系统
    try {
      await this._d.getChannelManager().setupChannelsForNewAgent(agentId);
    } catch (err) {
      await this._rollbackAgentCreation(agentDir, agentId);
      throw err;
    }

    // 初始化并加入长驻 Map
    const ag = this._createAgentInstance(agentId, () => ({}));
    ag.setGetOwnerIds(this._makeOwnerIdsFn(ag));
    const resolveModel = (bareId) =>
      this._d.getModels().resolveModelWithCredentials(bareId);
    const resolveModelFresh = (bareId) =>
      this._d.getModels().resolveModelWithCredentialsFresh(bareId);
    try {
      await ag.init(() => {}, this._d.getSharedModels(), resolveModel, resolveModelFresh);
    } catch (err) {
      // init 失败：回滚已创建的目录和频道状态，防止孤儿残留
      await this._rollbackAgentCreation(agentDir, agentId);
      throw err;
    }
    // #419: 普通新建 agent 继承当前已装 user/SDK skill 快照;空快照时保留 template 默认。
    // 角色卡导入会传入显式 enabledSkills,此时必须只启用包内技能。
    const hasEnabledOverride = Array.isArray(enabledSkills);
    const nextEnabled = hasEnabledOverride
      ? enabledSkills
      : this._d.getSkills().computeDefaultEnabledForNewAgent();
    if (hasEnabledOverride || nextEnabled.length > 0) {
      try {
        ag.updateConfig({ skills: { enabled: nextEnabled } });
        this._d.getSkills().syncAgentSkills(ag);
      } catch (err) {
        await this._rollbackAgentCreation(agentDir, agentId);
        throw err;
      }
    }
    this._registerAgent(agentId, ag);

    // 启动 cron + heartbeat
    const hub = this._d.getHub();
    hub?.scheduler?.startAgentCron(agentId);
    const newAgent = this._agents.get(agentId);
    if (newAgent) {
      hub?.scheduler?.startAgentHeartbeat?.(agentId, newAgent);
    }

    // 注入 DM 回调
    const dmRouter = hub?.dmRouter;
    if (dmRouter) {
      ag.setDmSentHandler((fromId, toId) => dmRouter.handleNewDm(fromId, toId));
    }

    this.invalidateAgentListCache();
    this._rebuildAllAgentSystemPrompts();
    log.log(`创建助手: ${name} (${agentId})`);
    return { id: agentId, name: name.trim() };
  }

  // ── Switch ──

  /**
   * 仅切换 agent 指针（不创建 session）。排队执行，不会并发。
   * SessionCoordinator.switchSession 跨 agent 时调用此方法。
   */
  async switchAgentOnly(agentId) {
    return this._enqueueSwitch(() => this._doSwitchAgentOnly(agentId));
  }

  /**
   * 完整切换：切 agent 指针 + 恢复调度 + 同步 skills + 创建 session。
   * 排队执行，快速连续切换会按序落到最终目标。
   */
  async switchAgent(agentId) {
    return this._enqueueSwitch(() => this._doSwitchAgent(agentId));
  }

  /** Promise 链互斥：所有切换操作排队执行，前一个失败不阻塞后续 */
  _enqueueSwitch(fn) {
    const queued = this._switchQueue.catch(() => {}).then(fn);
    this._switchQueue = queued;
    return queued;
  }

  // 纯切指针：不动 heartbeat / cron / channel。heartbeat 是 per-agent 闭包，
  // 与 _activeAgentId 解耦，跨 agent 跳转期间应持续运行。pause/resume 是
  // _doSwitchAgent 重建焦点 session 窗口期的保护措施，不属于这条路径。
  async _doSwitchAgentOnly(agentId) {
    if (!this._agents.has(agentId)) {
      throw new Error(t("error.agentNotFound", { id: agentId }));
    }
    const prevAgentId = this._activeAgentId;
    log.log(`switching agent to ${agentId}`);
    try {
      clearConfigCache();
      await this.ensureAgentRuntime(agentId, {
        priority: "foreground",
        reason: "switch",
      });
      this._activeAgentId = agentId;

      // migration #5 之后 models.chat 是 {id, provider}；
      // 若仍是字符串或缺 provider，说明 migration 未能推断（provider 被删除等），
      // 当作未配置处理，保留上一个 defaultModel 的状态。
      const chatRef = this.agent.config.models?.chat;
      const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
      const models = this._d.getModels();
      if (ref) {
        const model = findModel(models.availableModels, ref.id, ref.provider);
        if (!model) {
          // 带上码和状态，切换失败才能在路由边界保住语义：模型没了是用户改配置能解决的
          // 冲突（409），不是服务端故障（500）。少了这两个字段，上层只能压平成未知错误。
          const error: any = new Error(
            t("error.agentModelNotAvailable", { id: agentId, model: `${ref.provider}/${ref.id}` }),
          );
          error.code = "agent_model_not_available";
          error.status = 409;
          throw error;
        }
        models.defaultModel = model;
      } else if (chatRef) {
        log.warn(`switchAgent(${agentId}): models.chat 缺 provider (${JSON.stringify(chatRef)})，跳过默认模型设置`);
      }
      const effectiveModel = ref?.id || models.defaultModel?.id || "inherited";
      log.log(`agent switched to ${this.agent.agentName} (${agentId}), model=${effectiveModel}`);
    } catch (err) {
      this._activeAgentId = prevAgentId;
      throw err;
    }
  }

  async _doSwitchAgent(agentId) {
    const hub = this._d.getHub();
    const engine = this._d.getEngine?.();
    const previousCwd = engine?.cwd || null;
    // pause/resume 严格配对：try/finally 保证 resume 一定调到，
    // 包括 _doSwitchAgentOnly / syncAgentSkills / createSession 任一抛错的路径。
    await hub?.pauseForAgentSwitch();
    try {
      await this._doSwitchAgentOnly(agentId);
      this._d.getSkills().syncAgentSkills(this.agent);
      const homeFolder = engine?.getExplicitHomeCwd?.(agentId) || null;
      const nextCwd = homeFolder || previousCwd || engine?.getHomeCwd?.(agentId) || undefined;
      const sessionResult = await this._d.getSessionCoordinator().createSession(null, nextCwd);
      const cwd = sessionResult?.session?.sessionManager?.getCwd?.() || nextCwd || null;
      log.log(`已切换到助手: ${this.agent.agentName} (${agentId})`);
      return {
        ...sessionResult,
        cwd,
        homeFolder,
      };
    } finally {
      hub?.resumeAfterAgentSwitch();
    }
  }

  async createSessionForAgent(agentId, cwd, memoryEnabled = true, model = null, opts: any = {}) {
    if (agentId && agentId !== this._activeAgentId) {
      await this.switchAgentOnly(agentId);
    }
    return this._d.getSessionCoordinator().createSession(null, cwd, memoryEnabled, model, opts);
  }

  // ── Delete ──

  async deleteAgent(agentId) {
    let replacementAgentId = null;
    let replacementSwitchResult = null;
    if (agentId === this._activeAgentId) {
      replacementAgentId = this._replacementAgentIdForDeletion(agentId);
      if (!replacementAgentId) {
        throw new Error("cannot delete the last agent");
      }
      replacementSwitchResult = await this.switchAgent(replacementAgentId);
    }

    const agentDir = path.join(this._d.agentsDir, agentId);
    if (!fs.existsSync(agentDir)) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }
    if (this.isAgentDeleted(agentId)) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }

    const ag = this._agents.get(agentId);
    this._d.getHub()?.abortAgentPhoneSessions?.("agent-deleted", { agentId });
    try {
      await this._d.getSessionCoordinator()?.discardSessionsForAgent?.(agentId, "agent deleted");
    } catch (err) {
      log.warn(`session runtime cleanup failed before deleting agent (${agentId}): ${err.message}`);
    }
    if (ag) {
      this._agents.delete(agentId);
      this._activityStores.delete(agentId);
      await this._d.getHub()?.scheduler?.removeAgentCron(agentId);
      await this._d.getHub()?.scheduler?.stopHeartbeat(agentId);
      await ag.dispose();
    }

    // 频道清理
    try {
      await this._d.getChannelManager().cleanupAgentFromChannels(agentId);
    } catch (err) {
      log.error(`频道清理失败 (${agentId}): ${err.message}`);
    }

    const tombstone = {
      version: 1,
      agentId,
      agentName: ag?.agentName || ag?.name || this._readAgentNameFromConfig(agentDir) || agentId,
      yuan: ag?.config?.agent?.yuan || this._readAgentYuanFromConfig(agentDir) || "luc",
      deletedAt: new Date().toISOString(),
    };
    await fsp.writeFile(
      this._deletedAgentTombstonePath(agentId),
      JSON.stringify(tombstone, null, 2),
      "utf-8",
    );

    try {
      this._d.getEngine?.()?.subagentThreads?.removeByAgentId?.(agentId);
    } catch (err) {
      log.warn(`subagent 线程账本清理失败 (${agentId}): ${err.message}`);
    }

    if (this._d.luccodeHome) {
      try {
        detachAgentFromBundles({ lucHome: this._d.luccodeHome }, agentId);
      } catch (err) {
        log.error(`Skill Bundle 解耦失败 (${agentId}): ${err.message}`);
      }
    }

    const prefs = this._d.getPrefs();
    const primaryId = prefs.getPrimaryAgent();
    if (primaryId === agentId) {
      prefs.savePrimaryAgent(this._activeAgentId);
    }

    const order = prefs.getPreferences()?.agentOrder || [];
    const newOrder = order.filter(id => id !== agentId);
    if (newOrder.length !== order.length) {
      const p = prefs.getPreferences();
      p.agentOrder = newOrder;
      prefs.savePreferences(p);
    }

    this.invalidateAgentListCache();
    this._rebuildAllAgentSystemPrompts();
    log.log(`已删除助手: ${agentId}`);
    return {
      ok: true,
      replacementAgentId,
      replacementSwitchResult,
    };
  }

  _replacementAgentIdForDeletion(agentId) {
    const prefs = this._d.getPrefs();
    const primaryId = prefs.getPrimaryAgent?.();
    const candidates = [
      ...new Set([
        ...[...this._agents.keys()],
        ...this._scanAgentDirs().map((entry) => entry.name),
      ]),
    ].filter((id) => id && id !== agentId && !this.isAgentDeleted(id));
    if (primaryId && candidates.includes(primaryId)) return primaryId;
    return candidates[0] || null;
  }

  // ── Utility ──

  setPrimaryAgent(agentId) {
    // Identity validation must precede path construction and preference I/O.
    assertValidAgentId(agentId);
    const agentDir = path.join(this._d.agentsDir, agentId);
    if (this.isAgentDeleted(agentId) || !fs.existsSync(path.join(agentDir, "config.yaml"))) {
      throw new Error(t("error.agentNotExists", { id: agentId }));
    }
    this._d.getPrefs().savePrimaryAgent(agentId);
  }

  agentIdFromSessionPath(sessionPath) {
    const rel = relativePathInsideBase(sessionPath, this._d.agentsDir);
    if (rel === null || rel === "") return null;
    return rel.split(path.sep)[0] || null;
  }

  // ── Dispose ──

  async disposeAll(sessionCoord) {
    // 对所有缓存 session 做 final 滚动摘要（带超时保护）
    const entries = sessionCoord ? [...sessionCoord._sessions.entries()] : [];
    if (entries.length > 0) {
      const summaryPromises = entries.map(([sp, entry]) => {
        const agent = this._agents.get(entry.agentId) || this.agent;
        return Promise.race([
          agent?._memoryTicker?.notifySessionEnd(sp) ?? Promise.resolve(),
          new Promise(r => setTimeout(r, 4000)),
        ]);
      });
      await Promise.allSettled(summaryPromises);
    }
    await Promise.allSettled(
      [...this._agents.values()].map(ag => ag.dispose()),
    );
    this._agents.clear();
  }

  // ── Internal ──

  _scanAgentDirs() {
    try {
      return readDirectoryLikeDirentsSync(this._d.agentsDir)
        .filter(e => this._acceptDiscoveredAgentId(e.name)
          && fs.existsSync(path.join(this._d.agentsDir, e.name, "config.yaml"))
          && !this.isAgentDeleted(e.name));
    } catch { return []; }
  }

  _scanDeletedAgentDirs() {
    try {
      return readDirectoryLikeDirentsSync(this._d.agentsDir)
        .filter(e => this._acceptDiscoveredAgentId(e.name)
          && fs.existsSync(path.join(this._d.agentsDir, e.name, "config.yaml"))
          && fs.existsSync(this._deletedAgentTombstonePath(e.name)));
    } catch { return []; }
  }

  _acceptDiscoveredAgentId(agentId) {
    if (isValidAgentId(agentId)) return true;
    if (!this._invalidAgentIdsWarned.has(agentId)) {
      this._invalidAgentIdsWarned.add(agentId);
      log.warn(
        `ignoring legacy agent directory with invalid ID ${JSON.stringify(agentId)}; `
        + "the directory was preserved and must be renamed manually",
      );
    }
    return false;
  }

  _readAgentNameFromConfig(agentDir) {
    try {
      const cfg = safeReadYAMLSync(path.join(agentDir, "config.yaml"), {}, YAML);
      return cfg.agent?.name || null;
    } catch {
      return null;
    }
  }

  _readAgentYuanFromConfig(agentDir) {
    try {
      const cfg = safeReadYAMLSync(path.join(agentDir, "config.yaml"), {}, YAML);
      return cfg.agent?.yuan || null;
    } catch {
      return null;
    }
  }

  /** 构造 per-agent getOwnerIds 闭包：从 agent 自身的 config.bridge 读取 */
  _makeOwnerIdsFn(ag) {
    return () => {
      const bridgeCfg = ag.config?.bridge || {};
      const ids: any = {};
      for (const [plat, cfg] of Object.entries(bridgeCfg)) {
        if (plat === 'readOnly') continue;
        if (typeof cfg === 'object' && (cfg as any)?.owner) ids[plat] = (cfg as any).owner;
      }
      return ids;
    };
  }

  /**
   * 注册 agent 到长驻 Map，写入前校验 id 与实例字段一致。
   * 防止未来某次改动让 Map key 和 agent.id 错位（这是过去 agent.id=undefined 类 bug 的温床）。
   */
  _registerAgent(agentId, ag) {
    if (ag.id !== agentId) {
      throw new Error(`agent id mismatch: map key "${agentId}" vs instance.id "${ag.id}"`);
    }
    this._agents.set(agentId, ag);
  }

  _createAgentInstance(agentId, getOwnerIds) {
    const ag = new Agent({
      id: agentId,
      agentsDir: this._d.agentsDir,
      productDir: this._d.productDir,
      userDir: this._d.userDir,
      channelsDir: this._d.channelsDir,
      searchConfigResolver: () => this._d.getSearchConfig(),
    });
    ag.setGetOwnerIds(getOwnerIds);
    // 回调注入：Agent 通过 _cb 访问 Engine 能力，不直接持有 Engine 引用
    const getEngine = () => this._d.getEngine?.();
    ag.setCallbacks({
      emitDevLog:           (text, level) => getEngine()?.emitDevLog?.(text, level),
      getConfirmStore:      () => getEngine()?.confirmStore ?? null,
      getAutomationSuggestionStore: () => getEngine()?.automationSuggestionStore ?? null,
      getApprovalGateway:   () => getEngine()?.approvalGateway ?? null,
      getCurrentSessionPath:() => getEngine()?.currentSessionPath ?? null,
      getSessionPermissionMode: (sp) => getEngine()?.getSessionPermissionMode?.(sp) ?? null,
      getSessionCwd:        (sp) => getEngine()?.getSessionByPath?.(sp)?.sessionManager?.getCwd?.() ?? null,
      getSessionWorkspaceFolders: (sp) => getEngine()?.getSessionWorkspaceFolders?.(sp) ?? [],
      getSessionAuthorizedFolders: (sp) => getEngine()?.getSessionAuthorizedFolders?.(sp) ?? [],
      getHomeCwd:           (agentId) => getEngine()?.getHomeCwd?.(agentId) ?? null,
      getStudioCronStore:   () => getEngine()?.getStudioCronStore?.() ?? null,
      emitEvent:            (event, sp) => getEngine()?._emitEvent?.(event, sp),
      emitSessionEvent:     (event) => getEngine()?.emitSessionEvent?.(event),
      getDeferredResults:   () => getEngine()?.deferredResults ?? null,
      getLoopController:    () => getEngine()?.loopController ?? null,
      getSubagentRunStore:  () => getEngine()?.subagentRuns ?? null,
      getSubagentThreadStore: () => getEngine()?.subagentThreads ?? null,
      getActivityHub:       () => getEngine()?.activityHub ?? null,
      getTaskRegistry:      () => getEngine()?.taskRegistry ?? null,
      getTerminalSessionManager: () => getEngine()?.terminalSessions ?? null,
      registerSessionFile:  (entry) => getEngine()?.registerSessionFile?.(entry),
      setSubagentController: (id, ctrl) => getEngine()?.setSubagentController(id, ctrl),
      removeSubagentController: (id) => getEngine()?.removeSubagentController(id),
      executeIsolated:      (prompt, opts) => getEngine()?.executeIsolated(prompt, opts),
      getCurrentModelId:    () => getEngine()?.currentModel?.id ?? null,
      getSkillsDir:         () => getEngine()?.skillsDir ?? null,
      getLearnSkills:       () => getEngine()?.getLearnSkills?.() ?? {},
      getPreferences:       () => getEngine()?.preferences ?? null,
      isChannelsEnabled:    () => getEngine()?.isChannelsEnabled?.() ?? false,
      // 花名册唯一事实源：tombstone / 坏目录已在 AgentManager 层过滤
      listActiveAgents:     () => this.listActiveAgentsForRoster(),
      createChannelEntry:    (input) => getEngine()?.createChannelEntry?.(input),
      resolveUtilityConfig: (options) => getEngine()?.resolveUtilityConfig?.({ ...(options || {}), agentId: ag.id }),
      resolveUtilityConfigFresh: (options) => getEngine()?.resolveUtilityConfigFresh?.({ ...(options || {}), agentId: ag.id }),
      getCwd:               () => getEngine()?.cwd ?? "",
      getTimezone:          () => getEngine()?.getTimezone?.() ?? "",
      getLocale:            () => getEngine()?.getLocale?.() ?? "",
      getUserName:          () => getEngine()?.getUserName?.() ?? "",
      scheduleMemoryMaintenance: (agentId, reason) =>
        this.scheduleAgentMemoryMaintenance(agentId, reason, ag),
      getEngine,  // update-settings-tool 仍需要完整 engine
    });
    ag.setOnInstallCallback(async (skillName) => {
      const enabled = new Set(ag.config?.skills?.enabled || []);
      enabled.add(skillName);
      const engine = this._d.getEngine?.();
      if (engine?.reloadSkills) {
        await engine.reloadSkills();
      } else {
        const skills = this._d.getSkills();
        await skills.reload(this._d.getResourceLoader?.(), this._agents);
      }
      if (engine?.updateConfig) {
        await engine.updateConfig({ skills: { enabled: [...enabled] } }, { agentId: ag.id });
      } else {
        ag.updateConfig({ skills: { enabled: [...enabled] } });
        this._d.getSkills()?.syncAgentSkills?.(ag);
      }
      engine?._emitAppEvent?.("skills-changed", { agentId: ag.id });
    });
    ag.setNotifyHandler((payload: any, context: any = {}) => {
      const engine = this._d.getEngine?.();
      if (typeof engine?.deliverNotification === "function") {
        return engine.deliverNotification(payload, {
          agentId: ag.id,
          ...(typeof context?.sessionPath === "string" && context.sessionPath.trim()
            ? { sessionPath: context.sessionPath.trim() }
            : {}),
          ...(context?.bridgeContext?.isBridgeSession === true
            ? { bridgeContext: context.bridgeContext }
            : {}),
          ...(context?.notificationContext && typeof context.notificationContext === "object"
            ? { notificationContext: context.notificationContext }
            : {}),
        });
      }
      this._d.getHub()?.eventBus?.emit({
        type: "notification",
        title: payload?.title || "",
        body: payload?.body || "",
        agentId: ag.id,
      }, null);
      return undefined;
    });
    ag.setDescriptionRefreshHandler(() => {
      this._refreshDescription(ag.id).catch(() => {});
    });
    return ag;
  }

  async _generateAgentId(name) {
    let utilConfig;
    try {
      utilConfig = await this._d.resolveUtilityConfigFresh();
    } catch {
      // utility 模型未配置（新用户常见），直接走兜底 ID
      return `agent-${Date.now().toString(36)}`;
    }
    return _generateAgentId(utilConfig, name, this._d.agentsDir);
  }
}
