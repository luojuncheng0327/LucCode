/**
 * channel-actions.ts — Channel 副作用操作（网络请求 + 状态联动）
 *
 * 从 channel-slice.ts 提取，所有函数通过 useStore.getState() / useStore.setState() 访问 store。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- API 响应 JSON 及 catch(err: any) */

import { useStore } from './index';
import { lucFetch } from '../hooks/use-luc-fetch';
import { hasServerConnection } from '../services/server-connection';
import type { AgentPhoneActivity, AgentPhoneSettings, AgentPhoneToolMode, Channel, ChannelAgentActivities, ChannelMessage } from '../types';

// ══════════════════════════════════════════════════════
// 加载频道列表
// ══════════════════════════════════════════════════════

export async function loadChannels(): Promise<void> {
  const s = useStore.getState();
  if (!hasServerConnection(s)) return;
  try {
    const [chRes, dmRes] = await Promise.all([
      lucFetch('/api/channels'),
      lucFetch('/api/dm'),
    ]);

    const chData = chRes.ok ? await chRes.json() : { channels: [] };
    const dmData = dmRes.ok ? await dmRes.json() : { dms: [] };

    const channels: Channel[] = (chData.channels || []).map((ch: any) => ({
      ...ch,
      isDM: false,
    }));

    const dms: Channel[] = (dmData.dms || []).map((dm: any) => {
      const dmOwnerId = dm.ownerAgentId || dmData.ownerAgentId || undefined;
      return {
        id: `dm:${dm.peerId}`,
        name: dm.peerName || dm.peerId,
        members: [dm.peerId],
        lastMessage: dm.lastMessage || '',
        lastSender: dm.lastSender || '',
        lastTimestamp: dm.lastTimestamp || '',
        newMessageCount: 0,
        messageCount: dm.messageCount || 0,
        isDM: true,
        dmOwnerId,
        peerId: dm.peerId,
        peerName: dm.peerName,
      };
    });

    const allChannels = [...channels, ...dms];
    const totalUnread = allChannels.reduce((sum, ch) => sum + (ch.newMessageCount || 0), 0);
    useStore.setState({ channels: allChannels, channelTotalUnread: totalUnread });
  } catch (err) {
    console.error('[channels] load failed:', err);
  }
}

function keyActivities(activities: AgentPhoneActivity[]): Record<string, AgentPhoneActivity[]> {
  const keyed: Record<string, AgentPhoneActivity[]> = {};
  for (const activity of activities || []) {
    if (!activity?.agentId) continue;
    keyed[activity.agentId] = [activity];
  }
  return keyed;
}

export async function loadConversationAgentActivities(conversationId: string): Promise<void> {
  const s = useStore.getState();
  if (!conversationId || !hasServerConnection(s)) return;
  try {
    const res = await lucFetch(`/api/conversations/${encodeURIComponent(conversationId)}/agent-activities`);
    if (!res.ok) return;
    const data = await res.json();
    const activities = keyActivities(data.activities || []);
    const latestState = useStore.getState();
    const current = (latestState.channelAgentActivities || {}) as ChannelAgentActivities;
    useStore.setState({
      channelAgentActivities: {
        ...current,
        [conversationId]: activities,
      },
      channelTickerStatus: {
        ...(latestState.channelTickerStatus || {}),
        [conversationId]: data.ticker || null,
      },
    });
  } catch (err) {
    console.error('[channels] load agent activities failed:', err);
  }
}

export function upsertConversationAgentActivity(activity: AgentPhoneActivity): void {
  if (!activity?.conversationId || !activity.agentId) return;
  const state = useStore.getState();
  const current = (state.channelAgentActivities || {}) as ChannelAgentActivities;
  const byAgent = current[activity.conversationId] || {};
  const history = byAgent[activity.agentId] || [];
  const nextHistory = [
    activity,
    ...history.filter((item: AgentPhoneActivity) =>
      item.timestamp !== activity.timestamp || item.state !== activity.state || item.summary !== activity.summary),
  ].slice(0, 20);

  useStore.setState({
    channelAgentActivities: {
      ...current,
      [activity.conversationId]: {
        ...byAgent,
        [activity.agentId]: nextHistory,
      },
    },
  });
}

function normalizeAgentPhoneToolMode(mode: unknown): AgentPhoneToolMode {
  return mode === 'write' ? 'write' : 'read_only';
}

function conversationOwnerQuery(conversationId: string): string {
  if (!conversationId.startsWith('dm:')) return '';
  const channel = useStore.getState().channels.find((ch: Channel) => ch.id === conversationId);
  return channel?.dmOwnerId ? `?agentId=${encodeURIComponent(channel.dmOwnerId)}` : '';
}

function conversationPhoneSettingsUrl(conversationId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/agent-phone-settings${conversationOwnerQuery(conversationId)}`;
}

function normalizeNullablePositiveInt(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function normalizeAgentPhoneSettings(data: any): AgentPhoneSettings {
  const overrideModel = data?.modelOverrideModel;
  return {
    mode: normalizeAgentPhoneToolMode(data?.mode),
    replyMinChars: normalizeNullablePositiveInt(data?.replyMinChars),
    replyMaxChars: normalizeNullablePositiveInt(data?.replyMaxChars),
    proactiveEnabled: data?.proactiveEnabled !== false,
    reminderIntervalMinutes: normalizeNullablePositiveInt(data?.reminderIntervalMinutes) || 31,
    guardLimit: normalizeNullablePositiveInt(data?.guardLimit) || 36,
    modelOverrideEnabled: data?.modelOverrideEnabled === true,
    modelOverrideModel: overrideModel?.id && overrideModel?.provider
      ? { id: String(overrideModel.id), provider: String(overrideModel.provider) }
      : null,
  };
}

function applyAgentPhoneSettings(settings: AgentPhoneSettings): void {
  useStore.setState({
    channelAgentPhoneToolMode: settings.mode,
    channelAgentReplyMinChars: settings.replyMinChars,
    channelAgentReplyMaxChars: settings.replyMaxChars,
    channelAgentProactiveEnabled: settings.proactiveEnabled,
    channelAgentReminderIntervalMinutes: settings.reminderIntervalMinutes,
    channelAgentGuardLimit: settings.guardLimit,
    channelAgentModelOverrideEnabled: settings.modelOverrideEnabled,
    channelAgentModelOverrideModel: settings.modelOverrideModel,
  });
}

function applyChannelMembers(channelId: string, members: string[]): void {
  const state = useStore.getState();
  const t = typeof window !== 'undefined' && window.t ? window.t : ((key: string) => key);
  const displayMembers = [state.userName || 'user', ...members];
  useStore.setState({
    channelMembers: state.currentChannel === channelId ? members : state.channelMembers,
    channelHeaderMembersText: state.currentChannel === channelId
      ? `${displayMembers.length} ${t('channel.membersCount')}`
      : state.channelHeaderMembersText,
    channels: state.channels.map((channel: Channel) =>
      channel.id === channelId ? { ...channel, members } : channel,
    ),
  });
}

export async function loadConversationAgentPhoneToolMode(conversationId: string): Promise<void> {
  await loadConversationAgentPhoneSettings(conversationId);
}

export async function loadConversationAgentPhoneSettings(conversationId: string): Promise<void> {
  const s = useStore.getState();
  if (!conversationId || !hasServerConnection(s)) return;
  try {
    const res = await lucFetch(conversationPhoneSettingsUrl(conversationId));
    if (!res.ok) {
      applyAgentPhoneSettings({
        mode: 'read_only',
        replyMinChars: null,
        replyMaxChars: null,
        proactiveEnabled: true,
        reminderIntervalMinutes: 31,
        guardLimit: 36,
        modelOverrideEnabled: false,
        modelOverrideModel: null,
      });
      return;
    }
    const data = await res.json();
    applyAgentPhoneSettings(normalizeAgentPhoneSettings(data));
  } catch (err) {
    console.error('[channels] load phone settings failed:', err);
    applyAgentPhoneSettings({
      mode: 'read_only',
      replyMinChars: null,
      replyMaxChars: null,
      proactiveEnabled: true,
      reminderIntervalMinutes: 31,
      guardLimit: 36,
      modelOverrideEnabled: false,
      modelOverrideModel: null,
    });
  }
}

export async function setConversationAgentPhoneToolMode(mode: AgentPhoneToolMode): Promise<void> {
  await saveConversationAgentPhoneSettings({ mode });
}

export async function saveConversationAgentPhoneSettings(patch: Partial<AgentPhoneSettings>): Promise<void> {
  const s = useStore.getState();
  const conversationId = s.currentChannel;
  if (!conversationId || !hasServerConnection(s)) return;
  const res = await lucFetch(conversationPhoneSettingsUrl(conversationId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: patch.mode !== undefined ? normalizeAgentPhoneToolMode(patch.mode) : s.channelAgentPhoneToolMode,
      replyMinChars: patch.replyMinChars !== undefined ? patch.replyMinChars : s.channelAgentReplyMinChars,
      replyMaxChars: patch.replyMaxChars !== undefined ? patch.replyMaxChars : s.channelAgentReplyMaxChars,
      proactiveEnabled: patch.proactiveEnabled !== undefined ? patch.proactiveEnabled : s.channelAgentProactiveEnabled,
      reminderIntervalMinutes: patch.reminderIntervalMinutes !== undefined ? patch.reminderIntervalMinutes : s.channelAgentReminderIntervalMinutes,
      guardLimit: patch.guardLimit !== undefined ? patch.guardLimit : s.channelAgentGuardLimit,
      modelOverrideEnabled: patch.modelOverrideEnabled !== undefined ? patch.modelOverrideEnabled : s.channelAgentModelOverrideEnabled,
      modelOverrideModel: patch.modelOverrideModel !== undefined ? patch.modelOverrideModel : s.channelAgentModelOverrideModel,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  applyAgentPhoneSettings(normalizeAgentPhoneSettings(data));
}

// ══════════════════════════════════════════════════════
// 打开频道
// ══════════════════════════════════════════════════════

export async function openChannel(channelId: string, isDM?: boolean): Promise<void> {
  const s = useStore.getState();
  const ch = s.channels.find((c: Channel) => c.id === channelId);
  const isThisDM = isDM ?? ch?.isDM ?? false;
  const t = window.t;
  const cachedMessages = s.channelMessageCache[channelId] || [];

  // 立刻切换 + 清空旧数据，防止残留上一个频道的内容
  // DM 时从 channel 列表提取 peerId，即使 API 失败也能显示 agent 信息
  const peerId = isThisDM ? (ch?.peerId || channelId.replace('dm:', '')) : '';
  const peerName = isThisDM ? (ch?.name || peerId) : '';
  const dmOwnerId = isThisDM ? ch?.dmOwnerId : undefined;
  useStore.setState({
    currentChannel: channelId,
    channelMessages: cachedMessages,
    channelMembers: isThisDM ? [peerId] : [],
    channelHeaderName: isThisDM ? peerName : '',
    channelHeaderMembersText: '',
    channelIsDM: isThisDM,
    channelInfoName: isThisDM ? peerName : '',
  });

  try {
    if (isThisDM) {
      const ownerQuery = dmOwnerId ? `?agentId=${encodeURIComponent(dmOwnerId)}` : '';
      const res = await lucFetch(`/api/dm/${encodeURIComponent(peerId)}${ownerQuery}`);
      if (res.ok) {
        const data = await res.json();
        const responseOwnerId = data.ownerAgentId || dmOwnerId;
        const messages = data.messages || [];
        const fresh = useStore.getState();
        useStore.setState({
          channelMessages: messages,
          channelMessageCache: {
            ...fresh.channelMessageCache,
            [channelId]: messages,
          },
          channelMessageCacheDirty: {
            ...fresh.channelMessageCacheDirty,
            [channelId]: false,
          },
          channelHeaderName: data.peerName || peerName,
          channelInfoName: data.peerName || peerName,
          channels: responseOwnerId
            ? fresh.channels.map((channel: Channel) =>
              channel.id === channelId ? { ...channel, dmOwnerId: responseOwnerId } : channel)
            : fresh.channels,
        });
      }
      // 404 = 没有历史，基本信息已在上方设置，不需要额外处理
    } else {
      const res = await lucFetch(`/api/channels/${encodeURIComponent(channelId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const members = data.members || [];
      const displayMembers = [useStore.getState().userName || 'user', ...members];
      const messages = data.messages || [];
      const fresh = useStore.getState();
      useStore.setState({
        channelMessages: messages,
        channelMessageCache: {
          ...fresh.channelMessageCache,
          [channelId]: messages,
        },
        channelMessageCacheDirty: {
          ...fresh.channelMessageCacheDirty,
          [channelId]: false,
        },
        channelMembers: members,
        channelHeaderName: `# ${data.name || channelId}`,
        channelHeaderMembersText: `${displayMembers.length} ${t('channel.membersCount')}`,
        channelIsDM: false,
        channelInfoName: data.name || channelId,
      });

      // Mark as read
      const msgs = messages;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg) {
        lucFetch(`/api/channels/${encodeURIComponent(channelId)}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: lastMsg.timestamp }),
        }).catch((err: unknown) => console.warn('[channel-actions] mark-as-read failed', err));

        // 重新取 store 最新状态，避免覆盖 await 期间的并发更新
        const fresh = useStore.getState();
        const freshCh = fresh.channels.find((c: Channel) => c.id === channelId);
        if (freshCh) {
          const newTotal = Math.max(0, fresh.channelTotalUnread - (freshCh.newMessageCount || 0));
          const updatedChannels = fresh.channels.map((c: Channel) =>
            c.id === channelId ? { ...c, newMessageCount: 0 } : c,
          );
          useStore.setState({ channelTotalUnread: newTotal, channels: updatedChannels });
        }
      }
    }
    loadConversationAgentActivities(channelId).catch((err: unknown) =>
      console.warn('[channel-actions] load agent activities failed', err));
    loadConversationAgentPhoneToolMode(channelId).catch((err: unknown) =>
      console.warn('[channel-actions] load phone tool mode failed', err));
  } catch (err) {
    console.error('[channels] open failed:', err);
  }
}

function sameChannelMessage(a: ChannelMessage, b: ChannelMessage): boolean {
  return a.sender === b.sender && a.timestamp === b.timestamp && a.body === b.body;
}

function sortChannelsByRecent(channels: Channel[]): Channel[] {
  return [...channels].sort((a, b) =>
    (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''),
  );
}

function sameCachedMessage(a: ChannelMessage, b: ChannelMessage): boolean {
  return sameChannelMessage(a, b);
}

export function markChannelMessagesDirty(channelId: string): void {
  if (!channelId) return;
  const state = useStore.getState();
  useStore.setState({
    channelMessageCacheDirty: {
      ...state.channelMessageCacheDirty,
      [channelId]: true,
    },
  });
}

export async function hydrateCurrentChannelIfNeeded(): Promise<void> {
  const state = useStore.getState();
  const channelId = state.currentChannel;
  if (!channelId) return;

  const cached = state.channelMessageCache[channelId];
  const dirty = state.channelMessageCacheDirty[channelId] === true;
  if (cached) {
    useStore.setState({ channelMessages: cached });
  }
  if (!cached || dirty) {
    const channel = state.channels.find((item: Channel) => item.id === channelId);
    await openChannel(channelId, channel?.isDM);
  }
}

// ══════════════════════════════════════════════════════
// 增量追加频道消息
// ══════════════════════════════════════════════════════

export function appendChannelMessage(
  channelId: string,
  message: ChannelMessage,
  options: { markRead?: boolean; countUnread?: boolean } = { markRead: true },
): void {
  if (
    !channelId
    || typeof message?.sender !== 'string'
    || typeof message.timestamp !== 'string'
    || typeof message.body !== 'string'
  ) return;

  const state = useStore.getState();
  const isCurrentChannel = state.currentChannel === channelId;
  const cachedMessages = state.channelMessageCache[channelId];
  const baseMessages = cachedMessages || (isCurrentChannel ? state.channelMessages : []);
  const alreadyInCache = baseMessages.some((m: ChannelMessage) => sameCachedMessage(m, message));
  const nextMessages = alreadyInCache ? baseMessages : [...baseMessages, message];
  const shouldMarkRead = isCurrentChannel && options.markRead === true;
  const shouldCountUnread = !shouldMarkRead && options.countUnread !== false;
  const nextCacheDirty = state.channelMessageCacheDirty[channelId] === true
    || (!cachedMessages && !isCurrentChannel);

  let unreadDelta = 0;
  let readDelta = 0;
  const updatedChannels = state.channels.map((channel: Channel) => {
    if (channel.id !== channelId) return channel;

    const isDuplicatePreview =
      channel.lastSender === message.sender
      && channel.lastTimestamp === message.timestamp
      && channel.lastMessage === message.body.slice(0, 60);

    const previousUnread = channel.newMessageCount || 0;
    const nextUnread = shouldMarkRead ? 0 : previousUnread + (
      shouldCountUnread && !isDuplicatePreview ? 1 : 0
    );

    if (shouldMarkRead) {
      readDelta = previousUnread;
    } else {
      unreadDelta += nextUnread - previousUnread;
    }

    return {
      ...channel,
      lastMessage: message.body.slice(0, 60),
      lastSender: message.sender,
      lastTimestamp: message.timestamp,
      messageCount: (channel.messageCount || 0) + (isDuplicatePreview ? 0 : 1),
      newMessageCount: nextUnread,
    };
  });

  const patch: Partial<ReturnType<typeof useStore.getState>> = {
    channels: sortChannelsByRecent(updatedChannels),
    channelMessageCache: {
      ...state.channelMessageCache,
      [channelId]: nextMessages,
    },
    channelMessageCacheDirty: {
      ...state.channelMessageCacheDirty,
      [channelId]: nextCacheDirty,
    },
    channelTotalUnread: Math.max(0, state.channelTotalUnread + unreadDelta - readDelta),
  };

  if (isCurrentChannel) {
    patch.channelMessages = nextMessages;
  }

  useStore.setState(patch);

  if (shouldMarkRead) {
    Promise.resolve(lucFetch(`/api/channels/${encodeURIComponent(channelId)}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: message.timestamp }),
    })).catch((err: unknown) => console.warn('[channel-actions] mark-as-read failed', err));
  }
}

// ══════════════════════════════════════════════════════
// 发送消息
// ══════════════════════════════════════════════════════

export async function sendChannelMessage(text: string): Promise<void> {
  const s = useStore.getState();
  const channelId = s.currentChannel;
  const body = text.trim();
  if (!body || !channelId) return;
  const sender = s.userName || 'user';

  try {
    const res = await lucFetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok && data.timestamp) {
      appendChannelMessage(channelId, {
        sender,
        timestamp: data.timestamp,
        body: text,
      }, { markRead: true, countUnread: false });
    }
  } catch (err) {
    console.error('[channels] send failed:', err);
  }
}

function exportedArchiveFilename(disposition: string | null): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { /* use fallback */ }
  }
  const plain = disposition?.match(/filename="([^"]+)"/i)?.[1];
  return plain || 'luc-chat-archive.md';
}

export async function exportCurrentConversation(): Promise<string> {
  const conversationId = useStore.getState().currentChannel;
  if (!conversationId) throw new Error('No active conversation');
  const ownerQuery = conversationOwnerQuery(conversationId);
  const res = await lucFetch(`/api/conversations/${encodeURIComponent(conversationId)}/export${ownerQuery}`);
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }

  const blob = await res.blob();
  const filename = exportedArchiveFilename(res.headers.get('content-disposition'));
  const downloadUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    URL.revokeObjectURL(downloadUrl);
  }
  return filename;
}

// ══════════════════════════════════════════════════════
// 删除频道
// ══════════════════════════════════════════════════════

export async function deleteChannel(channelId: string): Promise<void> {
  const s = useStore.getState();
  try {
    const res = await lucFetch(`/api/channels/${encodeURIComponent(channelId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      if (s.currentChannel === channelId) {
        useStore.setState({
          currentChannel: null,
          channelMessages: [],
          channelHeaderName: '',
          channelHeaderMembersText: '',
          channelIsDM: false,
        });
      }
      // Reload channels
      await loadChannels();
    } else {
      console.error('[channels] delete failed:', data.error);
    }
  } catch (err) {
    console.error('[channels] delete failed:', err);
  }
}

// ══════════════════════════════════════════════════════
// 频道成员管理
// ══════════════════════════════════════════════════════

export async function addChannelMember(channelId: string, memberId: string): Promise<void> {
  const res = await lucFetch(`/api/channels/${encodeURIComponent(channelId)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  applyChannelMembers(channelId, data.members || []);
}

export async function removeChannelMember(channelId: string, memberId: string): Promise<void> {
  const res = await lucFetch(`/api/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(memberId)}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  applyChannelMembers(channelId, data.members || []);
}

// ══════════════════════════════════════════════════════
// 切换频道功能开关
// ══════════════════════════════════════════════════════

export async function toggleChannelsEnabled(): Promise<boolean | undefined> {
  const s = useStore.getState();
  if (s.channelsEnabled === undefined) return undefined;
  const previousEnabled = s.channelsEnabled;
  const newEnabled = !s.channelsEnabled;

  try {
    const res = await lucFetch('/api/channels/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newEnabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const enabled = typeof data.enabled === 'boolean' ? data.enabled : newEnabled;
    useStore.setState({ channelsEnabled: enabled });

    if (enabled) {
      await loadChannels();
    } else {
      useStore.setState({
        channels: [],
        currentChannel: null,
        channelMessages: [],
        channelMessageCache: {},
        channelMessageCacheDirty: {},
        channelMembers: [],
        channelTotalUnread: 0,
        channelHeaderName: '',
        channelHeaderMembersText: '',
        channelInfoName: '',
        channelIsDM: false,
      });
    }

    return enabled;
  } catch (err) {
    console.error('[channels] toggle backend failed:', err);
    useStore.setState({ channelsEnabled: previousEnabled });
    return previousEnabled;
  }
}

// ══════════════════════════════════════════════════════
// 创建频道
// ══════════════════════════════════════════════════════

export async function createChannel(name: string, members: string[], intro?: string): Promise<string | null> {
  try {
    const res = await lucFetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        members,
        intro: intro || undefined,
      }),
      throwOnHttpError: false,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.error) throw new Error(data.error);

    await loadChannels();
    if (data.id) {
      await openChannel(data.id);
    }
    return data.id || null;
  } catch (err: any) {
    console.error('[channels] create failed:', err);
    throw err;
  }
}
