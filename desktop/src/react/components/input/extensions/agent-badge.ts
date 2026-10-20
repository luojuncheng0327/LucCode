import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { MentionBadgeView } from '../MentionBadgeView';

export const AgentBadge = Node.create({
  name: 'agentBadge',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      agentId: { default: null },
      label: { default: '' },
    };
  },

  parseHTML() { return [{ tag: 'span[data-agent-mention]' }]; },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-agent-mention': '',
      'data-agent-id': HTMLAttributes.agentId || '',
      'data-label': HTMLAttributes.label || '',
    })];
  },

  addNodeView() { return ReactNodeViewRenderer(MentionBadgeView); },
});
