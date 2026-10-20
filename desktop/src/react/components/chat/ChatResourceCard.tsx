import type { ReactNode } from 'react';
import styles from './ChatResourceCard.module.css';

export type ChatResourceCardStatusTone = 'neutral' | 'success' | 'danger' | 'muted' | 'accent';

export type ChatResourceCardVariant = 'panel' | 'task';

interface ChatResourceCardProps {
  /** headerless 时可省略 */
  icon?: ReactNode;
  /** headerless 时可省略 */
  title?: ReactNode;
  titleMeta?: ReactNode;
  titleTail?: ReactNode;
  subtitle?: ReactNode;
  statusLabel?: ReactNode;
  statusTone?: ChatResourceCardStatusTone;
  actionSlot?: ReactNode;
  onClick?: () => void;
  onToggle?: () => void;
  expanded?: boolean;
  expandable?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  variant?: ChatResourceCardVariant;
  /** 无头形态：跳过头部行（icon/title/subtitle/status），只渲染卡壳 + children。编辑态表单卡用。 */
  headerless?: boolean;
  children?: ReactNode;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function CardBody({
  icon,
  title,
  titleMeta,
  titleTail,
  subtitle,
  statusLabel,
  statusTone = 'neutral',
  expandable = false,
  expanded = false,
}: Pick<ChatResourceCardProps, 'icon' | 'title' | 'titleMeta' | 'titleTail' | 'subtitle' | 'statusLabel' | 'statusTone' | 'expandable' | 'expanded'>) {
  return (
    <>
      <span className={styles.icon} aria-hidden="true">{icon}</span>
      <span className={styles.body}>
        <span className={styles.titleRow}>
          <span className={styles.title}>{title}</span>
          {titleMeta && <span className={styles.titleMeta}>{titleMeta}</span>}
          {statusLabel && (
            <span className={cx(styles.status, styles[`status-${statusTone}`])}>
              {statusLabel}
            </span>
          )}
          {titleTail && <span className={styles.titleTail}>{titleTail}</span>}
        </span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
      </span>
      {expandable && (
        <span className={cx(styles.chevron, expanded && styles.chevronExpanded)} aria-hidden="true">
          ›
        </span>
      )}
    </>
  );
}

export function ChatResourceCard({
  icon,
  title,
  titleMeta,
  titleTail,
  subtitle,
  statusLabel,
  statusTone = 'neutral',
  actionSlot,
  onClick,
  onToggle,
  expanded = false,
  expandable = false,
  disabled = false,
  className,
  ariaLabel,
  variant = 'panel',
  headerless = false,
  children,
}: ChatResourceCardProps) {
  const activate = onToggle ?? onClick;
  const interactive = !!activate && !disabled;
  const rootClass = cx(
    styles.card,
    variant === 'task' && styles.task,
    interactive && styles.interactive,
    expanded && styles.expanded,
    disabled && styles.disabled,
    className,
  );

  return (
    <div className={rootClass} data-chat-resource-card="" data-variant={variant}>
      {!headerless && (
      <div className={styles.header}>
        {interactive ? (
          <button
            type="button"
            className={styles.main}
            onClick={activate}
            aria-label={ariaLabel}
            aria-expanded={expandable ? expanded : undefined}
          >
            <CardBody
              icon={icon}
              title={title}
              titleMeta={titleMeta}
              titleTail={titleTail}
              subtitle={subtitle}
              statusLabel={statusLabel}
              statusTone={statusTone}
              expandable={expandable}
              expanded={expanded}
            />
          </button>
        ) : (
          <div
            className={styles.main}
            aria-label={ariaLabel}
            aria-disabled={disabled || undefined}
          >
            <CardBody
              icon={icon}
              title={title}
              titleMeta={titleMeta}
              titleTail={titleTail}
              subtitle={subtitle}
              statusLabel={statusLabel}
              statusTone={statusTone}
              expandable={expandable}
              expanded={expanded}
            />
          </div>
        )}
        {actionSlot && <div className={styles.actions}>{actionSlot}</div>}
      </div>
      )}
      {children && (headerless || expanded) && <div className={styles.details}>{children}</div>}
    </div>
  );
}
