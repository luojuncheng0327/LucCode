import type { EditorView } from '@codemirror/view';
import {
  insertCodeBlock,
  insertHorizontalRule,
  setHeading,
  toggleBlockquote,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleList,
  toggleStrikethrough,
  type MarkdownInlineCommandOptions,
} from '../../editor/markdown-commands';

interface EditorFormatMenuProps {
  blockTarget: boolean;
  close: () => void;
  runBlockCommand: (
    selection: 'block' | 'start',
    command: (view: EditorView) => void,
  ) => void;
}

function label(key: string, fallback: string): string {
  const translated = window.t?.(key);
  return translated && translated !== key ? translated : fallback;
}

export function EditorFormatMenu({
  blockTarget,
  close,
  runBlockCommand,
}: EditorFormatMenuProps) {
  const runInlineCommand = (
    command: (view: EditorView, options?: MarkdownInlineCommandOptions) => void,
  ) => {
    close();
    runBlockCommand('block', view => command(view, { blockRange: blockTarget }));
  };

  return (
    <>
      <div className="context-menu-divider" />
      <div className="context-menu-fmt-row">
        <FmtButton title={label('ctx.bold', '粗体')} onClick={() => runInlineCommand(toggleBold)}>
          <span className="context-menu-fmt-text" style={{ fontWeight: 700 }}>B</span>
        </FmtButton>
        <FmtButton title={label('ctx.italic', '斜体')} onClick={() => runInlineCommand(toggleItalic)}>
          <span className="context-menu-fmt-text" style={{ fontStyle: 'italic' }}>I</span>
        </FmtButton>
        <FmtButton title={label('ctx.strikethrough', '删除线')} onClick={() => runInlineCommand(toggleStrikethrough)}>
          <span className="context-menu-fmt-text" style={{ textDecoration: 'line-through' }}>S</span>
        </FmtButton>
        <FmtButton title={label('ctx.inlineCode', '行内代码')} onClick={() => runInlineCommand(toggleInlineCode)}>
          <svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
        </FmtButton>
        <FmtButton title={label('ctx.heading1', '标题 1')} onClick={() => { close(); runBlockCommand('block', v => setHeading(v, 1)); }}>
          <span className="context-menu-fmt-text" style={{ fontSize: '0.8em', fontWeight: 600 }}>H<sub>1</sub></span>
        </FmtButton>
        <FmtButton title={label('ctx.heading2', '标题 2')} onClick={() => { close(); runBlockCommand('block', v => setHeading(v, 2)); }}>
          <span className="context-menu-fmt-text" style={{ fontSize: '0.75em', fontWeight: 500 }}>H<sub>2</sub></span>
        </FmtButton>
        <FmtButton title={label('ctx.heading3', '标题 3')} onClick={() => { close(); runBlockCommand('block', v => setHeading(v, 3)); }}>
          <span className="context-menu-fmt-text" style={{ fontSize: '0.7em', fontWeight: 500 }}>H<sub>3</sub></span>
        </FmtButton>
      </div>
      <div className="context-menu-fmt-row">
        <FmtButton title={label('ctx.blockquote', '引用')} onClick={() => { close(); runBlockCommand('block', toggleBlockquote); }}>
          <svg viewBox="0 0 24 24" style={{ fill: 'currentColor', stroke: 'none' }}>
            <path fillRule="evenodd" clipRule="evenodd" d="M20 5H4V19H20V5ZM4 3C2.89543 3 2 3.89543 2 5V19C2 20.1046 2.89543 21 4 21H20C21.1046 21 22 20.1046 22 19V5C22 3.89543 21.1046 3 20 3H4Z" />
            <path d="M9.06723 9.19629H12.0672L9.93267 14.8038H6.93267L9.06723 9.19629Z" />
            <path d="M14.0672 9.19629H17.0672L14.9327 14.8038H11.9327L14.0672 9.19629Z" />
          </svg>
        </FmtButton>
        <FmtButton title={label('ctx.codeBlock', '代码块')} onClick={() => { close(); runBlockCommand('block', insertCodeBlock); }}>
          <svg viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <polyline points="9 8 7 12 9 16" />
            <polyline points="15 8 17 12 15 16" />
          </svg>
        </FmtButton>
        <FmtButton title={label('ctx.horizontalRule', '分隔线')} onClick={() => { close(); runBlockCommand('start', insertHorizontalRule); }}>
          <svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12" /></svg>
        </FmtButton>
        <FmtButton title={label('ctx.list', '列表')} onClick={() => { close(); runBlockCommand('block', toggleList); }}>
          <svg viewBox="0 0 24 24">
            <line x1="9" y1="6" x2="20" y2="6" />
            <line x1="9" y1="12" x2="20" y2="12" />
            <line x1="9" y1="18" x2="20" y2="18" />
            <circle cx="4.5" cy="6" r="1.2" />
            <circle cx="4.5" cy="12" r="1.2" />
            <circle cx="4.5" cy="18" r="1.2" />
          </svg>
        </FmtButton>
      </div>
    </>
  );
}

function FmtButton({ title, onClick, children }: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="context-menu-fmt-btn"
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
    >
      {children}
    </div>
  );
}
