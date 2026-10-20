import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContentBlock } from '../../stores/chat-types';
import { AssistantContentPreview } from './AssistantContentPreview';
import { SubagentSessionPreview } from './SubagentSessionPreview';
import styles from './Chat.module.css';

type InterludeContentBlock = Extract<ContentBlock, { type: 'interlude' }>;

interface FloatingPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

function isPreviewEnabledViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia('(max-width: 720px), (pointer: coarse)').matches;
}

function useInterludePreviewEnabled(): boolean {
  const [enabled, setEnabled] = useState(isPreviewEnabledViewport);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 720px), (pointer: coarse)');
    const update = () => setEnabled(!query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  return enabled;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function measurePopover(anchor: HTMLElement): FloatingPosition {
  const rect = anchor.getBoundingClientRect();
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 768;
  const width = Math.min(Math.max(320, viewportW * 0.6), 640, Math.max(320, viewportW - 32));
  const maxHeight = Math.min(560, Math.max(220, viewportH * 0.72));
  const left = clamp(rect.left + rect.width / 2 - width / 2, 16, viewportW - width - 16);
  const belowTop = rect.bottom + 8;
  const top = belowTop + maxHeight <= viewportH - 16
    ? belowTop
    : Math.max(16, rect.top - maxHeight - 8);
  return { left, top, width, maxHeight };
}

function streamStatusFromInterlude(status: string | undefined): 'done' | 'failed' | 'aborted' {
  if (status === 'failed') return 'failed';
  if (status === 'aborted') return 'aborted';
  return 'done';
}

const InterludeDetailPreview = memo(function InterludeDetailPreview({ detailMarkdown }: { detailMarkdown: string }) {
  return (
    <AssistantContentPreview
      content={detailMarkdown}
      className={styles.interludePopoverMarkdown}
    />
  );
});

export const InterludeBlock = memo(function InterludeBlock({ block }: { block: InterludeContentBlock }) {
  const anchorRef = useRef<HTMLButtonElement | HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const previewEnabled = useInterludePreviewEnabled();
  const detailMarkdown = (block.detailMarkdown || '').trim();
  const previewSessionPath = typeof block.previewSessionPath === 'string' && block.previewSessionPath.trim()
    ? block.previewSessionPath
    : null;
  const previewSessionId = typeof block.previewSessionId === 'string' && block.previewSessionId.trim()
    ? block.previewSessionId
    : null;
  const canPreview = previewEnabled && (detailMarkdown.length > 0 || !!previewSessionPath || !!previewSessionId);
  const [position, setPosition] = useState<FloatingPosition | null>(null);

  const setAnchor = useCallback((node: HTMLButtonElement | HTMLDivElement | null) => {
    anchorRef.current = node;
  }, []);

  const setPopover = useCallback((node: HTMLDivElement | null) => {
    popoverRef.current = node;
    scrollContainerRef.current = node;
  }, []);

  const close = useCallback(() => setPosition(null), []);

  const toggle = useCallback(() => {
    if (!canPreview || !anchorRef.current) return;
    setPosition(current => current ? null : measurePopover(anchorRef.current as HTMLElement));
  }, [canPreview]);

  useEffect(() => {
    if (!position) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [close, position]);

  useEffect(() => {
    if (!canPreview) setPosition(null);
  }, [canPreview]);

  const content = (
    <>
      <span className={styles.interludeLine} aria-hidden="true" />
      <span className={styles.interludeText}>{block.text}</span>
      <span className={styles.interludeLine} aria-hidden="true" />
    </>
  );

  return (
    <div className={styles.interludeRow} data-interlude-status={block.status || 'success'}>
      {canPreview ? (
        <button
          ref={setAnchor}
          type="button"
          className={`${styles.interludeTrigger} ${styles.interludeTriggerInteractive}`}
          onClick={toggle}
          aria-expanded={!!position}
        >
          {content}
        </button>
      ) : (
        <div ref={setAnchor} className={styles.interludeTrigger}>
          {content}
        </div>
      )}
      {position && createPortal(
        <div
          ref={setPopover}
          className={styles.interludePopover}
          style={{
            left: position.left,
            top: position.top,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          role="dialog"
        >
          {(previewSessionPath || previewSessionId) && block.taskId ? (
            <SubagentSessionPreview
              taskId={block.taskId}
              sessionId={previewSessionId}
              sessionPath={previewSessionPath}
              agentId={block.previewAgentId || null}
              streamStatus={streamStatusFromInterlude(block.status)}
              summary={block.sourceLabel || null}
              scrollContainerRef={scrollContainerRef}
            />
          ) : (
            <InterludeDetailPreview detailMarkdown={detailMarkdown} />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
});
