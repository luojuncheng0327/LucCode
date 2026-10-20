export type FolderIconVariant = 'closed' | 'open';

const FOLDER_ICON_PATHS: Record<FolderIconVariant, string[]> = {
  closed: [
    'M3 7.5a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  ],
  open: [
    'M3 16.9V7.5a2 2 0 0 1 2-2h4.2l2 2H18a2 2 0 0 1 2 2v1.3',
    'M3.2 18.35a1.6 1.6 0 0 0 1.48 1H18.1a2 2 0 0 0 1.9-1.37l1.35-4.05A1.6 1.6 0 0 0 19.83 11H6.95a2 2 0 0 0-1.85 1.25z',
  ],
};

export function getFolderIconPaths(open: boolean): string[] {
  return FOLDER_ICON_PATHS[open ? 'open' : 'closed'];
}

export function getFolderIconSvg({
  open = false,
  size = 14,
  className,
}: {
  open?: boolean;
  size?: number;
  className?: string;
} = {}): string {
  const classAttr = className ? ` class="${className}"` : '';
  const paths = getFolderIconPaths(open)
    .map(path => `<path d="${path}"/>`)
    .join('');
  return `<svg${classAttr} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${paths}</svg>`;
}
