import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { MentionBadgeView } from '../MentionBadgeView';

export const SessionBadge = Node.create({
  name: 'sessionBadge',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      sessionId: { default: null },
      label: { default: '' },
    };
  },

  parseHTML() { return [{ tag: 'span[data-session-mention]' }]; },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-session-mention': '',
      'data-session-id': HTMLAttributes.sessionId || '',
      'data-label': HTMLAttributes.label || '',
    })];
  },

  addNodeView() { return ReactNodeViewRenderer(MentionBadgeView); },
});
