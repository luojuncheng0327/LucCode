import { memo, useMemo } from 'react';
import type { ContentBlock } from '../../stores/chat-types';
import type { LinkOpenContext } from '../../utils/link-open';
import { buildAssistantBlocksFromContent } from '../../utils/assistant-block-builder';
import { MoodBlock } from './MoodBlock';
import { PluginCardBlock } from './PluginCardBlock';
import { StreamingMarkdownContent } from './StreamingMarkdownContent';

export const AssistantContentPreview = memo(function AssistantContentPreview({
  content,
  className,
  linkContext,
}: {
  content: string;
  className?: string;
  linkContext?: LinkOpenContext;
}) {
  const blocks = useMemo(() => buildAssistantBlocksFromContent({
    content,
    includeTextSource: true,
  }), [content]);

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <AssistantPreviewBlock
          key={`${block.type}-${index}`}
          block={block}
          linkContext={linkContext}
        />
      ))}
    </div>
  );
});

function AssistantPreviewBlock({
  block,
  linkContext,
}: {
  block: ContentBlock;
  linkContext?: LinkOpenContext;
}) {
  if (block.type === 'mood') {
    return <MoodBlock yuan={block.yuan} text={block.text} />;
  }
  if (block.type === 'text') {
    return (
      <StreamingMarkdownContent
        html={block.html}
        source={block.source}
        active={false}
        linkContext={linkContext}
      />
    );
  }
  if (block.type === 'plugin_card') {
    return <PluginCardBlock card={block.card} />;
  }
  return null;
}
