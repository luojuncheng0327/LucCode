import type { SVGProps } from 'react';
import { getFolderIconPaths } from './folder-icons';

type FolderIconProps = Omit<SVGProps<SVGSVGElement>, 'viewBox'> & {
  open?: boolean;
  size?: number | string;
};

export function FolderIcon({
  open = false,
  size = 14,
  width,
  height,
  'aria-hidden': ariaHidden = true,
  ...svgProps
}: FolderIconProps) {
  return (
    <svg
      {...svgProps}
      width={width ?? size}
      height={height ?? size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaHidden}
    >
      {getFolderIconPaths(open).map(path => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
