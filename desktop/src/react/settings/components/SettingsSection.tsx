import React, { useId } from 'react';
import styles from './settings-components.module.css';
import { SettingsSurface } from './SettingsPrimitives';

type Variant = 'default' | 'hero' | 'double-column' | 'list';
type Surface = 'card' | 'plain';

interface SettingsSectionProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Section 的上下文（如 agent 选择器），渲染在 title 右侧。
   *  用于表达"这个 section 针对哪个对象"——context 选中什么，section 内的配置就作用于什么。 */
  context?: React.ReactNode;
  variant?: Variant;
  surface?: Surface;
  children: React.ReactNode;
  className?: string;
}

interface FooterProps {
  children: React.ReactNode;
}

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

function Card({ children, className, ...rest }: CardProps) {
  return <SettingsSurface className={className} {...rest}>{children}</SettingsSurface>;
}

function Footer({ children }: FooterProps) {
  return <div className={styles.sectionFooter}>{children}</div>;
}

interface SubBlockProps {
  title?: React.ReactNode;
  children: React.ReactNode;
}

function SubBlock({ title, children }: SubBlockProps) {
  return (
    <div className={styles.subBlock}>
      {title && <h3 className={styles.subBlockTitle}>{title}</h3>}
      {children}
    </div>
  );
}

interface WarningProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

function Note({ children, className, ...rest }: WarningProps) {
  return <div className={[styles.sectionNote, className].filter(Boolean).join(' ')} {...rest}>{children}</div>;
}

function Warning({ children, className, ...rest }: WarningProps) {
  return <div className={[styles.sectionWarning, className].filter(Boolean).join(' ')} {...rest}>{children}</div>;
}

function SettingsSectionBase({
  title,
  description,
  context,
  variant = 'default',
  surface,
  children,
  className,
}: SettingsSectionProps) {
  const id = useId();
  const titleId = title ? `${id}-title` : undefined;
  const descriptionId = description ? `${id}-description` : undefined;
  const effectiveSurface = surface ?? (variant === 'hero' || variant === 'double-column' ? 'plain' : 'card');
  const rootClass = [
    styles.section,
    variant === 'hero' && styles.sectionHero,
    variant === 'double-column' && styles.sectionDoubleColumn,
    effectiveSurface === 'plain' && styles.sectionPlain,
    variant === 'list' && styles.sectionList,
    className,
  ].filter(Boolean).join(' ');

  const hasHeader = (title || context) && variant !== 'hero';
  const headerClass = [
    styles.sectionHeader,
    description && styles.sectionHeaderWithDescription,
  ].filter(Boolean).join(' ');

  return (
    <section className={rootClass} aria-labelledby={titleId} aria-describedby={descriptionId}>
      {hasHeader && (
        <div className={headerClass}>
          {title && <h2 id={titleId} className={styles.sectionTitle}>{title}</h2>}
          {context && <div className={styles.sectionContext}>{context}</div>}
        </div>
      )}
      {description && <div id={descriptionId} className={styles.sectionDescription}>{description}</div>}
      <SettingsSurface variant={effectiveSurface} className={styles.sectionBody}>
        {children}
      </SettingsSurface>
    </section>
  );
}

export const SettingsSection = Object.assign(SettingsSectionBase, {
  Card,
  Footer,
  Note,
  SubBlock,
  Warning,
});
