import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../store';
import { lucFetch } from '../api';
import { t, VALID_THEMES, autoSaveConfig } from '../helpers';
import { SelectWidget, Toggle } from '@/ui';
import { SettingsGrid } from '../components/SettingsPrimitives';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { NumberInput } from '../components/NumberInput';
import { StepSlider, type StepSliderOption } from '../components/StepSlider';
import {
  applyChatLayout,
  mergeChatLayout,
  normalizeChatLayout,
  type ChatBodyFontSizeOffset,
  type ChatLayoutContentWidth,
  type ChatLayoutPreferences,
} from '../../chat/layout';
import {
  applyEditorTypography,
  mergeEditorTypography,
  normalizeEditorTypography,
  type EditorMarkdownContentWidth,
  type EditorMarkdownTypography,
} from '../../editor/typography';
import {
  isPaperTextureBlockedTheme,
  isPaperTextureEnabled,
} from '../../../shared/appearance-preferences';
import { persistAppearancePreferences } from '../../services/appearance-sync';
import {
  FOLLOW_READING_FONT_ID,
  READING_FONT_PRESETS,
  fontPresetIdFromSerif,
  normalizeFontSelectionId,
  serifFromFontPresetId,
} from '../../utils/font-presets';
import { readConfigBoolean } from '../resource-state';
import {
  normalizeSidebarUiPrefs,
  type SidebarSessionListRowMode,
  type SidebarUiPrefs,
} from '../../../../../shared/sidebar-ui-state.ts';
import styles from '../Settings.module.css';
import registry from '../../../shared/theme-registry';

const platform = window.platform;
const i18n = window.i18n;

const THEME_NAME_KEYS: Record<string, string> = Object.fromEntries([
  ...Object.entries(registry.THEMES).map(([id, t]: [string, any]) => [id, t.i18nName]),
  [registry.AUTO_OPTION.id, registry.AUTO_OPTION.i18nName],
]);

const THEME_MODE_KEYS: Record<string, string> = Object.fromEntries([
  ...Object.entries(registry.THEMES).map(([id, t]: [string, any]) => [id, t.i18nMode]),
  [registry.AUTO_OPTION.id, registry.AUTO_OPTION.i18nMode],
]);

const VOICE_RECORD_SHORTCUT_MAC = ['⌘', '⇧', 'M'];
const VOICE_RECORD_SHORTCUT_DEFAULT = ['Ctrl', 'Shift', 'M'];

type MarkdownTypographyKey = Exclude<keyof EditorMarkdownTypography, 'fontPreset'>;
type MarkdownNumericTypographyKey = Exclude<MarkdownTypographyKey, 'contentWidth' | 'bodyFontSize'>;
type ReadingContentWidth = EditorMarkdownContentWidth | ChatLayoutContentWidth;

interface AppearancePrefs {
  currentTheme: string;
  serifEnabled: boolean;
  paperTextureEnabled: boolean;
  paperTextureBlocked: boolean;
  leavesOverlayEnabled: boolean;
}

function readAppearancePrefs(): AppearancePrefs {
  const concreteTheme = document.documentElement.getAttribute('data-theme');
  return {
    currentTheme: registry.migrateSavedTheme(localStorage.getItem(registry.STORAGE_KEY)),
    serifEnabled: localStorage.getItem('luc-font-serif') !== '0',
    paperTextureEnabled: isPaperTextureEnabled(localStorage),
    paperTextureBlocked: isPaperTextureBlockedTheme(concreteTheme),
    leavesOverlayEnabled: localStorage.getItem('luc-leaves-overlay') === '1',
  };
}

const EDITOR_FONT_SIZE_ROWS: Array<{
  key: MarkdownNumericTypographyKey;
  label: string;
  hint: string;
  min: number;
  max: number;
}> = [
  { key: 'heading1FontSize', label: 'settings.editor.markdownHeading1FontSize', hint: 'settings.editor.markdownHeading1FontSizeHint', min: 16, max: 40 },
  { key: 'heading2FontSize', label: 'settings.editor.markdownHeading2FontSize', hint: 'settings.editor.markdownHeading2FontSizeHint', min: 15, max: 34 },
  { key: 'heading3FontSize', label: 'settings.editor.markdownHeading3FontSize', hint: 'settings.editor.markdownHeading3FontSizeHint', min: 14, max: 30 },
];

const BODY_FONT_SIZE_OFFSETS = [-2, -1, 0, 1, 2] as const;

const CONTENT_WIDTH_STEPS: Array<{
  value: string;
  width: ReadingContentWidth;
  labelKey?: string;
}> = [
  { value: '640', width: 640 },
  { value: '720', width: 720 },
  { value: '800', width: 800 },
  { value: 'unlimited', width: 'unlimited', labelKey: 'settings.appearance.readingWidthUnlimited' },
];

function formatBodyFontSizeOffset(offset: number): string {
  return offset > 0 ? `+${offset}` : String(offset);
}

export function InterfaceTab() {
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const platformName = useSettingsStore(s => s.platformName);
  const showToast = useSettingsStore(s => s.showToast);
  const [appearancePrefs, setAppearancePrefs] = useState<AppearancePrefs>(() => readAppearancePrefs());
  const [sidebarUiPrefs, setSidebarUiPrefs] = useState<SidebarUiPrefs | null>(null);
  const refreshAppearancePrefs = useCallback(() => {
    setAppearancePrefs(readAppearancePrefs());
  }, []);
  const syncAppearancePrefs = useCallback((patch: Record<string, unknown>) => {
    persistAppearancePreferences(patch).catch((err) => {
      console.warn('[settings] appearance sync failed:', err);
    });
  }, []);
  const {
    currentTheme,
    serifEnabled,
    paperTextureEnabled,
    paperTextureBlocked,
    leavesOverlayEnabled,
  } = appearancePrefs;
  const readingFontPresetId = fontPresetIdFromSerif(serifEnabled);
  const editorTypography = useMemo(
    () => normalizeEditorTypography(settingsConfig?.editor),
    [settingsConfig?.editor],
  );
  const chatLayout = useMemo(
    () => normalizeChatLayout(settingsConfig?.chat),
    [settingsConfig?.chat],
  );
  const contentWidthOptions: Array<StepSliderOption & { width: ReadingContentWidth }> = CONTENT_WIDTH_STEPS.map(option => {
    const label = option.labelKey ? t(option.labelKey) : option.value;
    const valueLabel = option.width === 'unlimited' ? t('settings.appearance.readingWidthUnlimited') : option.value;
    return {
      value: option.value,
      width: option.width,
      label,
      valueLabel,
    };
  });
  const bodyFontSizeOptions: Array<StepSliderOption & { offset: ChatBodyFontSizeOffset }> = BODY_FONT_SIZE_OFFSETS.map(offset => {
    const label = formatBodyFontSizeOffset(offset);
    return {
      value: String(offset),
      offset,
      label,
      valueLabel: label,
    };
  });
  const fontSelectOptions = [
    { value: FOLLOW_READING_FONT_ID, label: t('settings.fonts.followReading') },
    ...READING_FONT_PRESETS.map(preset => ({
      value: preset.id,
      label: t(preset.labelKey),
    })),
  ];
  const hardwareAccelerationEnabled = readConfigBoolean(settingsConfig, cfg => cfg.hardware_acceleration, true);
  const voiceShortcutKeys = platformName === 'darwin'
    ? VOICE_RECORD_SHORTCUT_MAC
    : VOICE_RECORD_SHORTCUT_DEFAULT;

  useEffect(() => {
    let cancelled = false;
    lucFetch('/api/preferences/sidebar-ui')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        setSidebarUiPrefs(normalizeSidebarUiPrefs(data?.sidebarUi));
      })
      .catch(err => {
        if (!cancelled) console.warn('[settings] sidebar UI preferences load failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveEditorTypography = async (patch: Partial<EditorMarkdownTypography>) => {
    const previousConfig = useSettingsStore.getState().settingsConfig || {};
    const previousEditor = previousConfig.editor;
    const next = mergeEditorTypography(previousEditor, { markdown: patch });
    useSettingsStore.setState({ settingsConfig: { ...previousConfig, editor: next } });
    applyEditorTypography(next);
    platform?.settingsChanged?.('editor-typography-changed', { editor: next });

    const saved = await autoSaveConfig({ editor: next }, { silent: true });
    if (saved) {
      useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
      return;
    }

    const restored = normalizeEditorTypography(previousEditor);
    useSettingsStore.setState({ settingsConfig: previousConfig });
    applyEditorTypography(restored);
    platform?.settingsChanged?.('editor-typography-changed', { editor: restored });
  };

  const saveChatLayout = async (patch: Partial<ChatLayoutPreferences>) => {
    const previousConfig = useSettingsStore.getState().settingsConfig || {};
    const previousChat = previousConfig.chat;
    const next = mergeChatLayout(previousChat, patch);
    useSettingsStore.setState({ settingsConfig: { ...previousConfig, chat: next } });
    applyChatLayout(next);
    platform?.settingsChanged?.('chat-layout-changed', { chat: next });

    const saved = await autoSaveConfig({ chat: next }, { silent: true });
    if (saved) {
      useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
      return;
    }

    const restored = normalizeChatLayout(previousChat);
    useSettingsStore.setState({ settingsConfig: previousConfig });
    applyChatLayout(restored);
    platform?.settingsChanged?.('chat-layout-changed', { chat: restored });
  };

  const saveHardwareAcceleration = async (next: boolean) => {
    const previousConfig = useSettingsStore.getState().settingsConfig || {};
    useSettingsStore.setState({ settingsConfig: { ...previousConfig, hardware_acceleration: next } });

    const saved = await autoSaveConfig({ hardware_acceleration: next }, { silent: true });
    if (saved) {
      platform?.settingsChanged?.('hardware-acceleration-changed', { hardware_acceleration: next });
      useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
      return;
    }

    useSettingsStore.setState({ settingsConfig: previousConfig });
  };

  const saveSessionListRowMode = useCallback(async (singleLine: boolean) => {
    const previousPrefs = sidebarUiPrefs;
    const basePrefs = previousPrefs ?? normalizeSidebarUiPrefs({});
    const rowMode: SidebarSessionListRowMode = singleLine ? 'single-line' : 'two-line';
    const optimistic = normalizeSidebarUiPrefs({
      ...basePrefs,
      sessionList: { ...basePrefs.sessionList, rowMode },
    });
    setSidebarUiPrefs(optimistic);
    try {
      const res = await lucFetch('/api/preferences/sidebar-ui', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionList: { rowMode } }),
      });
      const data = await res.json();
      const saved = normalizeSidebarUiPrefs(data?.sidebarUi);
      setSidebarUiPrefs(saved);
      window.dispatchEvent(new CustomEvent('luc-settings', {
        detail: { type: 'sidebar-ui-changed', sidebarUi: saved },
      }));
      window.platform?.settingsChanged?.('sidebar-ui-changed', { sidebarUi: saved });
    } catch (err: unknown) {
      setSidebarUiPrefs(previousPrefs);
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [showToast, sidebarUiPrefs]);

  const locale = settingsConfig?.locale || 'zh-CN';
  const localeVal = ['zh-CN', 'zh-TW', 'ja', 'ko', 'en'].includes(locale) ? locale
    : locale.startsWith('zh') ? 'zh-CN'
    : locale.startsWith('ja') ? 'ja'
    : locale.startsWith('ko') ? 'ko'
    : 'en';

  // 时区
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const commonTz = [
    'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
    'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Kolkata',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'Pacific/Auckland', 'Australia/Sydney',
  ];
  const tzSet = new Set(commonTz);
  if (browserTz && !tzSet.has(browserTz)) commonTz.unshift(browserTz);
  const currentTz = settingsConfig?.timezone || browserTz || 'Asia/Shanghai';
  if (!tzSet.has(currentTz) && currentTz !== browserTz) commonTz.unshift(currentTz);
  const tzOptions = commonTz.map(tz => {
    try {
      const offset = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date()).find((p: any) => p.type === 'timeZoneName')?.value || '';
      return { value: tz, label: `${tz.replace(/_/g, ' ')}  (${offset})` };
    } catch { return { value: tz, label: tz.replace(/_/g, ' ') }; }
  });

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="interface">
      <SettingsSection title={t('settings.appearance.theme')} surface="plain">
        <SettingsGrid columns={3} className={styles['theme-options']}>
          {VALID_THEMES.map(theme => (
            <button
              key={theme}
              className={`${styles['theme-card']}${currentTheme === theme ? ' ' + styles['active'] : ''}`}
              data-theme={theme}
              onClick={() => {
                window.setTheme?.(theme);
                platform?.settingsChanged?.('theme-changed', { theme });
                syncAppearancePrefs({ theme });
                refreshAppearancePrefs();
              }}
            >
              <div className={styles['theme-card-name']}>{t(THEME_NAME_KEYS[theme])}</div>
              <div className={styles['theme-card-mode']}>{t(THEME_MODE_KEYS[theme])}</div>
            </button>
          ))}
        </SettingsGrid>
      </SettingsSection>

      <SettingsSection
        title={t('settings.appearance.font')}
        description={t('settings.appearance.fontHint')}
        surface="plain"
      >
        <SettingsGrid columns={2} className={styles['font-options']} aria-label={t('settings.appearance.font')}>
          {READING_FONT_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              className={`${styles['font-card']}${readingFontPresetId === preset.id ? ' ' + styles['active'] : ''}`}
              aria-pressed={readingFontPresetId === preset.id}
              onClick={() => {
                const next = serifFromFontPresetId(preset.id);
                window.setSerifFont?.(next);
                platform?.settingsChanged?.('font-changed', { serif: next });
                syncAppearancePrefs({ serif: next });
                refreshAppearancePrefs();
              }}
            >
              <span className={styles['font-card-sample']} style={{ fontFamily: preset.fontFamily }}>
                {t(preset.labelKey)}
              </span>
              <span className={styles['font-card-desc']}>{t(preset.descriptionKey)}</span>
            </button>
          ))}
        </SettingsGrid>
        <SettingsSection.Card>
          <SettingsRow
            label={t('settings.appearance.bodyFontSizeOffset')}
            hint={t('settings.appearance.bodyFontSizeOffsetHint')}
            control={
              <StepSlider
                ariaLabel={t('settings.appearance.bodyFontSizeOffset')}
                options={bodyFontSizeOptions}
                value={String(chatLayout.bodyFontSizeOffset)}
                onChange={(value) => {
                  const option = bodyFontSizeOptions.find(item => item.value === value);
                  if (option) saveChatLayout({ bodyFontSizeOffset: option.offset });
                }}
              />
            }
          />
          <SettingsRow
            label={t('settings.appearance.chatWidth')}
            hint={t('settings.appearance.chatWidthHint')}
            control={
              <StepSlider
                ariaLabel={t('settings.appearance.chatWidth')}
                options={contentWidthOptions}
                value={String(chatLayout.contentWidth)}
                onChange={(value) => {
                  const option = contentWidthOptions.find(item => item.value === value);
                  if (option) saveChatLayout({ contentWidth: option.width as ChatLayoutContentWidth });
                }}
              />
            }
          />
        </SettingsSection.Card>
      </SettingsSection>

      <SettingsSection title={t('settings.appearance.title')}>
        <SettingsRow
          label={t('settings.appearance.paperTexture')}
          hint={paperTextureBlocked
            ? t('settings.appearance.paperTextureDarkDisabledHint')
            : t('settings.appearance.paperTextureHint')}
          control={
            <Toggle
              on={paperTextureBlocked ? false : paperTextureEnabled}
              disabled={paperTextureBlocked}
              onChange={(next) => {
                window.setPaperTexture?.(next);
                platform?.settingsChanged?.('paper-texture-changed', { enabled: next });
                syncAppearancePrefs({ paperTexture: next });
                refreshAppearancePrefs();
              }}
            />
          }
        />
        <SettingsRow
          label={t('settings.appearance.leavesOverlay')}
          hint={t('settings.appearance.leavesOverlayHint')}
          control={
            <Toggle
              on={leavesOverlayEnabled}
              onChange={(next) => {
                localStorage.setItem('luc-leaves-overlay', next ? '1' : '0');
                window.dispatchEvent(new CustomEvent('luc-settings', {
                  detail: { type: 'leaves-overlay-changed', enabled: next },
                }));
                platform?.settingsChanged?.('leaves-overlay-changed', { enabled: next });
                syncAppearancePrefs({ leavesOverlay: next });
                refreshAppearancePrefs();
              }}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.interface.system')}>
        <SettingsRow
          label={t('settings.interface.hardwareAcceleration')}
          hint={t('settings.interface.hardwareAccelerationHint')}
          control={
            <Toggle
              on={hardwareAccelerationEnabled}
              onChange={saveHardwareAcceleration}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.interface.sidebar')}>
        <SettingsRow
          label={t('settings.interface.sessionListSingleLine')}
          hint={t('settings.interface.sessionListSingleLineHint')}
          control={
            <Toggle
              on={sidebarUiPrefs ? sidebarUiPrefs.sessionList.rowMode === 'single-line' : undefined}
              onChange={saveSessionListRowMode}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.editor.title')}>
        <SettingsRow
          label={t('settings.editor.markdownFont')}
          hint={t('settings.editor.markdownFontHint')}
          control={
            <SelectWidget
              options={fontSelectOptions}
              value={editorTypography.markdown.fontPreset}
              onChange={(value) => saveEditorTypography({
                fontPreset: normalizeFontSelectionId(value, {
                  allowFollow: true,
                  fallback: FOLLOW_READING_FONT_ID,
                }),
              })}
            />
          }
        />
        <SettingsRow
          label={t('settings.editor.markdownBodyFontSize')}
          hint={t('settings.editor.markdownBodyFontSizeHint')}
          control={
            <NumberInput
              value={editorTypography.markdown.bodyFontSize}
              onChange={(value) => saveEditorTypography({ bodyFontSize: value })}
              unit="px"
              min={12}
              max={24}
            />
          }
        />
        <SettingsRow
          label={t('settings.editor.markdownContentWidth')}
          hint={t('settings.editor.markdownContentWidthHint')}
          control={
            <StepSlider
              ariaLabel={t('settings.editor.markdownContentWidth')}
              options={contentWidthOptions}
              value={String(editorTypography.markdown.contentWidth)}
              onChange={(value) => {
                const option = contentWidthOptions.find(item => item.value === value);
                if (option) saveEditorTypography({ contentWidth: option.width as EditorMarkdownContentWidth });
              }}
            />
          }
        />
        {EDITOR_FONT_SIZE_ROWS.map(row => (
          <SettingsRow
            key={row.key}
            label={t(row.label)}
            hint={t(row.hint)}
            control={
              <NumberInput
                value={editorTypography.markdown[row.key]}
                onChange={(value) => saveEditorTypography({ [row.key]: value })}
                unit="px"
                min={row.min}
                max={row.max}
              />
            }
          />
        ))}
        <SettingsRow
          label={t('settings.editor.markdownLineHeight')}
          hint={t('settings.editor.markdownLineHeightHint')}
          control={
            <NumberInput
              value={editorTypography.markdown.lineHeight}
              onChange={(value) => saveEditorTypography({ lineHeight: value })}
              min={1.2}
              max={2.2}
              step={0.05}
              precision="float"
            />
          }
        />
        <SettingsRow
          label={t('settings.editor.markdownContentPadding')}
          hint={t('settings.editor.markdownContentPaddingHint')}
          control={
            <NumberInput
              value={editorTypography.markdown.contentPadding}
              onChange={(value) => saveEditorTypography({ contentPadding: value })}
              unit="px"
              min={0}
              max={64}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.locale.title')}>
        <SettingsRow
          label={t('settings.locale.language')}
          hint={t('settings.locale.languageHint')}
          control={
            <SelectWidget
              options={[
                { value: 'zh-CN', label: t('settings.locale.zhCN') },
                { value: 'zh-TW', label: t('settings.locale.zhTW') },
                { value: 'ja', label: t('settings.locale.ja') },
                { value: 'ko', label: t('settings.locale.ko') },
                { value: 'en', label: t('settings.locale.en') },
              ]}
              value={localeVal}
              onChange={async (val) => {
                await autoSaveConfig({ locale: val }, { silent: true });
                await i18n?.load(val);
                if (i18n) i18n.defaultName = useSettingsStore.getState().agentName;
                useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
                useSettingsStore.setState({});
              }}
            />
          }
        />
        <SettingsRow
          label={t('settings.locale.timezone')}
          hint={t('settings.locale.timezoneHint')}
          control={
            <SelectWidget
              options={tzOptions}
              value={currentTz}
              onChange={(val) => autoSaveConfig({ timezone: val })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.interface.shortcuts')}>
        <SettingsRow
          label={t('settings.interface.voiceRecordingShortcut')}
          hint={t('settings.interface.voiceRecordingShortcutHint')}
          control={
            <div
              className={styles['shortcut-keycaps']}
              aria-label={voiceShortcutKeys.join(' + ')}
            >
              {voiceShortcutKeys.map(key => (
                <kbd key={key} className={styles['shortcut-keycap']}>{key}</kbd>
              ))}
            </div>
          }
        />
      </SettingsSection>
    </div>
  );
}
