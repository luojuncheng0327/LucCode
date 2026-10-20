import React, { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import { useSettingsStore, type Agent } from '../../store';
import { lucFetch, lucUrl, yuanFallbackAvatar } from '../../api';
import { t } from '../../helpers';
import { loadAgents } from '../../actions';
import styles from '../../Settings.module.css';

interface AgentCardGeometry {
  total: number;
  cardSize: number;
  spreadStep: number;
  edgeBleed: number;
  groupWidth: number;
  spreadWidth: number;
  positions: number[];
}

export function calculateAgentCardGeometry(totalCards: number): AgentCardGeometry {
  const total = Math.max(1, totalCards);
  const compactWidth = 260;
  const cardSize = 62;
  const spreadStep = 72;
  const edgeBleed = 18;
  const groupWidth = (total - 1) * spreadStep + cardSize;
  const visualWidth = groupWidth + edgeBleed * 2;
  const spreadWidth = Math.max(compactWidth, visualWidth);
  const spreadOffset = (spreadWidth - visualWidth) / 2;
  const positions = Array.from({ length: total }, (_unused, index) => spreadOffset + edgeBleed + index * spreadStep);

  return {
    total,
    cardSize,
    spreadStep,
    edgeBleed,
    groupWidth,
    spreadWidth,
    positions,
  };
}

export function calculateNearestRevealScrollLeft({
  scrollLeft,
  viewportWidth,
  itemLeft,
  itemRight,
  edgePadding,
  maxScrollLeft,
}: {
  scrollLeft: number;
  viewportWidth: number;
  itemLeft: number;
  itemRight: number;
  edgePadding: number;
  maxScrollLeft: number;
}): number {
  const visibleLeft = scrollLeft + edgePadding;
  const visibleRight = scrollLeft + viewportWidth - edgePadding;
  let next = scrollLeft;
  if (itemLeft < visibleLeft) {
    next = itemLeft - edgePadding;
  } else if (itemRight > visibleRight) {
    next = itemRight - (viewportWidth - edgePadding);
  }
  return Math.min(Math.max(0, next), Math.max(0, maxScrollLeft));
}

export function AgentCardStack({
  agents,
  selectedId,
  onSelect,
  onAvatarClick,
  onSetPrimary,
  onDelete,
  onExport,
  onAdd,
  exportingAgentId = null,
}: {
  agents: Agent[];
  selectedId: string | null;
  currentAgentId: string | null;
  onSelect: (id: string) => void;
  onAvatarClick: () => void;
  onSetPrimary: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onAdd: () => void;
  exportingAgentId?: string | null;
}) {
  const cardsRef = useRef<HTMLDivElement>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const expanded = pointerInside || focusWithin || dragActive;
  const expandedRef = useRef(false);
  const expandedScrollLeftRef = useRef(0);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  // 总卡片数 = agents + 1 (add 按钮)
  const total = agents.length + 1;
  const n = total;
  const stepTight = n > 1 ? Math.min(2.5, 10 / (n - 1)) : 0;
  const cardGeometry = calculateAgentCardGeometry(total);
  const spreadStep = cardGeometry.spreadStep;
  const spreadWidth = cardGeometry.spreadWidth;

  // Wheel 只在展开态归本组件所有；收起态交还页面滚动，避免旧 scrollLeft 影响弧形堆叠。
  useEffect(() => {
    const el = cardsRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!expanded) return;
      e.preventDefault();
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [expanded]);

  useLayoutEffect(() => {
    const el = cardsRef.current;
    if (!el) return;

    if (!expanded) {
      if (expandedRef.current) {
        expandedScrollLeftRef.current = el.scrollLeft;
      }
      // Compact fan geometry is positioned relative to scroll origin. Keep
      // the expanded viewport in a ref while the collapsed DOM sits at zero.
      el.scrollLeft = 0;
      expandedRef.current = false;
      return;
    }

    if (!expandedRef.current) {
      el.scrollLeft = expandedScrollLeftRef.current;
    }
    expandedRef.current = true;
    if (!selectedId) return;
    if (el.scrollWidth <= el.clientWidth) return;
    const card = el.querySelector(`[data-agent-id="${selectedId}"]`) as HTMLElement;
    if (!card) return;
    const containerRect = el.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cardVisLeft = cardRect.left - containerRect.left + el.scrollLeft;
    const cardVisRight = cardVisLeft + cardRect.width;
    el.scrollLeft = calculateNearestRevealScrollLeft({
      scrollLeft: el.scrollLeft,
      viewportWidth: el.clientWidth,
      itemLeft: cardVisLeft,
      itemRight: cardVisRight,
      edgePadding: cardGeometry.edgeBleed,
      maxScrollLeft: el.scrollWidth - el.clientWidth,
    });
  }, [expanded, selectedId, cardGeometry.edgeBleed]);

  // 拖拽排序（只对 agent 卡片，排除最后的 add 按钮）
  useEffect(() => {
    const container = cardsRef.current;
    if (!container) return;

    const handlers: Array<[HTMLElement, (e: PointerEvent) => void]> = [];
    const activeDragCleanups = new Set<() => void>();

    const cards = [...container.children] as HTMLElement[];
    // 只给 agent 卡片（非 add 按钮、非 spacer）绑定拖拽
    const agentCards = cards.filter(c => !c.dataset.addBtn && !c.dataset.spacer);
    agentCards.forEach((card, dragIdx) => {

      const handler = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (!container.matches(':hover')) return;

        e.preventDefault();
        card.setPointerCapture(e.pointerId);

        const startX = e.clientX;
        const startY = e.clientY;
        let moved = false;
        let dropIdx = dragIdx;
        let finished = false;

        const allCards = ([...container.children] as HTMLElement[]).filter(c => !c.dataset.spacer);
        const positions = allCards.map(c => parseFloat(c.style.getPropertyValue('--tx-spread')) || 0);
        const origTx = positions[dragIdx];

        const onMove = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;

          if (!moved) {
            moved = true;
            setDragActive(true);
            card.classList.add(styles['dragging']);
            card.dataset.wasDragged = '1';
            // Lock scroll during drag
            container.classList.add(styles['dragging-active']);
          }

          card.style.transform = `translateX(${origTx + dx}px) rotate(0deg) translateY(-4px)`;

          const currentPos = origTx + dx;
          let newIdx = dragIdx;
          const agentCount = agents.length;
          for (let j = 0; j < agentCount; j++) {
            if (j === dragIdx) continue;
            if (dragIdx < j && currentPos > positions[j] - 15) newIdx = j;
            if (dragIdx > j && currentPos < positions[j] + 15) newIdx = Math.min(newIdx, j);
          }

          allCards.forEach((c, ci) => {
            if (c === card || c.dataset.addBtn) return;
            if (ci >= Math.min(dragIdx, newIdx) && ci <= Math.max(dragIdx, newIdx) && newIdx !== dragIdx) {
              const shift = dragIdx < newIdx ? -spreadStep : spreadStep;
              c.style.transform = `translateX(${positions[ci] + shift}px) rotate(0deg)`;
            } else {
              c.style.transform = `translateX(${positions[ci]}px) rotate(0deg)`;
            }
            c.style.transition = 'transform var(--duration-fast) var(--ease-out)';
          });

          dropIdx = newIdx;
        };

        const finish = (commit: boolean) => {
          if (finished) return;
          finished = true;
          card.removeEventListener('pointermove', onMove);
          card.removeEventListener('pointerup', onUp);
          card.removeEventListener('pointercancel', onCancel);
          card.removeEventListener('lostpointercapture', onLostPointerCapture);
          card.classList.remove(styles['dragging']);

          allCards.forEach(c => { c.style.transform = ''; c.style.transition = ''; });
          container.classList.remove(styles['dragging-active']);
          setDragActive(false);
          activeDragCleanups.delete(cancelActiveDrag);

          if (!commit || !moved) return;

          if (dropIdx !== dragIdx) {
            const currentAgents = agentsRef.current;
            const reordered = [...currentAgents];
            const [movedAgent] = reordered.splice(dragIdx, 1);
            reordered.splice(dropIdx, 0, movedAgent);
            useSettingsStore.setState({ agents: reordered });
            lucFetch('/api/agents/order', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order: reordered.map(a => a.id) }),
            }).catch(err => {
              console.error('[agent-reorder] failed:', err);
              loadAgents();
            });
          }
        };

        const onUp = () => finish(true);
        const onCancel = () => finish(false);
        const onLostPointerCapture = () => finish(false);
        const cancelActiveDrag = () => finish(false);

        card.addEventListener('pointermove', onMove);
        card.addEventListener('pointerup', onUp);
        card.addEventListener('pointercancel', onCancel);
        card.addEventListener('lostpointercapture', onLostPointerCapture);
        activeDragCleanups.add(cancelActiveDrag);
      };

      card.addEventListener('pointerdown', handler);
      handlers.push([card, handler]);
    });

    return () => {
      for (const cancel of [...activeDragCleanups]) cancel();
      handlers.forEach(([el, fn]) => el.removeEventListener('pointerdown', fn));
    };
  }, [agents, spreadStep]);

  const suppressContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const selectedAgent = selectedId ? agents.find(a => a.id === selectedId) : null;
  const canSetPrimary = !!selectedAgent && !selectedAgent.isPrimary;
  // 删除门控只依据 agent 自身属性（非主助手）+ 数量下限，刻意不挂钩 currentAgentId：
  // 新建 agent 会被自动切为当前 agent，门控若看 current 则新建后永远删不掉（#1301）。
  // 删当前 agent 是安全的：AgentDeleteOverlay 会先切到其他 agent 再 DELETE，后端也拒删 active agent。
  const canDeleteSelected = !!selectedAgent && agents.length >= 2 && !selectedAgent.isPrimary;
  const isExportingSelected = !!selectedAgent && exportingAgentId === selectedAgent.id;

  return (
    <div
      className={styles['agent-card-stack']}
      style={{ '--cards-spread-width': spreadWidth } as React.CSSProperties}
    >
      <div
        className={`${styles['agent-cards']}${expanded ? ' ' + styles['agent-cards-expanded'] : ''}`}
        ref={cardsRef}
        onPointerEnter={() => setPointerInside(true)}
        onPointerLeave={() => setPointerInside(false)}
        onFocus={() => setFocusWithin(true)}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setFocusWithin(false);
        }}
      >
        {/* spacer: 撑出实际滚动宽度，绝对定位的卡片不贡献 scrollWidth */}
        <div data-spacer="1" style={{ width: spreadWidth, height: 1, pointerEvents: 'none', flexShrink: 0 }} />
        {agents.map((agent, i) => {
          const rotTight = i * stepTight;
          const txSpread = cardGeometry.positions[i];
          const z = n - i;
          const isSelected = agent.id === selectedId;

          return (
            <div
              key={agent.id}
              className={`${styles['agent-card']}${isSelected ? ' ' + styles['selected'] : ''}`}
              data-agent-id={agent.id}
              data-index={i}
              style={{
                '--rot-tight': `${rotTight}deg`,
                '--tx-spread': `${txSpread}px`,
                '--z': z,
                zIndex: z,
              } as React.CSSProperties}
              onClick={(e) => {
                const el = e.currentTarget as HTMLElement;
                if (el.dataset.wasDragged) { delete el.dataset.wasDragged; return; }
                if (isSelected) onAvatarClick();
                else onSelect(agent.id);
              }}
              onContextMenu={suppressContextMenu}
            >
              <div className={styles['agent-card-inner']}>
                <img
                  className={styles['agent-card-avatar']}
                  draggable={false}
                  src={agent.hasAvatar
                    ? lucUrl(`/api/agents/${agent.id}/avatar${agent.avatarRevision ? `?v=${encodeURIComponent(agent.avatarRevision)}` : ''}`)
                    : yuanFallbackAvatar(agent.yuan)}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    img.onerror = null;
                    img.src = yuanFallbackAvatar(agent.yuan);
                  }}
                />
                {isSelected && (
                  <div className={styles['agent-card-overlay']}>
                    <span>{t('settings.agent.changeAvatar')}</span>
                  </div>
                )}
              </div>
              {agent.isPrimary && <div className={styles['agent-card-badge']} />}
              <span className={styles['agent-card-name']}>{agent.name}</span>
            </div>
          );
        })}
        {/* "+" 新建卡片 */}
        <div
          data-add-btn="1"
          className={styles['agent-card']}
          style={{
            '--rot-tight': `${agents.length * stepTight}deg`,
            '--tx-spread': `${cardGeometry.positions[agents.length]}px`,
            '--z': 0,
            zIndex: 0,
          } as React.CSSProperties}
          onClick={onAdd}
        >
          <div className={`${styles['agent-card-inner']} ${styles['agent-card-add']}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </div>
        </div>
      </div>

      {selectedAgent && (
        <div className={styles['agent-card-actions']}>
          {canSetPrimary && (
            <button
              type="button"
              className={styles['agent-card-action']}
              onClick={() => onSetPrimary(selectedAgent.id)}
            >
              {t('settings.agent.setPrimary')}
            </button>
          )}
          <button
            type="button"
            className={styles['agent-card-action']}
            onClick={() => onExport(selectedAgent.id)}
            disabled={!!exportingAgentId}
          >
            {isExportingSelected ? t('settings.agent.generatingPreview') : t('settings.agent.exportAgent')}
          </button>
          {canDeleteSelected && (
            <button
              type="button"
              className={`${styles['agent-card-action']} ${styles['agent-card-action-danger']}`}
              onClick={() => onDelete(selectedAgent.id)}
            >
              {t('settings.agent.deleteBtn')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
