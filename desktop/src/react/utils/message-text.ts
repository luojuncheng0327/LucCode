import { useStore } from '../stores';
import { sessionScopedValue } from '../stores/session-slice';
import type { ContentBlock } from '../stores/chat-types';

function textFromHtml(html: string): string {
  // eslint-disable-next-line no-restricted-syntax
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.innerText ?? tmp.textContent ?? '').trim();
}

export function extractTextBlockPlainText(blocks: readonly ContentBlock[]): string {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    const source = typeof block.source === 'string' ? block.source.trim() : '';
    if (source) {
      texts.push(source);
      continue;
    }
    if (block.html) texts.push(textFromHtml(block.html));
  }
  return texts.filter(Boolean).join('\n');
}

export function extractSelectedTexts(sessionPath: string, selectedIds: readonly string[]): string {
  const state = useStore.getState();
  const session = sessionScopedValue(state, state.chatSessions, sessionPath);
  if (!session) return '';
  const texts: string[] = [];
  for (const item of session.items) {
    if (item.type !== 'message') continue;
    if (!selectedIds.includes(item.data.id)) continue;
    if (item.data.role === 'user') {
      if (item.data.text) texts.push(item.data.text);
    } else {
      const textBlocks = (item.data.blocks || []).filter(
        (b): b is ContentBlock & { type: 'text' } => b.type === 'text'
      );
      if (textBlocks.length > 0) {
        texts.push(extractTextBlockPlainText(textBlocks));
      }
    }
  }
  return texts.join('\n\n');
}
