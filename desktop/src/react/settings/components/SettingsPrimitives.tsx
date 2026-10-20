import React from 'react';
import styles from './settings-components.module.css';

type Gap = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
type SurfaceVariant = 'card' | 'plain';

interface SettingsPageProps extends React.HTMLAttributes<HTMLDivElement> {
  tab: string;
}

export function SettingsPage({ tab, className, children, ...rest }: SettingsPageProps) {
  return (
    <div
      {...rest}
      className={[styles.page, className].filter(Boolean).join(' ')}
      data-settings-page={tab}
      data-tab={tab}
    >
      {children}
    </div>
  );
}

interface SettingsSurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: SurfaceVariant;
}

export function SettingsSurface({ variant = 'card', className, children, ...rest }: SettingsSurfaceProps) {
  return (
    <div
      {...rest}
      className={[
        styles.surface,
        variant === 'card' ? styles.surfaceCard : styles.surfacePlain,
        className,
      ].filter(Boolean).join(' ')}
      data-settings-surface={variant}
    >
      {children}
    </div>
  );
}

interface SettingsStackProps extends React.HTMLAttributes<HTMLDivElement> {
  gap?: Gap;
}

export function SettingsStack({ gap = 'md', className, children, ...rest }: SettingsStackProps) {
  return (
    <div {...rest} className={[styles.stack, styles[`gap-${gap}`], className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}

interface SettingsInlineProps extends React.HTMLAttributes<HTMLDivElement> {
  gap?: Gap;
  align?: 'start' | 'center' | 'end';
  justify?: 'start' | 'center' | 'between' | 'end';
  wrap?: boolean;
}

export function SettingsInline({
  gap = 'sm',
  align = 'center',
  justify = 'start',
  wrap = false,
  className,
  children,
  ...rest
}: SettingsInlineProps) {
  return (
    <div
      {...rest}
      className={[
        styles.inline,
        styles[`gap-${gap}`],
        styles[`align-${align}`],
        styles[`justify-${justify}`],
        wrap && styles.inlineWrap,
        className,
      ].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  );
}

interface SettingsGridProps extends React.HTMLAttributes<HTMLDivElement> {
  columns?: 1 | 2 | 3;
  gap?: Gap;
}

export function SettingsGrid({ columns = 2, gap = 'sm', className, children, ...rest }: SettingsGridProps) {
  return (
    <div
      {...rest}
      className={[styles.grid, styles[`grid-${columns}`], styles[`gap-${gap}`], className].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  );
}
