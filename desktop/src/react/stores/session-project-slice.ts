import type { SessionProjectCatalog } from '../types/session-projects';

export const EMPTY_SESSION_PROJECT_CATALOG: SessionProjectCatalog = { folders: [], projects: [] };

export interface SessionProjectSlice {
  sessionProjectCatalog: SessionProjectCatalog;
  sessionProjectCatalogLoaded: boolean;
  setSessionProjectCatalog: (catalog: SessionProjectCatalog) => void;
}

export const createSessionProjectSlice = (
  set: (partial: Partial<SessionProjectSlice> | ((s: SessionProjectSlice) => Partial<SessionProjectSlice>)) => void,
): SessionProjectSlice => ({
  sessionProjectCatalog: EMPTY_SESSION_PROJECT_CATALOG,
  sessionProjectCatalogLoaded: false,
  setSessionProjectCatalog: (catalog) => set({
    sessionProjectCatalog: catalog,
    sessionProjectCatalogLoaded: true,
  }),
});
