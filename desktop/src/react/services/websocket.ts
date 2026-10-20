/**
 * websocket.ts — WebSocket 连接管理（从 app-ws-shim.ts 迁移）
 *
 * 模块级 singleton，管理 WS 连接生命周期、重连逻辑。
 * 不依赖 ctx 注入，不依赖 React 组件生命周期。
 */


import { handleServerMessage, applyStreamingStatus } from './ws-message-handler';
import { requestStreamResume, injectHandlers, injectWebSocketGetter } from './stream-resume';
import {
  bindResourceEventForegroundCatchUp,
  catchUpResourceEventsAfterReconnect,
  recordResourceEventCursor,
} from './resource-events';
import { useStore } from '../stores';
import { setStatus } from '../utils/ui-helpers';
import {
  buildConnectionWsUrl,
  createLocalServerConnection,
  requestConnectionWsTicket,
  resolveServerConnection,
  type ServerConnection,
} from './server-connection';
import { AppError } from '../../../../shared/errors.ts';
import { errorBus } from '../../../../shared/error-bus.ts';

// ── 模块级 WS 实例 ──
let _ws: WebSocket | null = null;

// ── WS 重连状态 ──
let _wsRetryDelay = 1000;
const WS_RETRY_MAX = 30000;
let _wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _wsResumeVersion = 0;
const WS_FAST_RETRY_LIMIT = 20;
const WS_SLOW_RETRY_DELAY = 60_000;
let _wsRetryCount = 0;
let _resourceForegroundCatchUpCleanup: (() => void) | null = null;

// 注入循环依赖的 handlers
injectHandlers(handleServerMessage, applyStreamingStatus);
injectWebSocketGetter(() => _ws);

export function resolveStreamingSessionResumeTargets(state: {
  streamingSessions?: string[];
  sessionLocatorsById?: Record<string, { path?: string | null }>;
}): string[] {
  const locators = state.sessionLocatorsById || {};
  const targets = new Set<string>();
  for (const key of state.streamingSessions || []) {
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(locators, key)) {
      const path = locators[key]?.path;
      if (typeof path === 'string' && path.trim()) targets.add(path);
      continue;
    }
    targets.add(key);
  }
  return Array.from(targets);
}

/** 获取当前 WebSocket 实例 */
export function getWebSocket(): WebSocket | null {
  return _ws;
}

/** 发起 WebSocket 连接 */
export function connectWebSocket(port?: string, token?: string): void {
  // 如果没有传参，从 Zustand store 获取
  const storeState = useStore.getState();
  const connection = port !== undefined || token !== undefined
    ? createLocalServerConnection({
        serverPort: port || storeState.serverPort,
        serverToken: token ?? storeState.serverToken,
      })
    : resolveServerConnection(storeState);

  if (!connection) return;
  ensureResourceForegroundCatchUp();

  void openConnectionWebSocket(connection).catch((err) => {
    console.error('[ws] connection setup failed:', err);
    errorBus.report(new AppError('WS_DISCONNECTED'));
    setStatus('status.disconnected', false);
    scheduleReconnect();
  });
}

function ensureResourceForegroundCatchUp(): void {
  if (_resourceForegroundCatchUpCleanup) return;
  _resourceForegroundCatchUpCleanup = bindResourceEventForegroundCatchUp((event) => handleServerMessage(event));
}

async function openConnectionWebSocket(connection: ServerConnection): Promise<void> {
  const wsTicket = await requestConnectionWsTicket(connection);

  if (_wsRetryTimer) { clearTimeout(_wsRetryTimer); _wsRetryTimer = null; }
  if (_ws) {
    try { _ws.onclose = null; _ws.close(); } catch { /* silent */ }
  }

  const url = buildConnectionWsUrl(connection, '/ws', { wsTicket });
  _ws = new WebSocket(url);

  _ws.onopen = () => {
    _wsRetryDelay = 1000;
    _wsRetryCount = 0;
    setStatus('status.connected', true);
    useStore.setState({
      wsState: 'connected',
      wsReconnectAttempt: 0,
      compactingSessions: [],
      compactionModeBySession: {},
    });

    const s = useStore.getState();
    const streamingPaths = resolveStreamingSessionResumeTargets(s);
    if (streamingPaths.length > 0) {
      const myVersion = ++_wsResumeVersion;
      Promise.resolve().then(async () => {
        if (myVersion !== _wsResumeVersion) return;
        for (const targetPath of streamingPaths) {
          requestStreamResume(targetPath);
        }
      }).catch((err) => {
        console.error('[ws] reconnect resume failed:', err);
      });
    }

    // 重连后无条件刷新 ContextRing：覆盖 models-changed IPC 在 WS 关闭窗口
    // 期内到达、服务端重启、长时间挂起后唤醒等所有可能造成 context 数据
    // 与后端实际状态偏离的场景。不依赖 _pendingContextRefresh 队列。
    if (s.currentSessionPath && _ws?.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({
        type: 'context_usage',
        sessionPath: s.currentSessionPath,
        ...(s.currentSessionId ? { sessionId: s.currentSessionId } : {}),
      }));
    }

    void catchUpResourceEventsAfterReconnect((event) => handleServerMessage(event)).catch((err) => {
      console.warn('[ws] resource event catch-up failed:', err);
    });
  };

  _ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      recordResourceEventCursor(msg);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[ws] message parse error:', err);
    }
  };

  _ws.onclose = () => {
    setStatus('status.disconnected', false);
    scheduleReconnect();
  };

  _ws.onerror = () => {
    errorBus.report(new AppError('WS_DISCONNECTED'));
  };
}

function scheduleReconnect(): void {
  if (_wsRetryTimer) return;
  _wsRetryCount++;

  useStore.setState({ wsState: 'reconnecting', wsReconnectAttempt: _wsRetryCount });
  if (_wsRetryCount <= WS_FAST_RETRY_LIMIT) {
    _wsRetryTimer = setTimeout(() => connectWebSocket(), _wsRetryDelay);
    _wsRetryDelay = Math.min(_wsRetryDelay * 2, WS_RETRY_MAX);
  } else {
    _wsRetryTimer = setTimeout(() => connectWebSocket(), WS_SLOW_RETRY_DELAY);
  }
  (_wsRetryTimer as unknown as { unref?: () => void })?.unref?.();
}

/** 手动重连（由 StatusBar 重连按钮调用），重置重试计数 */
export function manualReconnect(): void {
  _wsRetryCount = 0;
  connectWebSocket();
}
