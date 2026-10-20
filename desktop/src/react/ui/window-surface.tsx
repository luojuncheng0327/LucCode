import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { surfaceFromWindow, type WindowSurface } from '../window-surface';

const WindowSurfaceContext = createContext<WindowSurface | null>(null);

function defaultWindowSurface(): WindowSurface {
  return surfaceFromWindow(window);
}

export function WindowSurfaceProvider({ surface, children }: { surface: WindowSurface; children: ReactNode }) {
  return (
    <WindowSurfaceContext.Provider value={surface}>
      {children}
    </WindowSurfaceContext.Provider>
  );
}

export function useWindowSurface(): WindowSurface {
  const surface = useContext(WindowSurfaceContext);
  return useMemo(() => surface ?? defaultWindowSurface(), [surface]);
}

export {
  MAIN_WINDOW_SURFACE_ID,
  registerWindowSurfaceDocument,
  surfaceForElement,
  surfaceFromDocument,
  surfaceFromWindow,
  type WindowSurface,
} from '../window-surface';
