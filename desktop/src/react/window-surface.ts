export const MAIN_WINDOW_SURFACE_ID = 'main';

export interface WindowSurface {
  id: string;
  window: Window;
  document: Document;
  overlayRoot: HTMLElement;
}

interface SurfaceOptions {
  id?: string;
  overlayRoot?: HTMLElement;
}

const documentSurfaceIds = new WeakMap<Document, string>();

export function registerWindowSurfaceDocument(surfaceDocument: Document, id: string): void {
  documentSurfaceIds.set(surfaceDocument, id);
}

function surfaceIdForDocument(surfaceDocument: Document, fallbackId = MAIN_WINDOW_SURFACE_ID): string {
  return documentSurfaceIds.get(surfaceDocument) ?? fallbackId;
}

export function surfaceFromWindow(
  surfaceWindow: Window,
  overlayRootOrOptions?: HTMLElement | SurfaceOptions,
  id = MAIN_WINDOW_SURFACE_ID,
): WindowSurface {
  const options = isElementLike(overlayRootOrOptions)
    ? { overlayRoot: overlayRootOrOptions, id }
    : overlayRootOrOptions;
  const surfaceId = options?.id ?? id;
  registerWindowSurfaceDocument(surfaceWindow.document, surfaceId);
  return {
    id: surfaceId,
    window: surfaceWindow,
    document: surfaceWindow.document,
    overlayRoot: options?.overlayRoot ?? surfaceWindow.document.body,
  };
}

function isElementLike(value: unknown): value is HTMLElement {
  return !!value && typeof (value as HTMLElement).nodeType === 'number';
}

export function surfaceFromDocument(
  surfaceDocument: Document,
  fallbackWindow: Window = window,
  fallbackId = MAIN_WINDOW_SURFACE_ID,
): WindowSurface {
  const surfaceId = surfaceIdForDocument(surfaceDocument, fallbackId);
  registerWindowSurfaceDocument(surfaceDocument, surfaceId);
  return {
    id: surfaceId,
    window: surfaceDocument.defaultView ?? fallbackWindow,
    document: surfaceDocument,
    overlayRoot: surfaceDocument.body,
  };
}

export function surfaceForElement(element: Element | null | undefined, fallback: WindowSurface): WindowSurface {
  const ownerDocument = element?.ownerDocument ?? fallback.document;
  if (ownerDocument === fallback.document) return fallback;
  return {
    id: surfaceIdForDocument(ownerDocument, fallback.id),
    window: ownerDocument.defaultView ?? fallback.window,
    document: ownerDocument,
    overlayRoot: ownerDocument.body,
  };
}
