import type { Session } from '../types';

export interface SessionProject {
  id: string;
  name: string;
  folderId: string | null;
  order: number;
}

export interface SessionProjectFolder {
  id: string;
  name: string;
  order: number;
}

export interface SessionProjectCatalog {
  folders?: SessionProjectFolder[];
  projects: SessionProject[];
}

export interface SessionProjectGroup {
  id: string;
  name: string;
  folderId: string | null;
  order: number;
  source: 'catalog' | 'cwd';
  items: Session[];
}

export interface SessionProjectFolderGroup {
  id: string;
  name: string;
  order: number;
  projects: SessionProjectGroup[];
}
