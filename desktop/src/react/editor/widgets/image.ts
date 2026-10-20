import { EditorView, WidgetType, Decoration } from '@codemirror/view';
import type { DecoRange } from '../md-decorations';
import {
  parseImageLabel,
  resolveMarkdownImageSrc,
  type ImageDimensions,
  type MarkdownImageContext,
} from '../../utils/markdown';

export class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string, readonly dimensions: ImageDimensions | null = null) { super(); }

  eq(other: ImageWidget) {
    return this.url === other.url
      && this.alt === other.alt
      && this.dimensions?.width === other.dimensions?.width
      && this.dimensions?.height === other.dimensions?.height;
  }

  toDOM() {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-image-widget';
    const img = document.createElement('img');
    img.src = this.url;
    img.alt = this.alt;
    img.loading = 'lazy';
    if (this.dimensions?.width) img.width = Number(this.dimensions.width);
    if (this.dimensions?.height) img.height = Number(this.dimensions.height);
    img.onerror = () => {
      wrapper.innerHTML = '';
      const fallback = document.createElement('span');
      fallback.className = 'cm-image-fallback';
      fallback.textContent = this.alt || this.url;
      wrapper.appendChild(fallback);
    };
    wrapper.appendChild(img);
    return wrapper;
  }
}

type ImageDecorationPlacement = 'replace-source' | 'below-source-line';

function isSafeImagePreviewUrl(url: string): boolean {
  return url.startsWith('/')
    || url.startsWith('http://')
    || url.startsWith('https://')
    || url.startsWith('file://');
}

export function addImageDecoration(ctx: {
  ranges: DecoRange[];
  from: number;
  to: number;
  lineTo: number;
  url: string;
  alt: string;
  dimensions: ImageDimensions | null;
  placement: ImageDecorationPlacement;
}): void {
  const { ranges, from, to, lineTo, url, alt, dimensions, placement } = ctx;
  if (!isSafeImagePreviewUrl(url)) return;

  const widget = new ImageWidget(url, alt, dimensions);
  if (placement === 'below-source-line') {
    ranges.push({
      from: lineTo,
      to: lineTo,
      deco: Decoration.widget({ widget, block: true, side: 1 }),
    });
    return;
  }

  ranges.push({
    from,
    to,
    deco: Decoration.replace({ widget }),
  });
}

export function addStandardMarkdownImageDecoration(ctx: {
  source: string;
  ranges: DecoRange[];
  from: number;
  to: number;
  lineTo: number;
  imageContext?: MarkdownImageContext;
  placement: ImageDecorationPlacement;
}): void {
  const { source, ranges, from, to, lineTo, imageContext, placement } = ctx;
  const urlMatch = source.match(/!\[([^\]]*)\]\(([^)]+)\)/);
  if (!urlMatch) return;

  const alt = urlMatch[1];
  const rawUrl = urlMatch[2].trim().replace(/^<([\s\S]+)>$/, '$1');
  const label = parseImageLabel(alt);
  const url = resolveMarkdownImageSrc(rawUrl, imageContext);

  addImageDecoration({
    ranges,
    from,
    to,
    lineTo,
    url,
    alt: label.alt,
    dimensions: label.dimensions,
    placement,
  });
}

export function handleImage(ctx: {
  view: EditorView;
  node: { name: string; from: number; to: number };
  activeLines: Set<number>;
  ranges: DecoRange[];
  imageContext?: MarkdownImageContext;
}) {
  const { view, node, activeLines, ranges, imageContext } = ctx;
  const line = view.state.doc.lineAt(node.from);

  // Cross-line guard: Image should be single-line
  if (view.state.doc.lineAt(node.to).number !== line.number) return;
  if (activeLines.has(line.number)) return;

  const text = view.state.doc.sliceString(node.from, node.to);
  addStandardMarkdownImageDecoration({
    source: text,
    ranges,
    from: node.from,
    to: node.to,
    lineTo: line.to,
    imageContext,
    placement: 'replace-source',
  });
}
