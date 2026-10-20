import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  buildConnectionWsUrl,
  createLocalServerConnection,
  type ServerConnection,
} from '../services/server-connection';
import { PlanModeButton, type PermissionMode } from '../components/input/PlanModeButton';
import { SendButton } from '../components/input/SendButton';
import { AttachedFilesBar } from '../components/input/AttachedFilesBar';
import { ChatTranscript } from '../components/chat/ChatTranscript';
import { handleServerMessage } from '../services/ws-message-handler';
import { useStore } from '../stores';
import { sessionScopedListIncludes, sessionScopedValue } from '../stores/session-slice';
import { applyAgentIdentity, loadAvatars } from '../stores/agent-actions';
import { loadMessages } from '../stores/session-actions';
import type { ForkedSessionRef } from '../stores/message-turn-actions';
import { useI18n } from '../hooks/use-i18n';
import inputStyles from '../components/input/InputArea.module.css';
import chatStyles from '../components/chat/Chat.module.css';
import {
  DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES,
  normalizeQuickChatPreferences,
} from '../../../../shared/quick-chat-preferences.ts';
import { shouldResetQuickChatSessionAfterIdle } from './quick-chat-lifecycle';
import {
  pickQuickChatRuntimeAgent,
  resolveQuickChatPermissionMode,
  shouldAdoptRuntimeAgentForQuickChat,
  type QuickChatRuntimeAgent,
} from './quick-chat-runtime';
import { useQuickChatAutoScroll } from './use-quick-chat-auto-scroll';
import styles from './QuickChatApp.module.css';

interface AgentOption extends QuickChatRuntimeAgent {
  name: string;
}

interface QuickAttachment {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  base64Data?: string;
}

interface DetachedSessionResponse {
  ok?: boolean;
  path?: string;
  sessionId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  permissionMode?: PermissionMode;
  error?: string;
}

const EMPTY_SESSION_ITEMS: never[] = [];

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      resolve(dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl);
    };
    reader.onerror = () => reject(reader.error || new Error('read file failed'));
    reader.readAsDataURL(file);
  });
}

function normalizeAgentName(agent: AgentOption | null | undefined) {
  return agent?.name?.trim() || agent?.id || 'Agent';
}

function agentInitial(agent: AgentOption | null | undefined) {
  return normalizeAgentName(agent).slice(0, 1).toUpperCase();
}

function acceptQuickChatServerMessage(msg: any, sessionPath: string | null): boolean {
  if (!sessionPath) return !msg.sessionPath && !msg.path && !msg.session?.path;
  if (msg.sessionPath) return msg.sessionPath === sessionPath;
  if (msg.path) return msg.path === sessionPath;
  if (msg.session?.path) return msg.session.path === sessionPath;
  return true;
}

export function bindQuickChatDetachedSession(options: {
  path: string;
  sessionId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  now?: string;
}): void {
  const sessionPath = typeof options.path === 'string' && options.path.trim() ? options.path : null;
  if (!sessionPath) return;
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.trim()
    ? options.sessionId.trim()
    : null;
  const now = options.now || new Date().toISOString();

  useStore.getState().setCurrentSessionRef?.({ sessionId, path: sessionPath });
  useStore.setState({ pendingNewSession: false });

  const state = useStore.getState();
  if (!sessionScopedValue(state, state.chatSessions, sessionPath)) {
    state.initSession(sessionPath, [], false);
  }

  useStore.setState((current: any) => {
    const existing = current.sessions.some((item: { path?: string; sessionId?: string | null }) => (
      item.path === sessionPath || (!!sessionId && item.sessionId === sessionId)
    ));
    if (existing) return {};
    return {
      sessions: [{
        path: sessionPath,
        sessionId,
        title: null,
        firstMessage: '',
        modified: now,
        messageCount: 0,
        agentId: options.agentId || null,
        agentName: options.agentName || null,
        cwd: null,
        _optimistic: true,
      }, ...current.sessions],
    };
  });
}

export function QuickChatApp() {
  const { t } = useI18n();
  const [connection, setConnection] = useState<ServerConnection | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<QuickAttachment[]>([]);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [reuseTimeoutMinutes, setReuseTimeoutMinutes] = useState(DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const transcriptContentRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionPathRef = useRef<string | null>(null);
  const connectionRef = useRef<ServerConnection | null>(null);
  const agentsRef = useRef<AgentOption[]>([]);
  const selectedAgentIdRef = useRef<string | null>(null);
  const permissionModeRef = useRef<PermissionMode>('ask');
  const lastResizeRef = useRef<{ mode: 'compact' | 'chat'; height: number } | null>(null);
  const lastHiddenAtRef = useRef<number | null>(null);
  const reuseTimeoutMinutesRef = useRef(DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES);
  const isStreamingRef = useRef(false);
  const sendingRef = useRef(false);
  const isComposingRef = useRef(false);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || agents[0] || null,
    [agents, selectedAgentId],
  );
  const sessionItems = useStore(useCallback((state) => (
    sessionPath ? sessionScopedValue(state, state.chatSessions, sessionPath)?.items ?? EMPTY_SESSION_ITEMS : EMPTY_SESSION_ITEMS
  ), [sessionPath]));
  const isStreaming = useStore(useCallback((state) => (
    sessionScopedListIncludes(state, state.streamingSessions, sessionPath)
  ), [sessionPath]));
  const inlineError = useStore(useCallback((state) => (
    sessionPath ? sessionScopedValue(state, state.inlineErrors, sessionPath) ?? null : null
  ), [sessionPath]));
  const sessionTitle = useStore(useCallback((state) => {
    if (!sessionPath) return null;
    const session = state.sessions.find((item: { path?: string }) => item.path === sessionPath);
    return typeof session?.title === 'string' && session.title.trim() ? session.title.trim() : null;
  }, [sessionPath]));

  const applyRuntimePermissionMode = useCallback((mode: PermissionMode) => {
    permissionModeRef.current = mode;
    setPermissionMode(mode);
  }, []);

  const applyRuntimeAgentList = useCallback((
    nextAgents: AgentOption[],
    options: { adoptAgent?: boolean; fallbackAgentId?: string | null } = {},
  ) => {
    agentsRef.current = nextAgents;
    setAgents(nextAgents);

    const runtimeAgent = pickQuickChatRuntimeAgent(nextAgents, options.fallbackAgentId) as AgentOption | null;
    const patch: Record<string, any> = { agents: nextAgents };

    if (options.adoptAgent) {
      selectedAgentIdRef.current = runtimeAgent?.id || null;
      setSelectedAgentId(runtimeAgent?.id || null);
      patch.currentAgentId = runtimeAgent?.id || null;
      if (runtimeAgent?.name) patch.agentName = runtimeAgent.name;
      if (runtimeAgent?.yuan) patch.agentYuan = runtimeAgent.yuan;
      if (typeof runtimeAgent?.memoryMasterEnabled === 'boolean') {
        patch.memoryMasterEnabled = runtimeAgent.memoryMasterEnabled;
      }
    }

    useStore.setState(patch);
    return runtimeAgent;
  }, []);

  const refreshQuickChatRuntimeState = useCallback(async (
    options: { adoptAgent?: boolean } = {},
  ) => {
    const conn = connectionRef.current || connection;
    if (!conn) return null;
    try {
      const [prefsRes, agentsRes, permissionRes] = await Promise.all([
        fetch(buildConnectionUrl(conn, '/api/preferences/quick-chat'), {
          headers: appendConnectionAuth(conn),
        }),
        fetch(buildConnectionUrl(conn, '/api/agents?fresh=1'), {
          headers: appendConnectionAuth(conn),
        }),
        fetch(buildConnectionUrl(conn, '/api/preferences/session-permission-default'), {
          headers: appendConnectionAuth(conn),
        }),
      ]);
      if (!prefsRes.ok) throw new Error(`preferences: ${prefsRes.status}`);
      if (!agentsRes.ok) throw new Error(`agents: ${agentsRes.status}`);
      if (!permissionRes.ok) throw new Error(`permission: ${permissionRes.status}`);

      const [prefsData, agentsData, permissionData] = await Promise.all([
        prefsRes.json(),
        agentsRes.json(),
        permissionRes.json(),
      ]);

      const quickChatPrefs = normalizeQuickChatPreferences(prefsData?.quickChat);
      reuseTimeoutMinutesRef.current = quickChatPrefs.reuseTimeoutMinutes;
      setReuseTimeoutMinutes(quickChatPrefs.reuseTimeoutMinutes);

      const mode = resolveQuickChatPermissionMode(permissionData);
      applyRuntimePermissionMode(mode);

      const nextAgents = Array.isArray(agentsData.agents) ? agentsData.agents : [];
      const adoptAgent = options.adoptAgent ?? shouldAdoptRuntimeAgentForQuickChat(sessionPathRef.current);
      const runtimeAgent = applyRuntimeAgentList(nextAgents, { adoptAgent });

      return {
        prefs: quickChatPrefs,
        agents: nextAgents,
        permissionMode: mode,
        agent: runtimeAgent,
      };
    } catch (err) {
      console.warn('[quick-chat] runtime refresh failed:', err);
      return null;
    }
  }, [applyRuntimeAgentList, applyRuntimePermissionMode, connection]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const [serverPort, serverToken] = await Promise.all([
          window.luc?.getServerPort?.(),
          window.luc?.getServerToken?.(),
        ]);
        const local = createLocalServerConnection({ serverPort, serverToken });
        if (!local) throw new Error('server connection unavailable');
        if (cancelled) return;
        setConnection(local);
        connectionRef.current = local;
        useStore.getState().setLocalServerConnection?.(serverPort ?? null, serverToken ?? null);
        useStore.setState({ connected: true });

        const [agentsRes, healthRes, configRes, permissionRes, prefsRes] = await Promise.all([
          fetch(buildConnectionUrl(local, '/api/agents?fresh=1'), {
            headers: appendConnectionAuth(local),
          }),
          fetch(buildConnectionUrl(local, '/api/health'), {
            headers: appendConnectionAuth(local),
          }),
          fetch(buildConnectionUrl(local, '/api/config'), {
            headers: appendConnectionAuth(local),
          }),
          fetch(buildConnectionUrl(local, '/api/preferences/session-permission-default'), {
            headers: appendConnectionAuth(local),
          }),
          fetch(buildConnectionUrl(local, '/api/preferences/quick-chat'), {
            headers: appendConnectionAuth(local),
          }),
        ]);
        const [agentsData, healthData, configData, permissionData, prefsData] = await Promise.all([
          agentsRes.json(),
          healthRes.json(),
          configRes.json(),
          permissionRes.json(),
          prefsRes.json(),
        ]);
        if (cancelled) return;
        const quickChatPrefs = normalizeQuickChatPreferences(prefsData?.quickChat);
        reuseTimeoutMinutesRef.current = quickChatPrefs.reuseTimeoutMinutes;
        setReuseTimeoutMinutes(quickChatPrefs.reuseTimeoutMinutes);

        if (window.i18n?.load) {
          await window.i18n.load(configData.locale || 'zh-CN');
          if (!cancelled) useStore.setState({ locale: window.i18n.locale });
        }
        if (cancelled) return;

        await applyAgentIdentity({
          agentName: healthData.agent || 'Luc',
          userName: healthData.user || window.t?.('common.user') || 'User',
          ui: { avatars: false, agents: false, welcome: true },
        });
        if (cancelled) return;
        loadAvatars(healthData.avatars, healthData.agentId);

        const nextAgents = Array.isArray(agentsData.agents) ? agentsData.agents : [];
        const preferred = applyRuntimeAgentList(nextAgents, {
          adoptAgent: true,
          fallbackAgentId: healthData.agentId,
        });
        if (!preferred) {
          useStore.setState({
            agentName: healthData.agent || 'Luc',
            agentYuan: 'luc',
          });
        }
        applyRuntimePermissionMode(resolveQuickChatPermissionMode(permissionData));
      } catch (err) {
        console.error('[quick-chat] bootstrap failed:', err);
        if (!cancelled) setError(t('quickChat.serviceUnavailable'));
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [applyRuntimeAgentList, applyRuntimePermissionMode, t]);

  useEffect(() => {
    sessionPathRef.current = sessionPath;
  }, [sessionPath]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId;
  }, [selectedAgentId]);

  useEffect(() => {
    permissionModeRef.current = permissionMode;
  }, [permissionMode]);

  useEffect(() => {
    reuseTimeoutMinutesRef.current = reuseTimeoutMinutes;
  }, [reuseTimeoutMinutes]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  const markHidden = useCallback(() => {
    lastHiddenAtRef.current = Date.now();
  }, []);

  const resetDetachedSession = useCallback(() => {
    if (isStreamingRef.current || sendingRef.current) return;
    wsRef.current?.close();
    wsRef.current = null;
    sessionPathRef.current = null;
    setSessionPath(null);
    setDraft('');
    setAttachments([]);
    setSending(false);
    setError(null);
    lastResizeRef.current = null;
    window.luc?.quickChatResize?.('compact');
  }, []);

  useEffect(() => {
    const dispose = window.luc?.onQuickChatShown?.(() => {
      textareaRef.current?.focus();
      void (async () => {
        const runtime = await refreshQuickChatRuntimeState({
          adoptAgent: shouldAdoptRuntimeAgentForQuickChat(sessionPathRef.current),
        });
        const hiddenAt = lastHiddenAtRef.current;
        const shouldReset = shouldResetQuickChatSessionAfterIdle({
          lastHiddenAt: hiddenAt,
          now: Date.now(),
          reuseTimeoutMinutes: runtime?.prefs?.reuseTimeoutMinutes ?? reuseTimeoutMinutesRef.current,
          isStreaming: isStreamingRef.current || sendingRef.current,
        });
        lastHiddenAtRef.current = null;
        if (shouldReset) {
          resetDetachedSession();
          if (runtime?.agents) {
            applyRuntimeAgentList(runtime.agents, { adoptAgent: true });
          }
        }
        setTimeout(() => textareaRef.current?.focus(), 40);
      })();
    });
    return () => { if (typeof dispose === 'function') dispose(); };
  }, [applyRuntimeAgentList, refreshQuickChatRuntimeState, resetDetachedSession]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') markHidden();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', markHidden);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', markHidden);
    };
  }, [markHidden]);

  const apiFetch = useCallback(async (path: string, init: RequestInit = {}) => {
    const conn = connectionRef.current || connection;
    if (!conn) throw new Error('server connection unavailable');
    const res = await fetch(buildConnectionUrl(conn, path), {
      ...init,
      headers: appendConnectionAuth(conn, init.headers),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return res;
  }, [connection]);

  const ensureSocket = useCallback(() => {
    const conn = connectionRef.current || connection;
    if (!conn) throw new Error('server connection unavailable');
    const current = wsRef.current;
    if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
      return current;
    }
    const ws = new WebSocket(buildConnectionWsUrl(conn, '/ws'));
    wsRef.current = ws;
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data || '{}'));
        const activeSessionPath = sessionPathRef.current;
        if (!acceptQuickChatServerMessage(msg, activeSessionPath)) return;
        handleServerMessage(msg);
        if (msg.type === 'status') {
          setSending(msg.isStreaming === true);
        } else if (msg.type === 'turn_end') {
          setSending(false);
          if (activeSessionPath) void loadMessages(activeSessionPath);
        } else if (msg.type === 'error') {
          const text = typeof msg.message === 'string' ? msg.message : t('quickChat.sendFailed');
          setError(text);
          setSending(false);
        }
      } catch (err) {
        console.warn('[quick-chat] ws message ignored:', err);
      }
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };
    return ws;
  }, [connection, t]);

  const addFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    setAttachments((prev) => {
      const slots = Math.max(0, 10 - prev.length);
      if (slots === 0) return prev;
      const nextItems = imageFiles.slice(0, slots).map((file) => {
        const id = `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2)}`;
        void fileToBase64(file).then((base64Data) => {
          setAttachments((items) => items.map((item) => (
            item.id === id ? { ...item, base64Data } : item
          )));
        }).catch((err) => {
          console.warn('[quick-chat] attachment preview failed:', err);
        });
        return {
          id,
          file,
          name: file.name || 'image',
          mimeType: file.type || 'image/png',
        };
      });
      return [...prev, ...nextItems];
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const ensureDetachedSession = useCallback(async () => {
    if (sessionPathRef.current) return sessionPathRef.current;
    const runtime = await refreshQuickChatRuntimeState({ adoptAgent: true });
    let mode = runtime?.permissionMode || permissionModeRef.current;
    if (!runtime?.permissionMode) {
      const modeRes = await apiFetch('/api/preferences/session-permission-default');
      const modeData = await modeRes.json();
      mode = resolveQuickChatPermissionMode(modeData);
      applyRuntimePermissionMode(mode);
    }
    const nextAgentId = runtime?.agent?.id || selectedAgentIdRef.current;
    const res = await apiFetch('/api/sessions/new-detached', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: nextAgentId,
        permissionMode: mode,
        launchContext: null,
        contextAttachments: [],
      }),
    });
    const data = await res.json() as DetachedSessionResponse;
    if (!data.path) throw new Error(data.error || t('quickChat.createSessionFailed'));
    setSessionPath(data.path);
    sessionPathRef.current = data.path;
    const resolvedAgentId = data.agentId || nextAgentId || null;
    if (resolvedAgentId) {
      selectedAgentIdRef.current = resolvedAgentId;
      setSelectedAgentId(resolvedAgentId);
    }
    const now = new Date().toISOString();
    const agent = agentsRef.current.find((item) => item.id === resolvedAgentId)
      || runtime?.agent
      || selectedAgent;
    bindQuickChatDetachedSession({
      path: data.path,
      sessionId: data.sessionId,
      agentId: resolvedAgentId,
      agentName: data.agentName || agent?.name || null,
      now,
    });
    return data.path;
  }, [apiFetch, applyRuntimePermissionMode, refreshQuickChatRuntimeState, selectedAgent, t]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending) return;
    setSending(true);
    setError(null);
    try {
      const nextSessionPath = await ensureDetachedSession();
      const outgoingAttachments = attachments;
      const encodedAttachments = await Promise.all(outgoingAttachments.map(async (item) => ({
        item,
        data: item.base64Data || await fileToBase64(item.file),
      })));
      const images = encodedAttachments.map(({ item, data }) => ({
        type: 'image',
        data,
        mimeType: item.mimeType,
      }));
      setDraft('');
      setAttachments([]);
      window.luc?.quickChatResize?.('chat');

      const ws = ensureSocket();
      const sendPayload = () => ws.send(JSON.stringify({
        type: 'prompt',
        text,
        sessionPath: nextSessionPath,
        images,
        displayMessage: {
          text,
          attachments: encodedAttachments.map(({ item, data }) => ({
            path: item.id,
            name: item.name,
            isDir: false,
            mimeType: item.mimeType,
            base64Data: data,
          })),
        },
      }));
      if (ws.readyState === WebSocket.OPEN) {
        sendPayload();
      } else {
        ws.addEventListener('open', sendPayload, { once: true });
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : t('quickChat.sendFailed');
      setError(text);
      setSending(false);
    }
  }, [attachments, draft, ensureDetachedSession, ensureSocket, sending, t]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of Array.from(event.clipboardData.items || [])) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file && file.type.startsWith('image/')) files.push(file);
      }
    }
    if (files.length > 0) addFiles(files);
  }, [addFiles]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files || []));
  }, [addFiles]);

  const openFullSession = useCallback(() => {
    if (!sessionPathRef.current) return;
    markHidden();
    window.luc?.quickChatOpenSession?.(sessionPathRef.current);
  }, [markHidden]);

  const handleForkCreated = useCallback(async (forked: ForkedSessionRef) => {
    sessionPathRef.current = forked.sessionPath;
    setSessionPath(forked.sessionPath);
    setSending(false);
    setError(null);

    const resolvedAgentId = forked.agentId || selectedAgentIdRef.current;
    if (resolvedAgentId) {
      selectedAgentIdRef.current = resolvedAgentId;
      setSelectedAgentId(resolvedAgentId);
    }
    const agent = agentsRef.current.find(item => item.id === resolvedAgentId) || null;
    bindQuickChatDetachedSession({
      path: forked.sessionPath,
      sessionId: forked.sessionId,
      agentId: resolvedAgentId,
      agentName: agent?.name || null,
    });
    await loadMessages(forked.sessionPath);
    window.luc?.quickChatResize?.('chat');
  }, []);

  const closeQuickChat = useCallback(() => {
    markHidden();
    window.luc?.quickChatHide?.();
  }, [markHidden]);

  const canSend = (!!draft.trim() || attachments.length > 0) && !sending && !isStreaming && !!connection;
  const expanded = sessionItems.length > 0 || isStreaming;
  // 快捷面板只有一行的位置，显示人话正文；详情留给主窗口的错误条展开区。
  const displayError = error || inlineError?.text || null;
  const title = sessionTitle || t('quickChat.title');

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [attachments.length, draft, expanded]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const height = Math.ceil(panel.scrollHeight + 12);
    const mode = expanded ? 'chat' : 'compact';
    const previous = lastResizeRef.current;
    if (previous && previous.mode === mode && Math.abs(previous.height - height) < 2) return;
    lastResizeRef.current = { mode, height };
    window.luc?.quickChatResize?.({ mode, height });
  }, [attachments.length, displayError, draft, expanded, sessionItems, isStreaming]);

  useQuickChatAutoScroll({
    expanded,
    isStreaming,
    scrollRef: transcriptScrollRef,
    sessionItems,
    sessionPath,
  });

  return (
    <div
      className={classNames(styles.host, expanded && styles.expanded)}
      onDrop={handleDrop}
      onDragOver={(event) => event.preventDefault()}
    >
      <section ref={panelRef} className={styles.panel}>
        {expanded && sessionPath && (
          <>
            <div className={styles.titleBar}>
              <div className={styles.titleLeft}>
                <button
                  type="button"
                  className={styles.closeButton}
                  aria-label={t('quickChat.close')}
                  onClick={closeQuickChat}
                >
                  <CloseIcon />
                </button>
                <div className={styles.threadTitle}>{title}</div>
              </div>
              <button className={styles.openSessionButton} onClick={openFullSession} disabled={!sessionPath}>
                {t('quickChat.openFullSession')}
              </button>
            </div>
            <div className={styles.windowBody}>
              <div className={styles.thread}>
                <div className={styles.messages} ref={transcriptScrollRef}>
                  <div ref={transcriptContentRef} className={chatStyles.subagentPreviewTranscript}>
                    {sessionItems.length === 0 && isStreaming ? (
                      <div className={styles.emptyTranscript}>{t('quickChat.waitingReply')}</div>
                    ) : (
                      <ChatTranscript
                        items={sessionItems}
                        sessionPath={sessionPath}
                        agentId={selectedAgentId}
                        readOnly={false}
                        enableProcessFold
                        onForkCreated={handleForkCreated}
                      />
                    )}
                    {isStreaming && (
                      <div className={chatStyles.typingIndicator} />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        <div className={classNames(styles.composer, inputStyles['input-wrapper'])}>
          {attachments.length > 0 && (
            <div className={styles.attachmentRow}>
              <AttachedFilesBar
                files={attachments.map((item) => ({
                  path: item.id,
                  name: item.name,
                  base64Data: item.base64Data,
                  mimeType: item.mimeType,
                }))}
                onRemove={(index) => {
                  const target = attachments[index];
                  if (target) removeAttachment(target.id);
                }}
              />
            </div>
          )}

          <textarea
            className={classNames(inputStyles['input-box'], styles.textarea)}
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !isComposingRef.current && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            placeholder={t('input.placeholder')}
            spellCheck={false}
            rows={expanded ? 2 : 3}
          />

          <div className={classNames(inputStyles['input-bottom-bar'], styles.dragBottomBar)}>
            <div className={inputStyles['input-actions']}>
              <button className={inputStyles['attach-btn']} title={t('quickChat.attachImage')} onClick={() => fileInputRef.current?.click()}>
                <PlusIcon />
              </button>
              <span className={styles.lockedPlanMode}>
                <PlanModeButton mode={permissionMode} onChange={() => {}} locked />
              </span>
            </div>

            <div className={classNames(inputStyles['input-controls'], styles.rightControls)}>
              <div className={classNames(inputStyles['model-pill'], styles.agentIdentityPill)} aria-label={normalizeAgentName(selectedAgent)}>
                <span className={styles.agentAvatarWrap}>
                  {selectedAgent && connection ? (
                    <img
                      className={styles.agentAvatar}
                      src={buildConnectionUrl(connection, `/api/agents/${encodeURIComponent(selectedAgent.id)}/avatar`, { includeTokenQuery: true })}
                      alt=""
                      onError={(event) => { (event.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : null}
                  <span className={styles.agentInitial}>{agentInitial(selectedAgent)}</span>
                </span>
                <span className={styles.agentName}>{normalizeAgentName(selectedAgent)}</span>
              </div>

              <SendButton
                isStreaming={false}
                hasInput={!!draft.trim() || attachments.length > 0}
                disabled={!canSend}
                onSend={() => void send()}
                onSteer={() => {}}
                onStop={() => {}}
              />
            </div>
          </div>

          {displayError && <div className={styles.errorLine}>{displayError}</div>}
          <input
            ref={fileInputRef}
            className={styles.fileInput}
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files || []));
              event.currentTarget.value = '';
            }}
          />
        </div>

        <div className={styles.dragStrip} />
      </section>
    </div>
  );
}
