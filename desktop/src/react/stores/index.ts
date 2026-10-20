import { create } from 'zustand';
import { createConnectionSlice, type ConnectionSlice } from './connection-slice';
import { createSessionSlice, sessionScopedKey, type SessionSlice } from './session-slice';
import { createSessionProjectSlice, type SessionProjectSlice } from './session-project-slice';
import { createStreamingSlice, type StreamingSlice } from './streaming-slice';
import { createUiSlice, type UiSlice } from './ui-slice';
import { createAgentSlice, type AgentSlice } from './agent-slice';
import { createChannelSlice, type ChannelSlice } from './channel-slice';
import { createDeskSlice, type DeskSlice } from './desk-slice';
import { createModelSlice, type ModelSlice } from './model-slice';
import { createInputSlice, type InputSlice } from './input-slice';
import { createChatSlice, type ChatSlice } from './chat-slice';
import { createChatFindSlice, type ChatFindSlice } from './chat-find-slice';
import { createToastSlice, type ToastSlice } from './toast-slice';
import { createPreviewSlice, type PreviewSlice } from './preview-slice';
import { createBrowserSlice, type BrowserSlice } from './browser-slice';
import { createContextSlice, type ContextSlice } from './context-slice';
import { createAutomationSlice, type AutomationSlice } from './automation-slice';
import { createActivitySlice, type ActivitySlice } from './activity-slice';
import { createAgentActivitySlice, type AgentActivitySlice } from './agent-activity-slice';
import { createBridgeSlice, type BridgeSlice } from './bridge-slice';
import { createPluginUiSlice, type PluginUiSlice } from './plugin-ui-slice';
import { createSelectionSlice, type SelectionSlice } from './selection-slice';
import { createSubagentPreviewSlice, type SubagentPreviewSlice } from './subagent-preview-slice';
import { createComputerOverlaySlice, type ComputerOverlaySlice } from './computer-overlay-slice';
import { createScreenshotSlice, type ScreenshotSlice } from './screenshot-slice';
import { createSidebarUiSlice, type SidebarUiSlice } from './sidebar-ui-slice';
import { createFileHistorySlice, type FileHistorySlice } from './file-history-slice';
import { configureMessageLiveVersionSessionKeyResolver } from './message-live-version';

export type StoreState = ConnectionSlice &
  SessionSlice &
  SessionProjectSlice &
  StreamingSlice &
  UiSlice &
  AgentSlice &
  ChannelSlice &
  DeskSlice &
  ModelSlice &
  InputSlice &
  ChatSlice &
  ChatFindSlice &
  ToastSlice &
  PreviewSlice &
  BrowserSlice &
  ContextSlice &
  AutomationSlice &
  ActivitySlice &
  AgentActivitySlice &
  BridgeSlice &
  PluginUiSlice &
  SelectionSlice &
  SubagentPreviewSlice &
  ComputerOverlaySlice &
  ScreenshotSlice &
  SidebarUiSlice &
  FileHistorySlice;

export const useStore = create<StoreState>()((set, _get, _api) => ({
  ...createConnectionSlice(set, _get),
  ...createSessionSlice(set),
  ...createSessionProjectSlice(set),
  ...createStreamingSlice(set, _get),
  ...createUiSlice(set),
  ...createAgentSlice(set),
  ...createChannelSlice(set),
  ...createDeskSlice(set),
  ...createModelSlice(set),
  ...createInputSlice(set),
  ...createChatSlice(set, _get),
  ...createChatFindSlice(set, _get),
  ...createToastSlice(set, _get),
  ...createPreviewSlice(set),
  ...createBrowserSlice(set),
  ...createContextSlice(set),
  ...createAutomationSlice(set),
  ...createActivitySlice(set),
  ...createAgentActivitySlice(set),
  ...createBridgeSlice(set),
  ...createPluginUiSlice(set),
  ...createSelectionSlice(set),
  ...createSubagentPreviewSlice(set),
  ...createComputerOverlaySlice(set),
  ...createScreenshotSlice(set),
  ...createSidebarUiSlice(set, _get),
  ...createFileHistorySlice(set, _get),
}));

configureMessageLiveVersionSessionKeyResolver((sessionPath) => (
  sessionScopedKey(useStore.getState(), sessionPath)
));

// Re-export slice types
export type {
  ConnectionSlice,
  SessionSlice,
  SessionProjectSlice,
  StreamingSlice,
  UiSlice,
  AgentSlice,
  ChannelSlice,
  DeskSlice,
  ModelSlice,
  InputSlice,
  ChatSlice,
  ChatFindSlice,
  ToastSlice,
  PreviewSlice,
  BrowserSlice,
  ContextSlice,
  AutomationSlice,
  ActivitySlice,
  AgentActivitySlice,
  BridgeSlice,
  PluginUiSlice,
  SelectionSlice,
  SubagentPreviewSlice,
  ComputerOverlaySlice,
  ScreenshotSlice,
  SidebarUiSlice,
  FileHistorySlice,
};
