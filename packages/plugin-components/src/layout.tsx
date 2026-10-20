import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './classnames';

export interface CardShellProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}

export function CardShell({
  title,
  description,
  actions,
  footer,
  children,
  className,
  ...sectionProps
}: CardShellProps) {
  return (
    <section {...sectionProps} className={cx('luc-plugin-card', className)}>
      {(title || description || actions) && (
        <header className="luc-plugin-card-header">
          <div className="luc-plugin-card-heading">
            {title && <h2 className="luc-plugin-card-title">{title}</h2>}
            {description && <p className="luc-plugin-card-description">{description}</p>}
          </div>
          {actions && <div className="luc-plugin-card-actions">{actions}</div>}
        </header>
      )}
      <div className="luc-plugin-card-body">{children}</div>
      {footer && <footer className="luc-plugin-card-footer">{footer}</footer>}
    </section>
  );
}

export interface SettingRowProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  hint?: ReactNode;
  control: ReactNode;
  layout?: 'inline' | 'stacked';
}

export function SettingRow({
  label,
  hint,
  control,
  layout = 'inline',
  className,
  ...rowProps
}: SettingRowProps) {
  return (
    <div
      {...rowProps}
      className={cx(
        'luc-plugin-setting-row',
        layout === 'stacked' ? 'luc-plugin-setting-row-stacked' : 'luc-plugin-setting-row-inline',
        className,
      )}
    >
      <div className="luc-plugin-setting-text">
        <div className="luc-plugin-setting-label">{label}</div>
        {hint && <div className="luc-plugin-setting-hint">{hint}</div>}
      </div>
      <div className="luc-plugin-setting-control">{control}</div>
    </div>
  );
}

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action, className, ...rootProps }: EmptyStateProps) {
  return (
    <div {...rootProps} className={cx('luc-plugin-empty', className)}>
      {icon && <div className="luc-plugin-empty-icon">{icon}</div>}
      <div className="luc-plugin-empty-title">{title}</div>
      {description && <div className="luc-plugin-empty-description">{description}</div>}
      {action && <div className="luc-plugin-empty-action">{action}</div>}
    </div>
  );
}

export interface ListItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}

export interface ListProps extends HTMLAttributes<HTMLUListElement> {
  items: ListItem[];
}

export function List({ items, className, ...listProps }: ListProps) {
  return (
    <ul {...listProps} className={cx('luc-plugin-list', className)}>
      {items.map((item) => (
        <li key={item.id} className="luc-plugin-list-item">
          {item.icon && <div className="luc-plugin-list-icon">{item.icon}</div>}
          <div className="luc-plugin-list-main">
            <div className="luc-plugin-list-line">
              <span className="luc-plugin-list-title">{item.title}</span>
              {item.meta && <span className="luc-plugin-list-meta">{item.meta}</span>}
            </div>
            {item.description && <div className="luc-plugin-list-description">{item.description}</div>}
          </div>
          {item.action && <div className="luc-plugin-list-action">{item.action}</div>}
        </li>
      ))}
    </ul>
  );
}
