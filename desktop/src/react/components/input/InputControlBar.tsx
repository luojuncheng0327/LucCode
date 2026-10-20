import { memo, type RefObject } from 'react';
import { PlanModeButton, type PermissionMode } from './PlanModeButton';
import { ContextRing } from './ContextRing';
import { ThinkingLevelButton } from './ThinkingLevelButton';
import { ModelSelector } from './ModelSelector';
import { SendButton } from './SendButton';
import type { ThinkingLevel } from '../../stores/model-slice';
import type { Model } from '../../types';
import type { SessionModel } from '../../stores/chat-types';
import styles from './InputArea.module.css';

interface Props {
  t: (key: string) => string;
  // 左侧工具按钮
  onAttach: () => void;
  slashBtnRef: RefObject<HTMLButtonElement | null>;
  onSlashToggle: () => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (v: PermissionMode) => void;
  planModeLocked: boolean;
  // 右侧控制
  showThinking: boolean;
  thinkingLevel: ThinkingLevel;
  onThinkingChange: (level: ThinkingLevel) => void;
  availableThinkingLevels: ThinkingLevel[];
  models: Model[];
  sessionModel?: SessionModel;
  isStreaming: boolean;
  hasInput: boolean;
  canSend: boolean;
  showAudioInput: boolean;
  audioRecordingActive: boolean;
  audioRecordingBusy: boolean;
  onAudioToggle: () => void;
  onSend: () => void;
  onSteer: () => void;
  onStop: () => void;
}

/** 编辑器下方的工具按钮行 + 发送控制 */
export const InputControlBar = memo(function InputControlBar(props: Props) {
  const {
    t, onAttach, slashBtnRef, onSlashToggle,
    permissionMode, onPermissionModeChange, planModeLocked,
    showThinking, thinkingLevel, onThinkingChange, availableThinkingLevels,
    models, sessionModel, isStreaming, hasInput, canSend,
    showAudioInput, audioRecordingActive, audioRecordingBusy, onAudioToggle,
    onSend, onSteer, onStop,
  } = props;

  return (
    <div className={styles['input-bottom-bar']}>
      <div className={styles['input-actions']}>
        <button
          className={styles['attach-btn']}
          title={t('input.attachFiles')}
          onClick={onAttach}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          ref={slashBtnRef}
          className={styles['attach-btn']}
          title={t('input.commandMenu')}
          onClick={onSlashToggle}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L14 10L22 12L14 14L12 22L10 14L2 12L10 10Z" />
          </svg>
        </button>
        <PlanModeButton mode={permissionMode} onChange={onPermissionModeChange} locked={planModeLocked} />
        <ContextRing />
      </div>
      <div className={styles['input-controls']}>
        {showThinking ? (
          <div className={styles['model-split-control']}>
            <ThinkingLevelButton level={thinkingLevel} onChange={onThinkingChange} availableLevels={availableThinkingLevels} />
            <ModelSelector models={models} sessionModel={sessionModel} isStreaming={isStreaming} />
          </div>
        ) : (
          <ModelSelector models={models} sessionModel={sessionModel} isStreaming={isStreaming} />
        )}
        {showAudioInput && (
          <button
            type="button"
            className={`${styles['audio-record-btn']}${audioRecordingActive ? ` ${styles['is-recording']}` : ''}`}
            title={t(audioRecordingActive ? 'input.stopRecording' : 'input.recordAudio')}
            aria-label={t(audioRecordingActive ? 'input.stopRecording' : 'input.recordAudio')}
            aria-pressed={audioRecordingActive}
            disabled={audioRecordingBusy}
            onClick={onAudioToggle}
          >
            {audioRecordingActive ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <path d="M12 19v3" />
              </svg>
            )}
          </button>
        )}
        <SendButton isStreaming={isStreaming} hasInput={hasInput}
          disabled={isStreaming ? false : !canSend} onSend={onSend} onSteer={onSteer} onStop={onStop} />
      </div>
    </div>
  );
});
