import { useStore } from './index';

const DEFAULT_SETTINGS_TAB = 'agent';

function normalizeSettingsTab(tab?: string | null): string {
  if (!tab) return DEFAULT_SETTINGS_TAB;
  return tab === 'computer' ? 'experiments' : tab;
}

export function openSettingsModal(tab?: string): void {
  const current = useStore.getState().settingsModal;
  const activeTab = tab ? normalizeSettingsTab(tab) : normalizeSettingsTab(current?.activeTab);
  useStore.setState({
    settingsModal: {
      open: true,
      activeTab,
    },
  });
}

export function closeSettingsModal(): void {
  const current = useStore.getState().settingsModal;
  useStore.setState({
    settingsModal: {
      open: false,
      activeTab: normalizeSettingsTab(current?.activeTab),
    },
  });
}

export function setSettingsModalActiveTab(tab: string): void {
  const current = useStore.getState().settingsModal;
  useStore.setState({
    settingsModal: {
      open: current?.open ?? false,
      activeTab: tab ? normalizeSettingsTab(tab) : normalizeSettingsTab(current?.activeTab),
    },
  });
}
