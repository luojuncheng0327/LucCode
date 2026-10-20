import type { SVGProps } from 'react';
import type { FileKind } from '../../types/file-ref';

type FileKindIconProps = Omit<SVGProps<SVGSVGElement>, 'viewBox'> & {
  kind: FileKind;
  size?: number | string;
};

export function FileKindIcon({
  kind,
  size = 16,
  width,
  height,
  'aria-hidden': ariaHidden = true,
  ...svgProps
}: FileKindIconProps) {
  const commonProps = {
    ...svgProps,
    width: width ?? size,
    height: height ?? size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': ariaHidden,
    'data-file-kind': kind,
  };

  if (kind === 'image' || kind === 'svg') {
    return (
      <svg {...commonProps}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    );
  }

  if (kind === 'video') {
    return (
      <svg {...commonProps}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <polygon points="10 9 15 12 10 15 10 9" />
      </svg>
    );
  }

  if (kind === 'audio') {
    return (
      <svg {...commonProps}>
        <path d="M4 10v4" />
        <path d="M8 7v10" />
        <path d="M12 5v14" />
        <path d="M16 8v8" />
        <path d="M20 11v2" />
      </svg>
    );
  }

  if (kind === 'code') {
    return (
      <svg {...commonProps}>
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    );
  }

  if (kind === 'markdown') {
    return (
      <svg {...commonProps}>
        <path d="M4 5h16v14H4z" />
        <path d="M7 15V9l3 3 3-3v6" />
        <path d="M16 9v6" />
        <path d="M14.5 13.5 16 15l1.5-1.5" />
      </svg>
    );
  }

  if (kind === 'pdf' || kind === 'doc') {
    return (
      <svg {...commonProps}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="14" y2="17" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
