import React, { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from './store';
import { lucFetch } from './api';
import {
  createLocalServerConnection,
  readPersistedServerConnectionState,
  refreshLocalServerConnectionState,
  upsertServerConnection,
  type ServerConnection,
} from '../services/server-connection';
import { t } from './helpers';
import { loadAgents, loadAvatars, loadSettingsSnapshot } from './actions';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { SettingsNav } from './SettingsNav';
import { Toast } from './Toast';
import { AgentTab } from './tabs/AgentTab';
import { MeTab } from './tabs/MeTab';
import { InterfaceTab } from './tabs/InterfaceTab';
import { GeneralTab } from './tabs/GeneralTab';
import { BrowserTab } from './tabs/BrowserTab';
import { WorkTab } from './tabs/WorkTab';
import { SkillsTab } from './tabs/SkillsTab';
import { McpTab } from './tabs/McpTab';
import { BridgeTab } from './tabs/BridgeTab';
import { ProvidersTab } from './tabs/ProvidersTab';
import { MediaTab } from './tabs/MediaTab';
import { AboutTab } from './tabs/AboutTab';
import { PluginsTab } from './tabs/PluginsTab';
import { PluginMarketplaceTab } from './tabs/PluginMarketplaceTab';
import { ExperimentsTab } from './tabs/ExperimentsTab';
import { SecurityTab } from './tabs/SecurityTab';
import { SharingTab } from './tabs/SharingTab';
import { AccessTab } from './tabs/AccessTab';
import { CropOverlay } from './overlays/CropOverlay';
import { AgentCreateOverlay } from './overlays/AgentCreateOverlay';
import { AgentDeleteOverlay } from './overlays/AgentDeleteOverlay';
import { MemoryViewer } from './overlays/MemoryViewer';
import { CompiledMemoryViewer } from './overlays/CompiledMemoryViewer';
import { ClearMemoryConfirm } from './overlays/ClearMemoryConfirm';
import { BridgeTutorial } from './overlays/BridgeTutorial';
import { WechatQrcodeOverlay } from './overlays/WechatQrcodeOverlay';
import { InputContextMenu } from '../components/InputContextMenu';
import { SettingsPage } from './components/SettingsPrimitives';
import styles from './Settings.module.css';

const TAB_COMPONENTS: Record<string, React.ComponentType> = {
  agent: AgentTab,
  me: MeTab,
  interface: InterfaceTab,
  general: GeneralTab,
  browser: BrowserTab,
  work: WorkTab,
  skills: SkillsTab,
  mcp: McpTab,
  bridge: BridgeTab,
  providers: ProvidersTab,
  media: MediaTab,
  sharing: SharingTab,
  access: AccessTab,
  plugins: PluginsTab,
  experiments: ExperimentsTab,
  'plugin-marketplace': PluginMarketplaceTab,
  security: SecurityTab,
  about: AboutTab,
};

function connectionState(connection: ServerConnection | null) {
  const persisted = readPersistedServerConnectionState();
  const serverConnections = connection
    ? upsertServerConnection(persisted.serverConnections, connection)
    : persisted.serverConnections;
  const persistedActive = persisted.activeServerConnectionId
    ? serverConnections[persisted.activeServerConnectionId] || null
    : null;
  const activeServerConnection = persistedActive || connection || null;
  return {
    serverConnections,
    activeServerConnectionId: activeServerConnection?.connectionId ?? null,
    activeServerConnection,
  };
}

/** Tab 顶部大标题（对应左栏导航 label），所有 tab 都会显示 */
const TAB_TITLE_KEYS: Record<string, string> = {
  agent: 'settings.tabs.agent',
  me: 'settings.tabs.me',
  interface: 'settings.tabs.interface',
  general: 'settings.tabs.general',
  browser: 'settings.tabs.browser',
  work: 'settings.tabs.work',
  workflow: 'Workflow',
  skills: 'settings.tabs.skills',
  mcp: 'settings.tabs.mcp',
  bridge: 'settings.tabs.bridge',
  providers: 'settings.tabs.providers',
  media: 'settings.tabs.media',
  sharing: 'settings.tabs.sharing',
  access: 'settings.tabs.access',
  plugins: 'settings.tabs.plugins',
  experiments: 'settings.tabs.experiments',
  'plugin-marketplace': 'settings.tabs.pluginMarketplace',
  security: 'settings.tabs.security',
  about: 'settings.tabs.about',
};

const TAB_DESCRIPTION_KEYS: Record<string, string> = {
  experiments: 'settings.experiments.description',
};

function normalizeSettingsTab(tab: string): string {
  return tab === 'computer' ? 'experiments' : tab;
}

interface SettingsContentProps {
  variant: 'window' | 'modal';
  onClose?: () => void;
  onActiveTabChange?: (tab: string) => void;
  listenToWindowTabSwitch?: boolean;
}

export function SettingsContent({
  variant,
  onClose,
  onActiveTabChange,
  listenToWindowTabSwitch = false,
}: SettingsContentProps) {
  const { activeTab, ready } = useSettingsStore(
    useShallow(s => ({ activeTab: s.activeTab, ready: s.ready }))
  );
  const set = useSettingsStore(s => s.set);
  const lastReportedActiveTabRef = useRef<string | null>(null);

  useEffect(() => {
    initSettings();
  }, []);

  useEffect(() => {
    if (!listenToWindowTabSwitch) return;
    const platform = window.platform;
    if (!platform?.onSwitchTab) return;
    const unsubscribe = platform.onSwitchTab((tab: string) => {
      const nextTab = normalizeSettingsTab(tab);
      set({ activeTab: nextTab });
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, [listenToWindowTabSwitch, set]);

  useEffect(() => {
    const platform = window.platform;
    if (!platform?.onSettingsChanged) return;
    const unsubscribe = platform.onSettingsChanged((type: string, data: unknown) => {
      if (type !== 'skills-changed') return;
      window.dispatchEvent(new CustomEvent('luc-skills-changed', { detail: data || {} }));
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, []);

  useEffect(() => {
    const nextTab = normalizeSettingsTab(activeTab);
    if (nextTab !== activeTab) {
      set({ activeTab: nextTab });
      lastReportedActiveTabRef.current = nextTab;
      onActiveTabChange?.(nextTab);
    }
  }, [activeTab, set, onActiveTabChange]);

  // Server 重启后用新端口重新加载数据
  useEffect(() => {
    const platform = window.platform;
    if (!platform?.onServerRestarted) return;
    const unsubscribe = platform.onServerRestarted((data: { port: number; token?: string | null }) => {
      const store = useSettingsStore.getState();
      console.log('[settings] server restarted, new port:', data.port);
      const serverToken = data.token ?? store.serverToken;
      const nextConnectionState = refreshLocalServerConnectionState({
        serverConnections: store.serverConnections,
        activeServerConnectionId: store.activeServerConnectionId,
        activeServerConnection: store.activeServerConnection,
        serverPort: data.port,
        serverToken,
      });
      store.set({
        serverPort: data.port,
        serverToken,
        ...nextConnectionState,
      });
      loadAgents().catch(() => {});
      loadSettingsSnapshot().catch(() => {});
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, []);

  const effectiveActiveTab = normalizeSettingsTab(activeTab);
  const ActiveTab = TAB_COMPONENTS[effectiveActiveTab] || AgentTab;
  const isModal = variant === 'modal';
  const tabTitleKey = TAB_TITLE_KEYS[effectiveActiveTab];
  const activeTabTitle = tabTitleKey ? t(tabTitleKey) : '';
  const activeTabDescriptionKey = TAB_DESCRIPTION_KEYS[effectiveActiveTab];
  const activeTabDescription = activeTabDescriptionKey ? t(activeTabDescriptionKey) : '';
  const reportActiveTabChange = useCallback((tab: string) => {
    const nextTab = normalizeSettingsTab(tab);
    lastReportedActiveTabRef.current = nextTab;
    onActiveTabChange?.(nextTab);
  }, [onActiveTabChange]);

  useEffect(() => {
    if (lastReportedActiveTabRef.current === null) {
      lastReportedActiveTabRef.current = effectiveActiveTab;
      return;
    }
    if (lastReportedActiveTabRef.current === effectiveActiveTab) return;
    lastReportedActiveTabRef.current = effectiveActiveTab;
    onActiveTabChange?.(effectiveActiveTab);
  }, [effectiveActiveTab, onActiveTabChange]);

  return (
    <ErrorBoundary region="settings">
      <div className={styles['settings-content-root']} data-input-ctx-zone="settings">
        <div
          className={`settings-panel ${isModal ? styles['settings-panel-modal'] : ''}`}
          id="settingsPanel"
        >
          <div className={`settings-header ${isModal ? styles['settings-header-modal'] : ''}`}>
            {isModal ? (
              <>
                <div className={styles['settings-title-group']}>
                  <button
                    type="button"
                    className={styles['settings-return-btn']}
                    onClick={onClose}
                    aria-label={t('settings.back')}
                    data-settings-return
                  >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <h1 className={styles['settings-title']}>{t('settings.title')}</h1>
                </div>
                <h1 className={styles['settings-header-tab-title']}>{activeTabTitle}</h1>
              </>
            ) : (
              <h1 className={styles['settings-title']}>{t('settings.title')}</h1>
            )}
          </div>
          <div className={styles['settings-body']}>
            <SettingsNav onTabChange={reportActiveTabChange} />
            <div className={styles['settings-main']}>
              {!isModal && (
                <div className={styles['settings-tab-heading']}>
                  <h1 className={styles['settings-tab-title']}>{activeTabTitle}</h1>
                  {activeTabDescription && (
                    <p className={styles['settings-tab-description']}>{activeTabDescription}</p>
                  )}
                </div>
              )}
              <ErrorBoundary region={effectiveActiveTab} resetKeys={[effectiveActiveTab]}>
                <SettingsPage tab={effectiveActiveTab}>
                  <ActiveTab />
                </SettingsPage>
              </ErrorBoundary>
            </div>
          </div>
          <CompiledMemoryViewer />
        </div>

        <Toast />
        <CropOverlay />
        <AgentCreateOverlay />
        <AgentDeleteOverlay />
        <MemoryViewer />
        <ClearMemoryConfirm />
        <BridgeTutorial />
        <WechatQrcodeOverlay />
        {/* 独立设置窗口需要自己的右键菜单；应用内 modal 复用 App 已挂载的那份，避免叠两层 */}
        {variant === 'window' && <InputContextMenu />}

        {!ready && (
          <div className="settings-loading-mask" id="settingsLoadingMask">
            <div className={styles['settings-loading-text']}>
              loading...
            </div>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}

/** 初始化：加载 port/token → i18n → agents → 头像 → config */
async function initSettings() {
  const platform = window.platform;
  const store = useSettingsStore.getState();
  store.set({ ready: false });

  // 超时保护：15 秒后强制显示，防止无限白屏
  const timeout = setTimeout(() => {
    if (!useSettingsStore.getState().ready) {
      console.warn('[settings] init timeout (15s), forcing ready');
      useSettingsStore.getState().set({ ready: true });
    }
  }, 15_000);

  try {
    const rawServerPort = typeof platform?.getServerPort === 'function'
      ? await platform.getServerPort()
      : null;
    const serverPort = rawServerPort === null || rawServerPort === undefined
      ? null
      : Number(rawServerPort);
    const serverToken = typeof platform?.getServerToken === 'function'
      ? await platform.getServerToken()
      : null;
    let platformName: string | null = null;
    try {
      platformName = typeof platform?.getPlatform === 'function' ? await platform.getPlatform() : null;
    } catch {
      platformName = null;
    }
    store.set({
      serverPort,
      serverToken,
      platformName,
      ...connectionState(createLocalServerConnection({ serverPort, serverToken })),
    });

    // i18n
    const i18n = window.i18n;
    try {
      const cfgRes = await lucFetch('/api/config');
      const cfg = await cfgRes.json();
      const locale = cfg.locale || 'zh-CN';
      await i18n.load(locale);
    } catch {
      try { await i18n.load('zh-CN'); } catch { /* i18n fallback failed, continue */ }
    }

    // agents
    await loadAgents();

    // avatars
    await loadAvatars();

    // Unified backend settings truth source.
    await loadSettingsSnapshot();

    store.set({ ready: true });
  } catch (err) {
    console.error('[settings] init failed:', err);
    store.set({ ready: true }); // 即使失败也移除 mask，让用户能操作
  } finally {
    clearTimeout(timeout);
  }
}
