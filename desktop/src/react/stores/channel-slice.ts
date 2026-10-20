import type { AgentPhoneToolMode, Channel, ChannelAgentActivities, ChannelMessage, ChannelTickerStatusMap } from '../types';

export interface ChannelSlice {
  channels: Channel[];
  currentChannel: string | null;
  channelMessages: ChannelMessage[];
  channelMessageCache: Record<string, ChannelMessage[]>;
  channelMessageCacheDirty: Record<string, boolean>;
  channelMembers: string[];
  channelTotalUnread: number;
  channelsEnabled: boolean | undefined;
  channelHeaderName: string;
  channelHeaderMembersText: string;
  channelInfoName: string;
  channelIsDM: boolean;
  channelAgentActivities: ChannelAgentActivities;
  channelTickerStatus: ChannelTickerStatusMap;
  channelAgentPhoneToolMode: AgentPhoneToolMode;
  channelAgentReplyMinChars: number | null;
  channelAgentReplyMaxChars: number | null;
  channelAgentProactiveEnabled: boolean;
  channelAgentReminderIntervalMinutes: number;
  channelAgentGuardLimit: number;
  channelAgentModelOverrideEnabled: boolean;
  channelAgentModelOverrideModel: { id: string; provider: string } | null;
  setChannels: (channels: Channel[]) => void;
  setCurrentChannel: (channel: string | null) => void;
  setChannelMessages: (messages: ChannelMessage[]) => void;
  setChannelTotalUnread: (count: number) => void;
  setChannelsEnabled: (enabled: boolean | undefined) => void;
}

export const createChannelSlice = (
  set: (partial: Partial<ChannelSlice>) => void,
): ChannelSlice => ({
  channels: [],
  currentChannel: null,
  channelMessages: [],
  channelMessageCache: {},
  channelMessageCacheDirty: {},
  channelMembers: [],
  channelTotalUnread: 0,
  channelsEnabled: undefined,
  channelHeaderName: '',
  channelHeaderMembersText: '',
  channelInfoName: '',
  channelIsDM: false,
  channelAgentActivities: {},
  channelTickerStatus: {},
  channelAgentPhoneToolMode: 'read_only',
  channelAgentReplyMinChars: null,
  channelAgentReplyMaxChars: null,
  channelAgentProactiveEnabled: true,
  channelAgentReminderIntervalMinutes: 31,
  channelAgentGuardLimit: 36,
  channelAgentModelOverrideEnabled: false,
  channelAgentModelOverrideModel: null,
  setChannels: (channels) => set({ channels }),
  setCurrentChannel: (channel) => set({ currentChannel: channel }),
  setChannelMessages: (messages) => set({ channelMessages: messages }),
  setChannelTotalUnread: (count) => set({ channelTotalUnread: count }),
  setChannelsEnabled: (enabled) => set({ channelsEnabled: enabled }),
});
