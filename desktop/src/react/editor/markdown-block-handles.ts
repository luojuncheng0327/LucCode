import {
  EditorSelection,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  buildMarkdownBlockRangeMove,
  collectMarkdownBlocks,
  type MarkdownBlock,
  type MarkdownBlockPlacement,
} from './markdown-blocks';
import {
  selectedMarkdownBlocks,
  setMarkdownBlockSelection,
} from './markdown-block-selection';

export interface MarkdownBlockMenuTarget extends MarkdownBlock {
  /**
   * The contiguous parser-owned blocks represented by this menu target.
   * A handle inside the current block selection targets the whole selection;
   * an unselected handle targets only its own block.
   */
  readonly blocks: readonly MarkdownBlock[];
}

export interface MarkdownBlockMenuRequest {
  readonly id: number;
  readonly position: { x: number; y: number };
  readonly target: MarkdownBlockMenuTarget;
}

interface MarkdownBlockHandleOptions {
  readonly readOnly?: boolean;
  readonly onOpenMenu: (request: MarkdownBlockMenuRequest) => void;
}

const HANDLE_WIDTH = 20;
const HANDLE_HEIGHT = 24;
const HANDLE_GAP = 8;
const HANDLE_RAIL_WIDTH = HANDLE_WIDTH + HANDLE_GAP;
const DROP_INDICATOR_FADE_MS = 100;
const DRAG_THRESHOLD = 4;
const FENCE_LINE_RE = /^ {0,3}(?:`{3,}|~{3,})/;

type EditorCoordinates = NonNullable<ReturnType<EditorView['coordsAtPos']>>;

interface MeasuredMarkdownBlock {
  readonly start: EditorCoordinates;
  readonly end: EditorCoordinates;
  readonly left: number;
}

interface MarkdownBlockDropIndicator {
  readonly position: number;
  readonly side: -1 | 1;
  readonly visible: boolean;
}

interface MarkdownBlockRailItemLayout {
  readonly block: MarkdownBlock;
  readonly measurement: MeasuredMarkdownBlock;
  readonly left: number;
  readonly top: number;
  readonly height: number;
  readonly handleTop: number;
}

interface MarkdownBlockRailLayout {
  readonly items: MarkdownBlockRailItemLayout[];
}

const setMarkdownBlockDropIndicator = StateEffect.define<MarkdownBlockDropIndicator | null>({
  map: (value, changes) => value ? {
    ...value,
    position: changes.mapPos(value.position, value.side),
  } : null,
});

class MarkdownBlockDropIndicatorWidget extends WidgetType {
  constructor(readonly visible: boolean) {
    super();
  }

  eq(other: MarkdownBlockDropIndicatorWidget): boolean {
    return this.visible === other.visible;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement('div');
    element.className = 'cm-markdown-block-drop-indicator';
    element.classList.toggle('is-visible', this.visible);
    element.setAttribute('aria-hidden', 'true');
    return element;
  }

  updateDOM(element: HTMLElement): boolean {
    element.classList.toggle('is-visible', this.visible);
    return true;
  }

  get estimatedHeight(): number {
    return 0;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildDropIndicatorDecoration(indicator: MarkdownBlockDropIndicator | null): DecorationSet {
  if (!indicator) return Decoration.none;
  return Decoration.set([
    Decoration.widget({
      widget: new MarkdownBlockDropIndicatorWidget(indicator.visible),
      block: true,
      side: indicator.side,
    }).range(indicator.position),
  ]);
}

const markdownBlockDropIndicatorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setMarkdownBlockDropIndicator)) {
        next = buildDropIndicatorDecoration(effect.value);
      }
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

function lineCoordinates(
  view: EditorView,
  lineNumber: number,
  edge: 'start' | 'end',
): EditorCoordinates | null {
  const line = view.state.doc.line(lineNumber);
  const positions = edge === 'start'
    ? [line.from, line.to]
    : [line.to, line.from];
  const visited = new Set<number>();
  for (const position of positions) {
    if (visited.has(position)) continue;
    visited.add(position);
    const coordinates = view.coordsAtPos(position, edge === 'start' ? 1 : -1);
    if (coordinates) return coordinates;
  }
  return null;
}

function blockLineNumbers(block: MarkdownBlock): number[] {
  const lines: number[] = [];
  for (let lineNumber = block.startLine; lineNumber <= block.endLine; lineNumber += 1) {
    lines.push(lineNumber);
  }
  return lines;
}

function measurableContentLineNumbers(view: EditorView, block: MarkdownBlock): number[] {
  const all: number[] = [];
  const withoutFences: number[] = [];
  for (let lineNumber = block.startLine; lineNumber <= block.endLine; lineNumber += 1) {
    all.push(lineNumber);
    if (!FENCE_LINE_RE.test(view.state.doc.line(lineNumber).text)) withoutFences.push(lineNumber);
  }
  return withoutFences.length > 0 ? withoutFences : all;
}

function renderedLineCoordinates(
  view: EditorView,
  lineNumber: number,
  edge: 'start' | 'end',
): EditorCoordinates | null {
  const horizontal = lineCoordinates(view, lineNumber, edge);
  if (!horizontal) return null;
  const line = view.state.doc.line(lineNumber);
  const lineBlock = view.lineBlockAt(line.from);
  const top = view.documentTop + (lineBlock.top * view.scaleY);
  const firstVisualBoundary = view.moveToLineBoundary(EditorSelection.cursor(line.from), true, true);
  const height = firstVisualBoundary.head < line.to
    ? horizontal.bottom - horizontal.top
    : lineBlock.height * view.scaleY;
  return {
    ...horizontal,
    top,
    bottom: top + height,
  };
}

function renderedLineElement(view: EditorView, lineNumber: number): HTMLElement | null {
  const line = view.state.doc.line(lineNumber);
  const { node } = view.domAtPos(line.from, 1);
  let element = node.nodeType === Node.ELEMENT_NODE
    ? node as HTMLElement
    : node.parentElement;
  while (element && element !== view.contentDOM) {
    if (element.classList.contains('cm-line')) return element;
    element = element.parentElement;
  }
  return null;
}

function renderedBlockLineLeft(
  view: EditorView,
  block: MarkdownBlock,
  lineNumber: number,
): number | null {
  if (block.type === 'Blockquote') {
    const element = renderedLineElement(view, lineNumber);
    const left = element?.getBoundingClientRect().left;
    if (left !== undefined && Number.isFinite(left)) return left;
  }
  return renderedLineCoordinates(view, lineNumber, 'start')?.left ?? null;
}

function measureMarkdownBlock(view: EditorView, block: MarkdownBlock): MeasuredMarkdownBlock | null {
  let start: EditorCoordinates | null = null;
  let end: EditorCoordinates | null = null;
  let left = Number.POSITIVE_INFINITY;

  const verticalLineNumbers = blockLineNumbers(block);
  const horizontalLineNumbers = measurableContentLineNumbers(view, block);
  for (const lineNumber of verticalLineNumbers) {
    const coordinates = renderedLineCoordinates(view, lineNumber, 'start');
    if (!coordinates) continue;
    start ??= coordinates;
  }
  for (const lineNumber of horizontalLineNumbers) {
    const lineLeft = renderedBlockLineLeft(view, block, lineNumber);
    if (lineLeft === null) continue;
    left = Math.min(left, lineLeft);
  }
  for (let index = verticalLineNumbers.length - 1; index >= 0; index -= 1) {
    end = renderedLineCoordinates(view, verticalLineNumbers[index], 'end');
    if (end) break;
  }

  if (!start || !end || !Number.isFinite(left)) return null;
  return { start, end, left };
}

function blockMatches(left: MarkdownBlock, right: MarkdownBlock): boolean {
  return left.from === right.from
    && left.to === right.to
    && left.type === right.type
    && left.source === right.source;
}

function blockAtCurrentPosition(view: EditorView, candidate: MarkdownBlock): MarkdownBlock | null {
  return collectMarkdownBlocks(view.state).find(block => blockMatches(block, candidate)) ?? null;
}

function menuTargetForBlocks(
  view: EditorView,
  blocks: readonly MarkdownBlock[],
): MarkdownBlockMenuTarget | null {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (!first || !last) return null;
  const source = view.state.sliceDoc(first.from, last.to);
  return {
    from: first.from,
    to: last.to,
    type: blocks.length === 1 ? first.type : 'BlockRange',
    startLine: first.startLine,
    endLine: last.endLine,
    source,
    blocks: [...blocks],
  };
}

function translation(ownerWindow: Window, key: string, fallback: string): string {
  const translated = ownerWindow.t?.(key);
  return translated && translated !== key ? translated : fallback;
}

function createGripIcon(doc: Document): SVGSVGElement {
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 14 14');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');

  for (const x of [4, 10]) {
    for (const y of [3, 7, 11]) {
      const dot = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
      dot.setAttribute('x1', String(x));
      dot.setAttribute('x2', String(x));
      dot.setAttribute('y1', String(y));
      dot.setAttribute('y2', String(y));
      icon.appendChild(dot);
    }
  }
  return icon;
}

class MarkdownBlockHandleView {
  private readonly rail: HTMLDivElement;
  private readonly ownerWindow: Window;
  private measuredBlocks: Array<{
    block: MarkdownBlock;
    measurement: MeasuredMarkdownBlock;
  }> = [];
  private renderedItems: Array<{
    block: MarkdownBlock;
    item: HTMLDivElement;
    button: HTMLButtonElement;
  }> = [];
  private draggedBlocks: MarkdownBlock[] = [];
  private dropTarget: { block: MarkdownBlock; placement: MarkdownBlockPlacement } | null = null;
  private pendingDrag: {
    block: MarkdownBlock;
    blocks: MarkdownBlock[];
    button: HTMLButtonElement;
    pointerId: number;
    startX: number;
    startY: number;
    renderWasPending: boolean;
  } | null = null;
  private dragPreview: HTMLElement | null = null;
  private displayedDropIndicator: Omit<MarkdownBlockDropIndicator, 'visible'> | null = null;
  private dropIndicatorRemovalTimer: number | null = null;
  private lastPointerY: number | null = null;
  private suppressClick = false;
  private frameId: number | null = null;
  private requestId = 0;

  constructor(
    private readonly view: EditorView,
    private readonly options: MarkdownBlockHandleOptions,
  ) {
    const doc = view.dom.ownerDocument;
    this.ownerWindow = doc.defaultView ?? window;
    this.rail = doc.createElement('div');
    this.rail.className = 'cm-markdown-block-rail';
    this.rail.setAttribute('aria-hidden', options.readOnly ? 'true' : 'false');

    view.dom.append(this.rail);
    view.scrollDOM.addEventListener('scroll', this.scheduleRender, { passive: true });
    this.ownerWindow.addEventListener('resize', this.scheduleRender);
    this.scheduleRender();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      this.scheduleRender();
      return;
    }
    if (update.selectionSet) this.syncCaretBlockMarker();
  }

  destroy(): void {
    if (this.frameId !== null) this.ownerWindow.cancelAnimationFrame(this.frameId);
    if (this.dropIndicatorRemovalTimer !== null) {
      this.ownerWindow.clearTimeout(this.dropIndicatorRemovalTimer);
    }
    this.removeDragPreview();
    this.view.scrollDOM.removeEventListener('scroll', this.scheduleRender);
    this.ownerWindow.removeEventListener('resize', this.scheduleRender);
    this.rail.remove();
  }

  private readonly scheduleRender = (): void => {
    if (this.frameId !== null) return;
    this.frameId = this.ownerWindow.requestAnimationFrame(() => {
      this.frameId = null;
      const layout = this.readLayout();
      if (this.pendingDrag) {
        this.measuredBlocks = layout.items.map(({ block, measurement }) => ({ block, measurement }));
        if (this.draggedBlocks.length > 0 && this.lastPointerY !== null) {
          this.updateDropTarget(this.lastPointerY);
        }
      } else {
        this.render(layout);
      }
    });
  };

  private readLayout(): MarkdownBlockRailLayout {
    const blocks = collectMarkdownBlocks(this.view.state);
    if (this.options.readOnly || blocks.length === 0) return { items: [] };
    const editorRect = this.view.dom.getBoundingClientRect();
    const visibleBlocks = blocks.filter(block => (
      block.to >= this.view.viewport.from && block.from <= this.view.viewport.to
    ));
    const items: MarkdownBlockRailItemLayout[] = [];

    for (const block of visibleBlocks) {
      const measurement = measureMarkdownBlock(this.view, block);
      if (!measurement) continue;
      const { start, end, left } = measurement;
      items.push({
        block,
        measurement,
        left: Math.max(HANDLE_GAP, left - editorRect.left - HANDLE_RAIL_WIDTH),
        top: start.top - editorRect.top,
        height: Math.max(HANDLE_HEIGHT, end.bottom - start.top),
        handleTop: Math.max(0, (start.bottom - start.top - HANDLE_HEIGHT) / 2),
      });
    }
    return { items };
  }

  private isCaretBlock(block: MarkdownBlock): boolean {
    const focusLine = this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
    return focusLine >= block.startLine && focusLine <= block.endLine;
  }

  private syncCaretBlockMarker(): void {
    const caretBlockFrom = this.measuredBlocks.find(({ block }) => this.isCaretBlock(block))?.block.from;
    this.rail.querySelectorAll<HTMLElement>('.cm-markdown-block-rail-item').forEach(item => {
      item.classList.toggle(
        'is-caret-block',
        caretBlockFrom !== undefined && item.dataset.blockFrom === String(caretBlockFrom),
      );
    });
  }

  private render(layout: MarkdownBlockRailLayout): void {
    if (this.pendingDrag) return;
    this.measuredBlocks = layout.items.map(({ block, measurement }) => ({ block, measurement }));
    if (this.options.readOnly || layout.items.length === 0) {
      if (this.renderedItems.length > 0) this.rail.replaceChildren();
      this.renderedItems = [];
      return;
    }

    const reusableItems = layout.items.map(({ block }) => (
      this.renderedItems.find(rendered => blockMatches(rendered.block, block)) ?? null
    ));
    if (reusableItems.every(rendered => rendered !== null)) {
      const retainedItems = new Set(reusableItems.map(({ item }) => item));
      for (const rendered of this.renderedItems) {
        if (!retainedItems.has(rendered.item)) rendered.item.remove();
      }
      this.renderedItems = reusableItems;
      for (let index = 0; index < layout.items.length; index += 1) {
        const { block, left, top, height, handleTop } = layout.items[index];
        const { item, button } = this.renderedItems[index];
        item.style.left = `${left}px`;
        item.style.top = `${top}px`;
        item.style.height = `${height}px`;
        item.classList.toggle('is-caret-block', this.isCaretBlock(block));
        button.style.top = `${handleTop}px`;
      }
      return;
    }

    this.rail.replaceChildren();
    this.renderedItems = [];

    for (const { block, left, top, height, handleTop } of layout.items) {
      const item = this.view.dom.ownerDocument.createElement('div');
      item.className = 'cm-markdown-block-rail-item';
      item.style.left = `${left}px`;
      item.style.top = `${top}px`;
      item.style.height = `${height}px`;
      item.dataset.blockFrom = String(block.from);
      item.classList.toggle('is-caret-block', this.isCaretBlock(block));

      const button = this.view.dom.ownerDocument.createElement('button');
      const blockActionsLabel = translation(this.ownerWindow, 'ctx.blockActions', 'Block actions');
      button.type = 'button';
      button.className = 'cm-markdown-block-handle';
      button.style.top = `${handleTop}px`;
      button.title = blockActionsLabel;
      button.setAttribute('aria-label', blockActionsLabel);
      button.appendChild(createGripIcon(this.view.dom.ownerDocument));
      button.addEventListener('mousedown', event => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (this.suppressClick) return;
        const current = blockAtCurrentPosition(this.view, block);
        if (!current) return;
        const selected = selectedMarkdownBlocks(this.view.state);
        const currentIsSelected = selected.some(candidate => blockMatches(candidate, current));
        if (selected.length > 0 && !currentIsSelected) {
          this.view.dispatch({ effects: setMarkdownBlockSelection.of(null) });
        }
        const targetBlocks = currentIsSelected
          ? selected
          : [current];
        const target = menuTargetForBlocks(this.view, targetBlocks);
        if (!target) return;
        const rect = button.getBoundingClientRect();
        this.options.onOpenMenu({
          id: ++this.requestId,
          position: { x: rect.right, y: rect.top },
          target,
        });
      });
      button.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const current = blockAtCurrentPosition(this.view, block);
        if (!current) return;
        const selected = selectedMarkdownBlocks(this.view.state);
        const blocks = selected.some(candidate => blockMatches(candidate, current))
          ? selected
          : [current];
        const pendingFrameId = this.frameId;
        const renderWasPending = pendingFrameId !== null;
        if (pendingFrameId !== null) {
          this.ownerWindow.cancelAnimationFrame(pendingFrameId);
          this.frameId = null;
        }
        this.pendingDrag = {
          block: current,
          blocks,
          button,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          renderWasPending,
        };
        this.lastPointerY = event.clientY;
        button.setPointerCapture?.(event.pointerId);
      });
      button.addEventListener('pointermove', event => {
        const pending = this.pendingDrag;
        if (!pending || pending.pointerId !== event.pointerId) return;
        this.lastPointerY = event.clientY;
        const deltaX = event.clientX - pending.startX;
        const deltaY = event.clientY - pending.startY;
        if (this.draggedBlocks.length === 0 && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
        if (this.draggedBlocks.length === 0) {
          this.draggedBlocks = pending.blocks;
          if (pending.blocks.length === 1) {
            this.view.dispatch({ effects: setMarkdownBlockSelection.of(null) });
          }
          pending.button.classList.add('is-dragging');
          this.suppressClick = true;
          this.createDragPreview(pending.block, pending.blocks.length);
        }
        event.preventDefault();
        event.stopPropagation();
        this.moveDragPreview(deltaX, deltaY);
        this.updateDropTarget(event.clientY);
      });
      button.addEventListener('pointerup', event => {
        const pending = this.pendingDrag;
        if (!pending || pending.pointerId !== event.pointerId) return;
        const didDrag = this.draggedBlocks.length > 0;
        if (didDrag) {
          event.preventDefault();
          event.stopPropagation();
          this.commitDrop();
          this.ownerWindow.setTimeout(() => { this.suppressClick = false; }, 0);
        }
        button.releasePointerCapture?.(event.pointerId);
        pending.button.classList.remove('is-dragging');
        this.pendingDrag = null;
        if (didDrag || pending.renderWasPending) this.scheduleRender();
      });
      button.addEventListener('pointercancel', event => {
        if (this.pendingDrag?.pointerId !== event.pointerId) return;
        this.pendingDrag.button.classList.remove('is-dragging');
        this.pendingDrag = null;
        this.suppressClick = false;
        this.clearDragState();
        this.scheduleRender();
      });

      item.appendChild(button);
      this.rail.appendChild(item);
      this.renderedItems.push({ block, item, button });
    }
  }

  private renderedBlockElements(block: MarkdownBlock): HTMLElement[] {
    const elements = new Set<HTMLElement>();
    for (const lineNumber of measurableContentLineNumbers(this.view, block)) {
      const element = renderedLineElement(this.view, lineNumber);
      if (element) elements.add(element);
    }
    if (elements.size > 0) return [...elements];

    const widgetSelector = [
      '.cm-table-widget',
      '.cm-mermaid-widget',
      '.cm-image-widget',
      '.cm-math-block-widget',
      '.cm-hr-widget',
    ].join(', ');
    for (const position of [block.from, block.to]) {
      const { node, offset } = this.view.domAtPos(position, position === block.from ? 1 : -1);
      const candidates: Node[] = [node];
      if (node.nodeType === 1) {
        const parent = node as Element;
        const atOffset = parent.childNodes[offset];
        const beforeOffset = offset > 0 ? parent.childNodes[offset - 1] : null;
        if (atOffset) candidates.push(atOffset);
        if (beforeOffset) candidates.push(beforeOffset);
      }
      for (const candidate of candidates) {
        if (candidate.nodeType !== 1) continue;
        const element = candidate as HTMLElement;
        const widget = element.matches(widgetSelector)
          ? element
          : element.querySelector<HTMLElement>(widgetSelector)
            ?? element.closest<HTMLElement>(widgetSelector);
        if (widget && this.view.contentDOM.contains(widget)) return [widget];
      }
    }
    return [];
  }

  private createDragPreview(block: MarkdownBlock, blockCount: number): void {
    this.removeDragPreview();
    const elements = this.renderedBlockElements(block);
    if (elements.length === 0) return;

    const editorRect = this.view.dom.getBoundingClientRect();
    const scaleX = this.view.scaleX || 1;
    const scaleY = this.view.scaleY || 1;
    const measurements = elements.map(element => ({ element, rect: element.getBoundingClientRect() }));
    const left = Math.min(...measurements.map(({ rect }) => rect.left));
    const top = Math.min(...measurements.map(({ rect }) => rect.top));
    const right = Math.max(...measurements.map(({ rect }) => rect.right));
    const bottom = Math.max(...measurements.map(({ rect }) => rect.bottom));
    const preview = this.view.dom.ownerDocument.createElement('div');
    preview.className = 'cm-markdown-block-drag-preview';
    preview.setAttribute('aria-hidden', 'true');
    preview.style.left = `${(left - editorRect.left) / scaleX}px`;
    preview.style.top = `${(top - editorRect.top) / scaleY}px`;
    preview.style.width = `${(right - left) / scaleX}px`;
    preview.style.height = `${(bottom - top) / scaleY}px`;

    for (const { element, rect } of measurements) {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.classList.remove(
        'cm-markdown-block-drag-source',
        'cm-markdown-block-drag-source-first',
        'cm-markdown-block-drag-source-last',
        'cm-markdown-block-drop-target',
        'cm-markdown-block-drop-target-first',
        'cm-markdown-block-drop-target-last',
      );
      clone.removeAttribute('contenteditable');
      clone.querySelectorAll<HTMLElement>('[contenteditable]').forEach(node => {
        node.removeAttribute('contenteditable');
      });
      clone.style.position = 'absolute';
      clone.style.left = `${(rect.left - left) / scaleX}px`;
      clone.style.top = `${(rect.top - top) / scaleY}px`;
      clone.style.width = `${rect.width / scaleX}px`;
      clone.style.minHeight = `${rect.height / scaleY}px`;
      clone.style.margin = '0';
      clone.style.maxWidth = 'none';
      clone.style.pointerEvents = 'none';
      preview.appendChild(clone);
    }

    if (blockCount > 1) {
      const count = this.view.dom.ownerDocument.createElement('span');
      count.className = 'cm-markdown-block-drag-count';
      count.textContent = String(blockCount);
      preview.appendChild(count);
    }

    this.view.dom.appendChild(preview);
    this.dragPreview = preview;
  }

  private moveDragPreview(deltaX: number, deltaY: number): void {
    if (!this.dragPreview) return;
    const x = deltaX / (this.view.scaleX || 1);
    const y = deltaY / (this.view.scaleY || 1);
    this.dragPreview.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  private removeDragPreview(): void {
    this.dragPreview?.remove();
    this.dragPreview = null;
  }

  private updateDropTarget(clientY: number): void {
    if (this.draggedBlocks.length === 0) return;
    const candidates = this.measuredBlocks.filter(({ block }) => (
      !this.draggedBlocks.some(dragged => blockMatches(block, dragged))
    ));
    if (candidates.length === 0) {
      this.dropTarget = null;
      this.hideDropIndicator();
      return;
    }

    let nextTarget: { block: MarkdownBlock; placement: MarkdownBlockPlacement } = {
      block: candidates[candidates.length - 1].block,
      placement: 'after',
    };
    for (const { block, measurement: { start, end } } of candidates) {
      const midpoint = start.top + ((end.bottom - start.top) / 2);
      if (clientY < midpoint) {
        nextTarget = { block, placement: 'before' };
        break;
      }
      nextTarget = { block, placement: 'after' };
    }
    this.dropTarget = nextTarget;
    this.showDropIndicator(nextTarget.block, nextTarget.placement);
  }

  private commitDrop(): void {
    const sources = this.draggedBlocks
      .map(block => blockAtCurrentPosition(this.view, block))
      .filter((block): block is MarkdownBlock => block !== null);
    const target = this.dropTarget
      ? blockAtCurrentPosition(this.view, this.dropTarget.block)
      : null;
    const placement = this.dropTarget?.placement ?? 'before';
    if (sources.length !== this.draggedBlocks.length || !target) {
      this.clearDragState();
      return;
    }
    const move = buildMarkdownBlockRangeMove(this.view.state, sources, target, placement);
    this.clearDragState();
    if (!move) return;

    this.view.dispatch({
      changes: move.changes,
      selection: { anchor: move.selectionAnchor },
      effects: setMarkdownBlockSelection.of({
        anchor: move.movedRange.from,
        head: move.movedRange.to,
      }),
      scrollIntoView: true,
      annotations: Transaction.userEvent.of('move.drop'),
    });
    this.view.focus();
  }

  private showDropIndicator(target: MarkdownBlock, placement: MarkdownBlockPlacement): void {
    const nextIndicator: Omit<MarkdownBlockDropIndicator, 'visible'> = placement === 'before'
      ? { position: target.from, side: -1 }
      : { position: target.to, side: 1 };
    const wasFading = this.dropIndicatorRemovalTimer !== null;
    if (this.dropIndicatorRemovalTimer !== null) {
      this.ownerWindow.clearTimeout(this.dropIndicatorRemovalTimer);
      this.dropIndicatorRemovalTimer = null;
    }
    if (!wasFading
      && this.displayedDropIndicator?.position === nextIndicator.position
      && this.displayedDropIndicator.side === nextIndicator.side) return;

    this.displayedDropIndicator = nextIndicator;
    this.view.dispatch({
      effects: setMarkdownBlockDropIndicator.of({ ...nextIndicator, visible: true }),
    });
  }

  private hideDropIndicator(): void {
    const indicator = this.displayedDropIndicator;
    if (!indicator || this.dropIndicatorRemovalTimer !== null) return;
    this.view.dispatch({
      effects: setMarkdownBlockDropIndicator.of({ ...indicator, visible: false }),
    });
    this.dropIndicatorRemovalTimer = this.ownerWindow.setTimeout(() => {
      this.dropIndicatorRemovalTimer = null;
      if (this.displayedDropIndicator !== indicator) return;
      this.displayedDropIndicator = null;
      this.view.dispatch({ effects: setMarkdownBlockDropIndicator.of(null) });
    }, DROP_INDICATOR_FADE_MS);
  }

  private clearDragState(): void {
    this.draggedBlocks = [];
    this.dropTarget = null;
    this.lastPointerY = null;
    this.hideDropIndicator();
    this.removeDragPreview();
  }
}

export function markdownBlockHandlePlugin(options: MarkdownBlockHandleOptions): Extension {
  return [
    markdownBlockDropIndicatorField,
    ViewPlugin.define(view => new MarkdownBlockHandleView(view, options)),
  ];
}
