import { useLayoutEffect, useRef, useState } from 'react';
import { splitGraphemes } from '../utils/grapheme';

export interface AdaptiveStreamTextOptions {
  active?: boolean;
  displayFps?: number;
  minBatch?: number;
  maxBatch?: number;
  catchUpThreshold?: number;
  hardCatchUpThreshold?: number;
  useIntlSegmenter?: boolean;
}

const DEFAULT_DISPLAY_FPS = 30;
const DEFAULT_MIN_BATCH = 1;
const DEFAULT_MAX_BATCH = 48;
const DEFAULT_CATCH_UP_THRESHOLD = 24;
const DEFAULT_HARD_CATCH_UP_THRESHOLD = 80;
const ASCII_WORD_CHAR = /^[A-Za-z0-9_'’-]$/;
const WHITESPACE = /^\s+$/;
const CJK_GRAPHEME = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const STANDALONE_PUNCTUATION = /^[\p{Punctuation}]+$/u;

type SegmenterPart = { segment: string };
type SegmenterLike = { segment(input: string): Iterable<SegmenterPart> };
type SegmenterConstructor = new (
  locale: string | undefined,
  options: { granularity: 'word' },
) => SegmenterLike;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isAsciiWordChar(value: string): boolean {
  return ASCII_WORD_CHAR.test(value);
}

function isCjkGrapheme(value: string): boolean {
  return CJK_GRAPHEME.test(value);
}

function isStandalonePunctuation(value: string): boolean {
  return STANDALONE_PUNCTUATION.test(value);
}

function normalizeStreamingChunks(segments: readonly string[]): string[] {
  const chunks: string[] = [];
  let prefix = '';

  for (const segment of segments) {
    if (!segment) continue;
    if (WHITESPACE.test(segment)) {
      prefix += segment;
      continue;
    }

    const next = prefix + segment;
    prefix = '';

    if (chunks.length > 0 && isStandalonePunctuation(next.trim())) {
      chunks[chunks.length - 1] += next;
      continue;
    }
    chunks.push(next);
  }

  if (prefix) {
    if (chunks.length > 0) chunks[chunks.length - 1] += prefix;
    else chunks.push(prefix);
  }

  return chunks;
}

function splitWithIntlSegmenter(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  if (!Segmenter) return [];
  try {
    const segmenter = new Segmenter(undefined, { granularity: 'word' });
    return normalizeStreamingChunks(Array.from(segmenter.segment(text), part => part.segment));
  } catch {
    return [];
  }
}

function splitWithFallback(text: string): string[] {
  const graphemes = splitGraphemes(text);
  const raw: string[] = [];
  let i = 0;

  while (i < graphemes.length) {
    const current = graphemes[i];

    if (WHITESPACE.test(current)) {
      let chunk = current;
      i += 1;
      while (i < graphemes.length && WHITESPACE.test(graphemes[i])) {
        chunk += graphemes[i];
        i += 1;
      }
      raw.push(chunk);
      continue;
    }

    if (isAsciiWordChar(current)) {
      let chunk = current;
      i += 1;
      while (i < graphemes.length && isAsciiWordChar(graphemes[i])) {
        chunk += graphemes[i];
        i += 1;
      }
      raw.push(chunk);
      continue;
    }

    if (isCjkGrapheme(current)) {
      let chunk = current;
      i += 1;
      while (i < graphemes.length && chunk.length < 2 && isCjkGrapheme(graphemes[i])) {
        chunk += graphemes[i];
        i += 1;
      }
      raw.push(chunk);
      continue;
    }

    raw.push(current);
    i += 1;
  }

  return normalizeStreamingChunks(raw);
}

export function splitAdaptiveStreamChunks(text: string, useIntlSegmenter = true): string[] {
  if (!text) return [];
  if (useIntlSegmenter) {
    const intlChunks = splitWithIntlSegmenter(text);
    if (intlChunks.length > 0) return intlChunks;
  }
  return splitWithFallback(text);
}

function chooseBatchSize(
  backlog: number,
  minBatch: number,
  maxBatch: number,
  catchUpThreshold: number,
): number {
  if (backlog <= 0) return 0;
  if (backlog <= 12) return minBatch;
  if (backlog <= catchUpThreshold) return Math.min(maxBatch, Math.max(minBatch, 2));
  if (backlog <= catchUpThreshold * 2) {
    return Math.min(maxBatch, Math.max(6, Math.ceil(backlog / 8)));
  }
  return Math.min(maxBatch, Math.max(12, Math.ceil(backlog / 4)));
}

export function planAdaptiveStreamAdvance(
  remaining: string,
  options: Required<Pick<AdaptiveStreamTextOptions, 'minBatch' | 'maxBatch' | 'catchUpThreshold' | 'useIntlSegmenter'>>,
): string {
  const chunks = splitAdaptiveStreamChunks(remaining, options.useIntlSegmenter);
  const batchSize = chooseBatchSize(
    chunks.length,
    options.minBatch,
    options.maxBatch,
    options.catchUpThreshold,
  );
  return chunks.slice(0, batchSize).join('');
}

function shouldHardCatchUp(remaining: string, threshold: number): boolean {
  return splitGraphemes(remaining).length >= threshold;
}

export function useAdaptiveStreamText(target: string, options: AdaptiveStreamTextOptions = {}): string {
  const {
    active = true,
    displayFps = DEFAULT_DISPLAY_FPS,
    minBatch = DEFAULT_MIN_BATCH,
    maxBatch = DEFAULT_MAX_BATCH,
    catchUpThreshold = DEFAULT_CATCH_UP_THRESHOLD,
    hardCatchUpThreshold = DEFAULT_HARD_CATCH_UP_THRESHOLD,
    useIntlSegmenter = true,
  } = options;

  const [visible, setVisible] = useState(target);
  const visibleRef = useRef(target);
  const targetRef = useRef(target);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useRef({
    active,
    displayFps,
    minBatch,
    maxBatch,
    catchUpThreshold,
    hardCatchUpThreshold,
    useIntlSegmenter,
  });

  configRef.current = {
    active,
    displayFps,
    minBatch,
    maxBatch,
    catchUpThreshold,
    hardCatchUpThreshold,
    useIntlSegmenter,
  };
  targetRef.current = target;

  const clearTimer = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const setVisibleText = (text: string) => {
    if (visibleRef.current === text) return;
    visibleRef.current = text;
    setVisible(text);
  };

  const setFullTarget = () => {
    clearTimer();
    setVisibleText(targetRef.current);
  };

  const advanceOnce = () => {
    timerRef.current = null;
    const config = configRef.current;
    const current = visibleRef.current;
    const nextTarget = targetRef.current;

    if (!config.active || prefersReducedMotion()) {
      setFullTarget();
      return;
    }
    if (current === nextTarget) return;
    if (!nextTarget.startsWith(current)) {
      setFullTarget();
      return;
    }

    const remaining = nextTarget.slice(current.length);
    if (shouldHardCatchUp(remaining, config.hardCatchUpThreshold)) {
      setFullTarget();
      return;
    }

    const advanceText = planAdaptiveStreamAdvance(remaining, {
      minBatch: config.minBatch,
      maxBatch: config.maxBatch,
      catchUpThreshold: config.catchUpThreshold,
      useIntlSegmenter: config.useIntlSegmenter,
    });
    if (!advanceText) return;

    setVisibleText(current + advanceText);
    if (visibleRef.current !== targetRef.current) scheduleAdvance();
  };

  const scheduleAdvance = () => {
    if (timerRef.current != null) return;
    const intervalMs = Math.round(1000 / Math.max(1, configRef.current.displayFps));
    timerRef.current = setTimeout(advanceOnce, intervalMs);
  };

  useLayoutEffect(() => {
    targetRef.current = target;
    const current = visibleRef.current;
    const config = configRef.current;

    if (!config.active || prefersReducedMotion()) {
      setFullTarget();
      return;
    }
    if (target === current) return;
    if (!target.startsWith(current)) {
      setFullTarget();
      return;
    }

    const remaining = target.slice(current.length);
    if (shouldHardCatchUp(remaining, config.hardCatchUpThreshold)) {
      setFullTarget();
      return;
    }

    scheduleAdvance();
  });

  useLayoutEffect(() => () => clearTimer(), []);

  return visible;
}
