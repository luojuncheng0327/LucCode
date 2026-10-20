import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { AudioWaveform } from '../../stores/chat-types';
import {
  AUDIO_WAVEFORM_DISPLAY,
  AUDIO_WAVEFORM_RENDER,
  displayPeakCountForWaveWidth,
  normalizePeaksForDisplay,
  resamplePeaksForDisplay,
} from '../../utils/audio-waveform';
import styles from './AudioAttachmentChip.module.css';

export interface AudioAttachmentFile {
  path: string;
  name: string;
  base64Data?: string;
  mimeType?: string;
  waveform?: AudioWaveform;
}

interface AudioAttachmentChipProps {
  file: AudioAttachmentFile;
  showAt?: boolean;
  showName?: boolean;
  onRemove?: () => void;
  className?: string;
  waveform?: AudioWaveform;
}

const FALLBACK_PEAKS = [0.28, 0.62, 0.44, 0.82, 0.36, 0.72, 0.32, 0.54, 0.78, 0.44, 0.66, 0.28];

export const AudioAttachmentChip = memo(function AudioAttachmentChip({
  file,
  showAt = false,
  showName = true,
  onRemove,
  className,
  waveform,
}: AudioAttachmentChipProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(true);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(() => waveformDurationSeconds(waveform || file.waveform) || 0);
  const src = useMemo(() => getAudioUrl(file), [file]);
  const fallbackDisplayPeakCount = showName ? AUDIO_WAVEFORM_DISPLAY.compact : AUDIO_WAVEFORM_DISPLAY.voiceInput;
  const [displayPeakCount, setDisplayPeakCount] = useState<number>(fallbackDisplayPeakCount);
  const peaks = useMemo(
    () => normalizePeaksForDisplay(
      resamplePeaksForDisplay(normalizePeaks(waveform || file.waveform), displayPeakCount),
    ),
    [displayPeakCount, file.waveform, waveform],
  );
  const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;

  const detachAudio = (resetProgress = false) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.ontimeupdate = null;
      audioRef.current.onloadedmetadata = null;
    }
    audioRef.current = null;
    if (mountedRef.current) {
      setPlaying(false);
      if (resetProgress) setCurrentTime(0);
    }
  };

  useEffect(() => () => {
    mountedRef.current = false;
    detachAudio();
  }, []);

  useEffect(() => {
    setDuration(waveformDurationSeconds(waveform || file.waveform) || 0);
    setCurrentTime(0);
    detachAudio();
  }, [file.path, file.base64Data, file.mimeType, file.waveform, waveform]);

  useEffect(() => {
    setDisplayPeakCount(fallbackDisplayPeakCount);
  }, [fallbackDisplayPeakCount]);

  useEffect(() => {
    const node = waveRef.current;
    if (!node) return undefined;

    const update = () => {
      const next = displayPeakCountForWaveWidth(node.clientWidth, {
        fallback: fallbackDisplayPeakCount,
        barWidthPx: AUDIO_WAVEFORM_RENDER.barWidthPx,
        barGapPx: AUDIO_WAVEFORM_RENDER.barGapPx,
      });
      setDisplayPeakCount((current) => (current === next ? current : next));
    };
    update();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update);
      observer.observe(node);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [fallbackDisplayPeakCount]);

  const ensureAudio = () => {
    if (audioRef.current) return audioRef.current;
    if (!src) return null;
    const audio = new Audio(src);
    audioRef.current = audio;
    audio.onloadedmetadata = () => {
      if (audioRef.current !== audio || !mountedRef.current) return;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };
    audio.ontimeupdate = () => {
      if (audioRef.current !== audio || !mountedRef.current) return;
      setCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    };
    audio.onended = () => {
      if (audioRef.current !== audio || !mountedRef.current) return;
      setPlaying(false);
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setCurrentTime(audio.duration);
      }
    };
    audio.onerror = () => {
      if (audioRef.current === audio) detachAudio();
    };
    return audio;
  };

  const toggle = () => {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }

    const audio = ensureAudio();
    if (!audio) return;
    setPlaying(true);
    const playResult = audio.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => {
        if (audioRef.current === audio) {
          setPlaying(false);
        }
      });
    }
  };

  const seekOnWave = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    const audio = ensureAudio();
    const knownDuration = duration || waveformDurationSeconds(waveform || file.waveform);
    if (!audio || !knownDuration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const nextTime = Math.max(0, Math.min(1, ratio)) * knownDuration;
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const rootClassName = [
    styles.chip,
    !showName ? styles.noName : '',
    className || '',
  ].filter(Boolean).join(' ');

  return (
    <span className={rootClassName} title={file.name}>
      {showAt && <span className={styles.at} aria-hidden="true">@</span>}
      <button
        type="button"
        className={`${styles.play}${playing ? ` ${styles.isPlaying}` : ''}`}
        onClick={toggle}
        aria-label={playing ? `Pause ${file.name}` : `Play ${file.name}`}
        disabled={!src}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button
        type="button"
        className={styles.wave}
        onClick={seekOnWave}
        disabled={!src}
        aria-label={`Seek ${file.name}`}
        data-testid="audio-attachment-wave"
        ref={waveRef}
        style={{ '--audio-wave-bar-count': peaks.length } as CSSProperties}
      >
        {peaks.map((peak, index) => (
          <span
            key={`${index}-${peak}`}
            className={index <= Math.floor(progress * (peaks.length - 1)) && progress > 0 ? styles.isPlayed : undefined}
            style={{ height: `${Math.max(5, Math.round(5 + peak * 11))}px` }}
            data-audio-wave-bar="true"
          />
        ))}
      </button>
      {showName && <span className={styles.name}>{file.name}</span>}
      {onRemove && (
        <button
          type="button"
          className={styles.remove}
          onClick={() => {
            detachAudio(true);
            onRemove();
          }}
          aria-label={`Remove ${file.name}`}
        >
          <RemoveIcon />
        </button>
      )}
    </span>
  );
});

function normalizePeaks(waveform?: AudioWaveform): number[] {
  if (!waveform?.peaks?.length) return FALLBACK_PEAKS;
  return waveform.peaks
    .map((peak) => Number(peak))
    .filter((peak) => Number.isFinite(peak))
    .map((peak) => Math.max(0, Math.min(1, peak)));
}

function waveformDurationSeconds(waveform?: AudioWaveform): number {
  const ms = Number(waveform?.durationMs);
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
}

function getAudioUrl(file: AudioAttachmentFile): string | null {
  if (file.base64Data && file.mimeType) {
    return `data:${file.mimeType};base64,${file.base64Data}`;
  }
  if (typeof window === 'undefined') return null;
  return window.platform?.getFileUrl?.(file.path) || null;
}

function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.14v13.72L18.8 12 8 5.14z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
