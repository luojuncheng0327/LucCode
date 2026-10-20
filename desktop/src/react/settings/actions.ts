/**
 * Settings shared actions — extracted from SettingsApp to avoid circular imports
 */
import { useSettingsStore } from './store';
import { lucFetch, lucUrl } from './api';
import { t } from './helpers';
import { errorWithCode, localizedReasonOrRaw } from '../errors/error-presenter';
import { normalizeSessionRouteError } from '../../../../shared/error-user-messages.ts';
import {
  createRemoteResource,
  failRemoteLoad,
  finishRemoteLoad,
  makeSettingsResourceKey,
  startRemoteLoad,
} from './resource-state';
import type { SettingsSnapshot } from './store';

let _settingsConfigLoadVersion = 0;
let _settingsConfigAbortController: AbortController | null = null;
let _settingsSnapshotLoadVersion = 0;
let _settingsSnapshotAbortController: AbortController | null = null;

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

export async function loadAgents() {
  const store = useSettingsStore.getState();
  try {
    const res = await lucFetch('/api/agents');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const agents = data.agents || [];
    let currentAgentId = store.currentAgentId;
    if (!currentAgentId) {
      const primary = agents.find((a: any) => a.isPrimary) || agents[0];
      if (primary) currentAgentId = primary.id;
    }
    const currentAgent = agents.find((a: any) => a.id === currentAgentId);
    store.set({
      agents,
      currentAgentId,
      agentYuan: currentAgent?.yuan || store.agentYuan,
      agentName: currentAgent?.name || store.agentName,
    });
  } catch (err) {
    console.error('[agents] load failed:', err);
  }
}

/**
 * 设置页的头像。user 头像与 agent 无关，直接取 health 的可用性标记；
 * agent 头像属于设置页当前选中的那个 agent —— 它未必是服务端正在聚焦的
 * agent，所以可用性从 agents 列表里那一条读，URL 也显式带上 agentId。
 */
export async function loadAvatars() {
  const ts = Date.now();
  const store = useSettingsStore.getState();
  try {
    const res = await lucFetch('/api/health');
    const data = await res.json();
    const avatars = data.avatars || {};
    const agentId = store.getSettingsAgentId();
    const agent = agentId ? (store.agents || []).find((a: any) => a.id === agentId) : null;

    store.set({
      userAvatarUrl: avatars.user ? lucUrl(`/api/avatar/user?t=${ts}`) : null,
      agentAvatarUrl: agentId && agent?.hasAvatar
        ? lucUrl(`/api/avatar/agent?agentId=${encodeURIComponent(agentId)}&t=${ts}`)
        : null,
    });
  } catch {}
}

export async function loadSettingsConfig() {
  const store = useSettingsStore.getState();
  const myVersion = ++_settingsConfigLoadVersion;
  if (_settingsConfigAbortController) {
    _settingsConfigAbortController.abort();
  }
  const controller = new AbortController();
  _settingsConfigAbortController = controller;
  const agentId = store.getSettingsAgentId();
  const resourceKey = makeSettingsResourceKey('config', agentId, store.activeServerConnectionId);
  const keepSameOwnerData = store.settingsConfigKey === resourceKey;
  store.set({
    settingsConfigKey: resourceKey,
    settingsConfigStatus: 'loading',
    settingsConfigError: null,
    ...(keepSameOwnerData ? {} : {
      settingsConfig: null,
      globalModelsConfig: null,
      homeFolder: null,
      currentPins: [],
    }),
  });
  if (!agentId || !resourceKey) {
    store.set({
      settingsConfigStatus: 'error',
      settingsConfigError: 'No settings agent selected',
      settingsConfig: null,
      globalModelsConfig: null,
      homeFolder: null,
      currentPins: [],
    });
    return;
  }
  try {
    const agentBase = `/api/agents/${agentId}`;
    const [configRes, identityRes, agentsMdRes, publicAgentsMdRes, userProfileRes, pinnedRes, globalModelsRes] =
      await Promise.all([
        lucFetch(`${agentBase}/config`, { signal: controller.signal }),
        lucFetch(`${agentBase}/identity`, { signal: controller.signal }),
        lucFetch(`${agentBase}/agents-md`, { signal: controller.signal }),
        lucFetch(`${agentBase}/public-agents-md`, { signal: controller.signal }),
        lucFetch('/api/user-profile', { signal: controller.signal }),
        lucFetch(`${agentBase}/pinned`, { signal: controller.signal }),
        lucFetch('/api/preferences/models', { signal: controller.signal }),
      ]);

    const config = await configRes.json();
    const globalModels = await globalModelsRes.json();
    const identityData = await identityRes.json();
    config._identity = identityData.content || '';
    const agentsMdData = await agentsMdRes.json();
    config._agents = agentsMdData.content || '';
    const publicAgentsMdData = await publicAgentsMdRes.json();
    config._publicAgents = publicAgentsMdData.content || '';
    const userProfileData = await userProfileRes.json();
    config._userProfile = userProfileData.content || '';
    const pinnedData = await pinnedRes.json();
    config._experience = '';
    if (config.experience?.enabled === true) {
      const experienceRes = await lucFetch(`${agentBase}/experience`, { signal: controller.signal });
      const experienceData = await experienceRes.json();
      config._experience = experienceData.content || '';
    }
    if (myVersion !== _settingsConfigLoadVersion) return;
    if (_settingsConfigAbortController !== controller) return;
    const latest = useSettingsStore.getState();
    if (latest.settingsConfigKey !== resourceKey) return;

    store.set({
      settingsConfigKey: resourceKey,
      settingsConfigStatus: 'ready',
      settingsConfigError: null,
      settingsConfig: config,
      globalModelsConfig: globalModels,
      homeFolder: config.desk?.home_folder || null,
      currentPins: pinnedData.pins || [],
    });
  } catch (err) {
    if (isAbortError(err)) return;
    console.error('[settings] load failed:', err);
    const latest = useSettingsStore.getState();
    if (latest.settingsConfigKey === resourceKey && myVersion === _settingsConfigLoadVersion) {
      store.set({
        settingsConfigStatus: 'error',
        settingsConfigError: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    if (_settingsConfigAbortController === controller) {
      _settingsConfigAbortController = null;
    }
  }
}

function configFromSnapshot(snapshot: SettingsSnapshot): Record<string, any> {
  return {
    ...(snapshot.config || {}),
    _identity: snapshot.identity || '',
    _agents: snapshot.agents || '',
    _publicAgents: snapshot.publicAgents || '',
    _userProfile: snapshot.userProfile || '',
    _experience: snapshot.experience || '',
  };
}

function applySettingsSnapshot(snapshot: SettingsSnapshot, resourceKey: string, requestId: number) {
  const latest = useSettingsStore.getState();
  if (latest.settingsSnapshot.key !== resourceKey || latest.settingsSnapshot.requestId !== requestId) return;
  const config = configFromSnapshot(snapshot);
  const configKey = makeSettingsResourceKey('config', snapshot.agentId, latest.activeServerConnectionId);
  latest.set({
    settingsSnapshot: finishRemoteLoad(latest.settingsSnapshot, resourceKey, requestId, snapshot),
    settingsConfigKey: configKey,
    settingsConfigStatus: 'ready',
    settingsConfigError: null,
    settingsConfig: config,
    globalModelsConfig: snapshot.globalModels || {},
    homeFolder: config.desk?.home_folder || null,
    currentPins: Array.isArray(snapshot.pinned?.pins) ? snapshot.pinned.pins : [],
    pluginSettingsStatus: 'ready',
    pluginSettingsError: null,
    pluginAllowFullAccess: snapshot.plugins?.allowFullAccess === true,
    pluginDevToolsEnabled: snapshot.plugins?.devToolsEnabled === true,
    pluginUserDir: snapshot.plugins?.userDir || '',
  });
}

export function updateSettingsSnapshot(mutator: (snapshot: SettingsSnapshot) => SettingsSnapshot) {
  const store = useSettingsStore.getState();
  const resource = store.settingsSnapshot || createRemoteResource<SettingsSnapshot>();
  if (!resource.data) return;
  const next = mutator(resource.data);
  store.set({
    settingsSnapshot: {
      ...resource,
      data: next,
      updatedAt: Date.now(),
    },
  });
}

export async function loadSettingsSnapshot(options: { retainSameKeyData?: boolean } = {}) {
  const store = useSettingsStore.getState();
  const myVersion = ++_settingsSnapshotLoadVersion;
  if (_settingsSnapshotAbortController) {
    _settingsSnapshotAbortController.abort();
  }
  const controller = new AbortController();
  _settingsSnapshotAbortController = controller;
  const agentId = store.getSettingsAgentId();
  const resourceKey = makeSettingsResourceKey('snapshot', agentId, store.activeServerConnectionId);
  const currentResource = store.settingsSnapshot || createRemoteResource<SettingsSnapshot>();
  const requestId = currentResource.requestId + 1;
  const configKey = makeSettingsResourceKey('config', agentId, store.activeServerConnectionId);
  const retainSameKeyData = options.retainSameKeyData === true;
  const keepSameConfigOwnerData = retainSameKeyData && store.settingsConfigKey === configKey;

  store.set({
    settingsSnapshot: startRemoteLoad(currentResource, resourceKey, requestId, { retainSameKeyData }),
    settingsConfigKey: configKey,
    settingsConfigStatus: 'loading',
    settingsConfigError: null,
    pluginSettingsStatus: 'loading',
    pluginSettingsError: null,
    ...(keepSameConfigOwnerData ? {} : {
      settingsConfig: null,
      globalModelsConfig: null,
      homeFolder: null,
      currentPins: [],
      pluginAllowFullAccess: undefined,
      pluginDevToolsEnabled: undefined,
      pluginUserDir: '',
    }),
  });

  if (!agentId || !resourceKey) {
    const latest = useSettingsStore.getState();
    latest.set({
      settingsSnapshot: failRemoteLoad(latest.settingsSnapshot, resourceKey, requestId, 'No settings agent selected'),
      settingsConfigStatus: 'error',
      settingsConfigError: 'No settings agent selected',
      settingsConfig: null,
      globalModelsConfig: null,
      homeFolder: null,
      currentPins: [],
      pluginSettingsStatus: 'error',
      pluginSettingsError: 'No settings agent selected',
    });
    return;
  }

  try {
    const res = await lucFetch(`/api/settings/snapshot?agentId=${encodeURIComponent(agentId)}`, {
      signal: controller.signal,
    });
    const snapshot = await res.json() as SettingsSnapshot & { error?: string };
    if (snapshot.error) throw new Error(snapshot.error);
    if (myVersion !== _settingsSnapshotLoadVersion) return;
    if (_settingsSnapshotAbortController !== controller) return;
    applySettingsSnapshot(snapshot as SettingsSnapshot, resourceKey, requestId);
  } catch (err) {
    if (isAbortError(err)) return;
    console.error('[settings] snapshot load failed:', err);
    const latest = useSettingsStore.getState();
    if (latest.settingsSnapshot.key === resourceKey && latest.settingsSnapshot.requestId === requestId) {
      latest.set({
        settingsSnapshot: failRemoteLoad(latest.settingsSnapshot, resourceKey, requestId, err),
        settingsConfigStatus: 'error',
        settingsConfigError: err instanceof Error ? err.message : String(err),
        pluginSettingsStatus: 'error',
        pluginSettingsError: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    if (_settingsSnapshotAbortController === controller) {
      _settingsSnapshotAbortController = null;
    }
  }
}

export async function loadPluginSettings() {
  const store = useSettingsStore.getState();
  store.set({
    pluginSettingsStatus: 'loading',
    pluginSettingsError: null,
    pluginAllowFullAccess: store.pluginSettingsStatus === 'idle' ? undefined : store.pluginAllowFullAccess,
    pluginDevToolsEnabled: store.pluginSettingsStatus === 'idle' ? undefined : store.pluginDevToolsEnabled,
  });
  try {
    const settingsRes = await lucFetch('/api/plugins/settings');
    const data = await settingsRes.json();
    if (data.error) throw new Error(data.error);
    store.set({
      pluginSettingsStatus: 'ready',
      pluginSettingsError: null,
      pluginAllowFullAccess: data.allow_full_access === true,
      pluginDevToolsEnabled: data.plugin_dev_tools_enabled === true,
      pluginUserDir: data.plugins_dir || '',
    });
  } catch (err) {
    console.error('[plugins] load settings failed:', err);
    store.set({
      pluginSettingsStatus: 'error',
      pluginSettingsError: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function browseAgent(agentId: string) {
  useSettingsStore.setState({ settingsAgentId: agentId });
  await loadSettingsConfig();
  await loadAgents();
}

export async function switchToAgent(agentId: string) {
  const store = useSettingsStore.getState();
  try {
    const res = await lucFetch('/api/agents/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId }),
    });
    const data = await res.json();
    // 走到这里响应一定是 2xx：非 2xx 已经在 lucFetch 边界抛成带码的异常了。
    // 剩下要防的是 2xx 里仍带 error 字段的老写法，它同样要把码带过 throw。
    if (data.error) {
      const routeError = normalizeSessionRouteError(data);
      throw errorWithCode(routeError.message, routeError.code);
    }

    store.set({
      settingsAgentId: null,
      currentAgentId: data.agent.id,
      agentName: data.agent.name,
    });
    await loadSettingsConfig();
    await loadAgents();
    store.showToast(t('settings.agent.switched', { name: data.agent.name }), 'success');
  } catch (err: any) {
    console.error('[agents] switch failed:', err);
    store.showToast(t('settings.agent.switchFailed') + ': ' + localizedReasonOrRaw(err, t), 'error');
  }
}

export async function setPrimaryAgent(agentId: string) {
  const store = useSettingsStore.getState();
  try {
    const res = await lucFetch('/api/agents/primary', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId }),
    });
    const data = await res.json();
    // 同 switchToAgent：非 2xx 已在 lucFetch 边界抛成带码的异常，这里只补 2xx 带
    // error 字段的老写法，同样要把码带过 throw，catch 才有得翻。
    if (data.error) {
      const routeError = normalizeSessionRouteError(data);
      throw errorWithCode(routeError.message, routeError.code);
    }

    await loadAgents();
    store.showToast(t('settings.agent.setPrimary'), 'success');
  } catch (err: any) {
    console.error('[agents] set primary failed:', err);
    store.showToast(t('settings.agent.setPrimaryFailed') + ': ' + localizedReasonOrRaw(err, t), 'error');
  }
}
