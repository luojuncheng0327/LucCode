/**
 * app-init.ts — 应用初始化逻辑（纯函数，非 React 组件）
 *
 * 从 App.tsx 提取。包含：
 * - __lucLog 日志上报
 * - 全局错误 / unhandled rejection 监听
 * - initApp() 主初始化流程
 */

import { useStore } from './stores';
import { lucFetch } from './hooks/use-luc-fetch';
import { applyAgentIdentity, loadAgents, loadAvatars } from './stores/agent-actions';
import { loadPendingNewSessionPermissionDefault, loadSessions, pendingNewSessionIdentityPatch, switchSession } from './stores/session-actions';
import { initSessionProjectCatalog } from './stores/session-project-actions';
import { loadSidebarUiPrefs } from './stores/sidebar-ui-slice';
import { connectWebSocket, getWebSocket } from './services/websocket';
import { setStatus, loadModels } from './utils/ui-helpers';
import { initJian } from './stores/desk-actions';
import { initViewerEvents } from './stores/preview-actions';
import { updateLayout } from './components/SidebarLayout';
import { initErrorBusBridge } from './errors/error-bus-bridge';
import { refreshPluginUI } from './stores/plugin-ui-actions';
import { openSettingsModal } from './stores/settings-modal-actions';
import { initQuotedSelectionLifecycle } from './stores/selection-actions';
import { hydrateInputDrafts, initInputDraftPersistence } from './stores/input-draft-persistence';
import { configureAppEventActions, handleAppEvent, readConfigCwdHistory, readConfigHomeFolder, readConfigMemoryMasterEnabled } from './services/app-event-actions';
import { configureWsMessageHandler } from './services/ws-message-handler';
import { applyChatLayout } from './chat/layout';
import { applyEditorTypography } from './editor/typography';
import { findPrimaryAgent } from './utils/agent-workspace';
import {
  LOCAL_CONNECTION_ID,
  createLocalServerConnection,
  hasServerConnection,
  mergeServerIdentity,
  readPersistedServerConnectionState,
  refreshLocalServerConnectionState,
  upsertServerConnection,
  warnIfServerProtocolMismatch,
  type ServerConnection,
} from './services/server-connection';
import { persistAppearancePreferences } from './services/appearance-sync';
import { errorBus as _errorBus } from '../../../shared/error-bus.ts';
import { AppError as _AppError } from '../../../shared/errors.ts';

declare const i18n: {
  locale: string;
  defaultName: string;
  load(locale: string): Promise<void>;
};
declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any -- 全局 bootstrap：platform/IPC callback 签名含 any */

function markRendererLaunch(event: string, details?: unknown) {
  if (details === undefined) {
    console.info(`[luc-launch] ${event}`);
  } else {
    console.info(`[luc-launch] ${event}`, details);
  }
}

// ── __lucLog：前端日志上报 ──
window.__lucLog = function (level: string, module: string, message: string) {
  if (!hasServerConnection(useStore.getState())) return;
  lucFetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, module, message }),
  }).catch(err => console.warn('[lucLog] log upload failed:', err));
};

// ── 全局错误捕获 ──
window.addEventListener('error', (e) => {
  _errorBus.report(_AppError.wrap(e.error || e.message), {
    context: { filename: e.filename, line: e.lineno },
  });
});
window.addEventListener('unhandledrejection', (e) => {
  _errorBus.report(_AppError.wrap(e.reason));
});

// ── 主初始化流程 ──

export async function initApp(): Promise<void> {
  const platform = window.platform;
  initQuotedSelectionLifecycle();
  initInputDraftPersistence();

  const requestContextUsage = (sessionPath: string) => {
    const ws = getWebSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'context_usage', sessionPath }));
    }
  };
  configureAppEventActions({ requestContextUsage });
  configureWsMessageHandler({ requestContextUsage });

  platform.onServerRestarted?.((data: { port: number; token?: string | null }) => {
    const storeState = useStore.getState();
    const serverPort = String(data.port);
    const serverToken = data.token ?? storeState.serverToken ?? null;
    const activeBeforeRestart = storeState.activeServerConnection;
    const nextConnectionState = refreshLocalServerConnectionState({
      serverConnections: storeState.serverConnections,
      activeServerConnectionId: storeState.activeServerConnectionId,
      activeServerConnection: storeState.activeServerConnection,
      serverPort,
      serverToken,
    });
    useStore.setState({
      serverPort,
      serverToken,
      ...nextConnectionState,
    });
    if (!activeBeforeRestart || activeBeforeRestart.connectionId === LOCAL_CONNECTION_ID) {
      connectWebSocket();
    }
  });

  // 1. 获取 server 连接信息并存入 Zustand
  const serverPort = await platform.getServerPort();
  const serverToken = await platform.getServerToken();
  const localServerConnection = createLocalServerConnection({ serverPort, serverToken });
  const persistedConnections = readPersistedServerConnectionState();
  const initialRegistry = localServerConnection
    ? upsertServerConnection(persistedConnections.serverConnections, localServerConnection)
    : persistedConnections.serverConnections;
  const requestedActiveConnection = persistedConnections.activeServerConnectionId
    ? initialRegistry[persistedConnections.activeServerConnectionId]
    : null;
  const activeServerConnection = requestedActiveConnection || localServerConnection;
  useStore.setState({
    serverPort,
    serverToken,
    serverConnections: initialRegistry,
    activeServerConnectionId: activeServerConnection?.connectionId ?? null,
    activeServerConnection,
  });

  if (!activeServerConnection) {
    setStatus('status.serverNotReady', false);
    markRendererLaunch('app-ready', JSON.stringify({ reason: 'no-active-server-connection' }));
    platform.appReady();
    return;
  }

  try {
    await refreshDeviceWebSession(activeServerConnection);
    const mergedConnection = await loadIdentityForActiveConnection(activeServerConnection);
    useStore.setState({
      serverConnections: upsertServerConnection(useStore.getState().serverConnections, mergedConnection),
      activeServerConnectionId: mergedConnection.connectionId,
      activeServerConnection: mergedConnection,
    });
  } catch (err) {
    if (activeServerConnection.connectionId !== LOCAL_CONNECTION_ID && localServerConnection) {
      console.warn('[init] remote server identity failed, returning to local server:', err);
      useStore.setState({
        activeServerConnectionId: localServerConnection.connectionId,
        activeServerConnection: localServerConnection,
      });
      try {
        await refreshDeviceWebSession(localServerConnection);
        const mergedConnection = await loadIdentityForActiveConnection(localServerConnection);
        useStore.setState({
          serverConnections: upsertServerConnection(useStore.getState().serverConnections, mergedConnection),
          activeServerConnectionId: mergedConnection.connectionId,
          activeServerConnection: mergedConnection,
        });
      } catch (localErr) {
        console.error('[init] server identity failed:', localErr);
        setStatus('status.serverNotReady', false);
        markRendererLaunch('app-ready', JSON.stringify({ reason: 'local-server-identity-failed' }));
        platform.appReady();
        return;
      }
    } else {
      console.error('[init] server identity failed:', err);
      setStatus('status.serverNotReady', false);
      markRendererLaunch('app-ready', JSON.stringify({ reason: 'server-identity-failed' }));
      platform.appReady();
      return;
    }
  }

  persistAppearancePreferences().catch((err) => {
    console.warn('[init] appearance preference sync skipped:', err);
  });

  // 2. 并行获取 health + 全局设置 + agent 列表
  // bootstrap 报出来的 agent 身份，后面按 agent 提问的请求都用它，免得任何一步
  // 落到"服务端当前焦点是谁"上——两个客户端各开一个 agent 时那个答案是错的。
  let bootstrapAgentId: string | null = null;
  try {
    const [healthRes, globalConfigRes, agentsRes] = await Promise.all([
      lucFetch('/api/health'),
      lucFetch('/api/config'),
      lucFetch('/api/agents'),
    ]);
    const healthData = await healthRes.json();
    bootstrapAgentId = healthData.agentId || null;
    const globalConfig = await globalConfigRes.json();
    const agentsData = await agentsRes.json();

    // 排版、语言这些是全局偏好；书桌目录、记忆开关、聊天布局、最近工作区
    // 属于某一个 agent，必须指名道姓地问那个 agent 要，不能从一个不带 agent
    // 身份的请求里捞。启动后落到的是主助手（见 loadAgents 的选择逻辑），
    // 所以这里也按主助手取，两边看到的是同一个 agent。
    const bootAgentId = findPrimaryAgent(agentsData.agents || [])?.id || null;
    const agentConfig = bootAgentId
      ? await lucFetch(`/api/agents/${encodeURIComponent(bootAgentId)}/config`).then(r => r.json())
      : {};

    applyEditorTypography(globalConfig.editor);
    applyChatLayout(agentConfig.chat);

    // 3. 加载 i18n
    await i18n.load(globalConfig.locale || 'zh-CN');
    useStore.setState({ locale: i18n.locale });

    // 4. 应用 agent 身份
    await applyAgentIdentity({
      agentName: healthData.agent || 'Luc',
      userName: healthData.user || t('common.user'),
      ui: { avatars: false, agents: false, welcome: true },
    });

    // 5. 设置 desk 相关状态
    const homeFolder = readConfigHomeFolder(agentConfig);
    useStore.setState({
      homeFolder,
      selectedFolder: homeFolder,
      workspaceFolders: [],
      memoryMasterEnabled: readConfigMemoryMasterEnabled(agentConfig),
    });
    useStore.setState({ cwdHistory: readConfigCwdHistory(agentConfig) });

    // 6. 加载头像（agent 头像按 bootstrap 给出的 agent 身份请求）
    loadAvatars(healthData.avatars, healthData.agentId);
  } catch (err) {
    console.error('[init] i18n/health/config failed:', err);
  }

  // 8. 连接 WebSocket
  connectWebSocket();
  initErrorBusBridge();

  // 9. 加载模型
  await loadModels();

  // 10. 加载 agents + sessions
  useStore.setState(pendingNewSessionIdentityPatch());
  await loadPendingNewSessionPermissionDefault();
  await loadAgents();
  await loadSessions();
  void hydrateInputDrafts();

  // 10b. 加载项目目录（带重试）。放在 sessions 之后：此时 server 已确认可用，
  // 避免项目目录像过去那样只靠 SessionList 挂载时一次性拉取、失败即长期空白，
  // 导致自定义项目消失、其会话被错误并入 cwd 推导分组。
  await initSessionProjectCatalog();

  // 11. 初始化书桌
  initJian();

  // 12. 注册派生 viewer 窗口关闭事件（清 pinnedViewers store）
  initViewerEvents();

  // 13. 初始 layout 计算
  updateLayout();

  // 14. 任务计划 badge 初始值
  try {
    const res = await lucFetch('/api/desk/cron');
    const data = await res.json();
    const count = (data.jobs || []).length;
    useStore.setState({ automationCount: count });
  } catch { /* ignore */ }

  // 15. Bridge 状态指示点（启动时就查一次，不等用户打开面板）
  //     agent 身份用 bootstrap 给出的那个，和上面的头像同源
  try {
    if (!bootstrapAgentId) throw new Error('bridge status needs an agent id');
    const res = await lucFetch(`/api/bridge/status?agentId=${encodeURIComponent(bootstrapAgentId)}`);
    const data = await res.json();
    const anyConnected = data.telegram?.status === 'connected' || data.feishu?.status === 'connected' || data.qq?.status === 'connected' || data.wechat?.status === 'connected' || data.whatsapp?.status === 'connected';
    useStore.setState({ bridgeDotConnected: anyConnected });
  } catch { /* ignore */ }

  // 16. 加载插件 UI（pages / widgets）
  refreshPluginUI();

  // 18. 设置快捷键
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      openSettingsModal();
    }
  });

  // 19. 设置变更监听
  platform.onSettingsChanged((type: string, data: any) => {
    handleAppEvent(type, data, { source: 'desktop-ipc' });
  });

  // 19b. 侧边栏 UI 偏好（session 行高 / 项目视图折叠）：store 持有，侧栏实例只读。
  //      连接就绪后拉一次，连接对象变化后再拉；设置页保存的同窗广播走这里，
  //      跨窗 IPC 走 handleAppEvent 的同名事件，两条路径落到同一个 action。
  window.addEventListener('luc-settings', (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!detail || detail.type !== 'sidebar-ui-changed') return;
    useStore.getState().applySidebarUiPrefs(detail.sidebarUi || detail);
  });
  const syncSidebarUiPrefs = (connection: ServerConnection | null) => {
    if (!connection) return;
    void loadSidebarUiPrefs();
  };
  useStore.subscribe((state, prev) => {
    if (state.activeServerConnection === prev.activeServerConnection) return;
    syncSidebarUiPrefs(state.activeServerConnection);
  });
  syncSidebarUiPrefs(useStore.getState().activeServerConnection);

  // 20. 主进程请求打开设置：托盘 / 外部 IPC 统一落到主窗口 modal
  platform.onOpenSettingsModal?.((tab?: string) => {
    openSettingsModal(tab);
  });

  // 21. Quick Chat 请求打开后台会话：复用主窗口既有 session 切换路径
  platform.onQuickChatOpenSession?.((payload: { sessionPath?: string }) => {
    if (payload?.sessionPath) {
      void switchSession(payload.sessionPath);
      loadSessions();
    }
  });

  // 21. Skill Viewer overlay（主进程 / 设置窗口 → 渲染进程）
  window.luc?.onShowSkillViewer?.((data: any) => {
    useStore.setState({ skillViewerData: data });
  });

  // 22. 通知 app ready
  markRendererLaunch('app-ready');
  platform.appReady();
}

async function loadIdentityForActiveConnection(connection: ServerConnection): Promise<ServerConnection> {
  const identityRes = await lucFetch('/api/server/identity');
  const identityData = await identityRes.json();
  warnIfServerProtocolMismatch(identityData);
  return mergeServerIdentity(connection, identityData);
}

async function refreshDeviceWebSession(connection: ServerConnection): Promise<void> {
  if (connection.credentialKind !== 'device_credential' || !connection.token) return;
  await lucFetch('/api/web-auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ credential: connection.token }),
  });
}
