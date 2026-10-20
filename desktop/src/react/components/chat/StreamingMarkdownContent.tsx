import { memo } from 'react';
import type { LinkOpenContext } from '../../utils/link-open';
import { MarkdownContent } from './MarkdownContent';
import styles from './Chat.module.css';

interface Props {
  html: string;
  source?: string;
  active?: boolean;
  className?: string;
  linkContext?: LinkOpenContext;
}

function cx(...parts: Array<string | false | null | undefined>): string | undefined {
  const value = parts.filter(Boolean).join(' ');
  return value || undefined;
}

export const StreamingMarkdownContent = memo(function StreamingMarkdownContent({
  html,
  source,
  active = false,
  className,
  linkContext,
}: Props) {
  const shouldAnimateStream = !!source && active;

  return (
    <MarkdownContent
      html={html}
      className={cx(className, shouldAnimateStream && styles.streamMarkdownBlockEnter)}
      linkContext={linkContext}
    />
  );
});
