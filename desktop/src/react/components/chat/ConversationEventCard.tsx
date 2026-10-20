import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import styles from './Chat.module.css';

export function ConversationEventCard({
  children,
  align = 'center',
  size = 'compact',
  rowClassName = '',
  cardClassName = '',
  status,
  onActivate,
  ariaLabel,
}: {
  children: ReactNode;
  align?: 'center' | 'end';
  size?: 'compact' | 'expanded';
  rowClassName?: string;
  cardClassName?: string;
  status?: string;
  onActivate?: () => void;
  ariaLabel?: string;
}) {
  const activateFromPointer = (event: MouseEvent<HTMLElement>) => {
    if (!onActivate) return;
    const target = event.target as HTMLElement;
    if (target.closest('a, button')) return;
    onActivate();
  };
  const activateFromKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (!onActivate || (event.key !== 'Enter' && event.key !== ' ')) return;
    const target = event.target as HTMLElement;
    if (target.closest('a, button')) return;
    event.preventDefault();
    onActivate();
  };

  return (
    <div className={`${styles.conversationEventRow} ${styles[`conversationEventRow-${align}`]} ${rowClassName}`.trim()}>
      <section
        className={`${styles.conversationEventCard} ${styles[`conversationEventCard-${size}`]} ${onActivate ? styles.conversationEventCardClickable : ''} ${cardClassName}`.trim()}
        {...(status ? { 'data-event-status': status } : {})}
        {...(onActivate ? {
          role: 'link',
          tabIndex: 0,
          'aria-label': ariaLabel,
          onClick: activateFromPointer,
          onKeyDown: activateFromKeyboard,
        } : {})}
      >
        {children}
      </section>
    </div>
  );
}
