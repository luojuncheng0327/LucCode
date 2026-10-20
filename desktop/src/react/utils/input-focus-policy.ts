interface InputFocusPolicyOptions {
  document?: Document;
  inputRoot?: HTMLElement | null;
}

export function shouldAllowInputFocus(options: InputFocusPolicyOptions = {}): boolean {
  const doc = options.document ?? (typeof document !== 'undefined' ? document : null);
  if (!doc) return false;
  const inputRoot = options.inputRoot ?? null;

  if (hasOpenModal(doc, inputRoot)) return false;
  if (hasTextSelection(doc)) return false;

  const active = doc.activeElement as HTMLElement | null;
  if (!active || active === doc.body || active === doc.documentElement) return true;
  return !!inputRoot && inputRoot.contains(active);
}

function hasOpenModal(doc: Document, inputRoot: HTMLElement | null): boolean {
  const modal = doc.querySelector<HTMLElement>('[aria-modal="true"], [role="dialog"]');
  if (!modal) return false;
  return !(inputRoot && inputRoot.contains(modal));
}

function hasTextSelection(doc: Document): boolean {
  const selection = doc.getSelection?.();
  return !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
}
