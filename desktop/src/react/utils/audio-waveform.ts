import type { AudioWaveform } from '../stores/chat-types';

export const AUDIO_WAVEFORM_VERSION = 1;
export const DEFAULT_AUDIO_WAVEFORM_PEAKS = 48;
export const AUDIO_WAVEFORM_DISPLAY = {
  compact: 24,
  voiceInput: 36,
} as const;
export const AUDIO_WAVEFORM_RENDER = {
  barWidthPx: 3,
  barGapPx: 3,
  minDisplayPeaks: 8,
  maxDisplayPeaks: 80,
} as const;
const MAX_AUDIO_WAVEFORM_PEAKS = 160;

export function normalizeAudioWaveform(value: unknown): AudioWaveform | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as { peaks?: unknown; durationMs?: unknown; source?: unknown };
  if (!Array.isArray(record.peaks)) return undefined;
  const peaks = record.peaks
    .slice(0, MAX_AUDIO_WAVEFORM_PEAKS)
    .map((peak) => clampPeak(Number(peak)))
    .filter((peak) => Number.isFinite(peak));
  if (peaks.length === 0) return undefined;
  const durationMs = Number(record.durationMs);
  const source = record.source === 'fallback' ? 'fallback' : 'computed';
  return {
    version: AUDIO_WAVEFORM_VERSION,
    peaks,
    ...(Number.isFinite(durationMs) && durationMs > 0 ? { durationMs } : {}),
    source,
  };
}

export function buildWaveformFromPcmChunks(
  chunks: readonly Float32Array[],
  sampleRate: number,
  peakCount = DEFAULT_AUDIO_WAVEFORM_PEAKS,
): AudioWaveform | undefined {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (totalSamples <= 0) return undefined;
  const targetCount = clampPeakCount(peakCount);
  const samplesPerPeak = Math.max(1, Math.ceil(totalSamples / targetCount));
  const peaks: number[] = [];
  let sampleIndex = 0;
  let max = 0;
  let count = 0;

  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      max = Math.max(max, Math.abs(Number(chunk[i]) || 0));
      count += 1;
      sampleIndex += 1;
      if (count >= samplesPerPeak || sampleIndex >= totalSamples) {
        peaks.push(clampPeak(max));
        max = 0;
        count = 0;
      }
    }
  }

  return normalizeAudioWaveform({
    version: AUDIO_WAVEFORM_VERSION,
    peaks,
    durationMs: sampleRate > 0 ? Math.max(1, Math.round((totalSamples / sampleRate) * 1000)) : undefined,
    source: 'computed',
  });
}

export async function buildWaveformFromBlob(
  blob: Blob,
  peakCount = DEFAULT_AUDIO_WAVEFORM_PEAKS,
): Promise<AudioWaveform | undefined> {
  const AudioContextCtor = window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor || blob.size === 0) return undefined;
  const context = new AudioContextCtor();
  try {
    const buffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(buffer.slice(0));
    return buildWaveformFromAudioBuffer(audioBuffer, peakCount);
  } finally {
    if (context.state !== 'closed') {
      await context.close().catch(() => undefined);
    }
  }
}

export async function buildWaveformFromBase64(
  base64Data: string,
  mimeType: string,
  peakCount = DEFAULT_AUDIO_WAVEFORM_PEAKS,
): Promise<AudioWaveform | undefined> {
  if (!base64Data) return undefined;
  const bytes = Uint8Array.from(atob(base64Data), char => char.charCodeAt(0));
  return buildWaveformFromBlob(new Blob([bytes], { type: mimeType }), peakCount);
}

export function resamplePeaksForDisplay(
  peaks: readonly number[],
  maxDisplayPeaks: number,
): number[] {
  const normalized = peaks
    .map((peak) => clampPeak(Number(peak)))
    .filter((peak) => Number.isFinite(peak));
  const targetCount = Math.max(1, Math.floor(maxDisplayPeaks));
  if (normalized.length === targetCount) return normalized;
  if (normalized.length < targetCount) {
    return interpolatePeaks(normalized, targetCount);
  }

  const samplesPerDisplayPeak = normalized.length / targetCount;
  const display: number[] = [];
  for (let index = 0; index < targetCount; index += 1) {
    const start = Math.floor(index * samplesPerDisplayPeak);
    const end = Math.min(normalized.length, Math.ceil((index + 1) * samplesPerDisplayPeak));
    let max = 0;
    for (let i = start; i < end; i += 1) {
      max = Math.max(max, normalized[i] || 0);
    }
    display.push(max);
  }
  return display;
}

export function normalizePeaksForDisplay(peaks: readonly number[]): number[] {
  const normalized = peaks
    .map((peak) => clampPeak(Number(peak)))
    .filter((peak) => Number.isFinite(peak));
  if (normalized.length === 0) return [];
  const maxPeak = Math.max(...normalized);
  if (maxPeak <= 0.001) return normalized;
  return normalized.map((peak) => clampPeak(peak / maxPeak));
}

export function displayPeakCountForWaveWidth(
  widthPx: number,
  options: {
    barWidthPx?: number;
    barGapPx?: number;
    fallback?: number;
    min?: number;
    max?: number;
  } = {},
): number {
  const fallback = clampDisplayCount(options.fallback ?? AUDIO_WAVEFORM_DISPLAY.voiceInput);
  const width = Math.floor(Number(widthPx));
  if (!Number.isFinite(width) || width <= 0) return fallback;
  const barWidth = positiveNumber(options.barWidthPx, AUDIO_WAVEFORM_RENDER.barWidthPx);
  const barGap = Math.max(0, positiveNumber(options.barGapPx, AUDIO_WAVEFORM_RENDER.barGapPx));
  const min = clampDisplayCount(options.min ?? AUDIO_WAVEFORM_RENDER.minDisplayPeaks);
  const max = clampDisplayCount(options.max ?? AUDIO_WAVEFORM_RENDER.maxDisplayPeaks);
  const pitch = barWidth + barGap;
  const count = Math.ceil((width + barGap) / pitch);
  return Math.max(min, Math.min(max, count));
}

function interpolatePeaks(peaks: readonly number[], targetCount: number): number[] {
  if (peaks.length === 0) return [];
  if (peaks.length === 1) return Array.from({ length: targetCount }, () => peaks[0] || 0);
  const out: number[] = [];
  const scale = (peaks.length - 1) / Math.max(1, targetCount - 1);
  for (let index = 0; index < targetCount; index += 1) {
    const sourceIndex = index * scale;
    const left = Math.floor(sourceIndex);
    const right = Math.min(peaks.length - 1, left + 1);
    const t = sourceIndex - left;
    out.push((peaks[left] || 0) * (1 - t) + (peaks[right] || 0) * t);
  }
  return out;
}

function clampDisplayCount(value: number): number {
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count) || count <= 0) return AUDIO_WAVEFORM_DISPLAY.voiceInput;
  return Math.max(1, Math.min(AUDIO_WAVEFORM_RENDER.maxDisplayPeaks, count));
}

function positiveNumber(value: number | undefined, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : fallback;
}

function buildWaveformFromAudioBuffer(
  audioBuffer: AudioBuffer,
  peakCount = DEFAULT_AUDIO_WAVEFORM_PEAKS,
): AudioWaveform | undefined {
  const channelCount = Math.max(1, audioBuffer.numberOfChannels || 1);
  const length = audioBuffer.length;
  if (length <= 0) return undefined;
  const targetCount = clampPeakCount(peakCount);
  const samplesPerPeak = Math.max(1, Math.ceil(length / targetCount));
  const peaks: number[] = [];

  for (let start = 0; start < length; start += samplesPerPeak) {
    const end = Math.min(length, start + samplesPerPeak);
    let max = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = audioBuffer.getChannelData(channel);
      for (let i = start; i < end; i += 1) {
        max = Math.max(max, Math.abs(Number(data[i]) || 0));
      }
    }
    peaks.push(clampPeak(max));
  }

  return normalizeAudioWaveform({
    version: AUDIO_WAVEFORM_VERSION,
    peaks,
    durationMs: Math.max(1, Math.round(audioBuffer.duration * 1000)),
    source: 'computed',
  });
}

function clampPeakCount(value: number): number {
  const count = Math.floor(value);
  if (!Number.isFinite(count)) return DEFAULT_AUDIO_WAVEFORM_PEAKS;
  return Math.max(8, Math.min(MAX_AUDIO_WAVEFORM_PEAKS, count));
}

function clampPeak(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
