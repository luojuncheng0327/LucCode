import crypto from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../shared/safe-fs.ts";
import {
  SESSION_PROJECTS_FILENAME,
  normalizeProjectName,
  normalizeSessionProjectCatalog,
  normalizeSessionProjectId,
  isAutoProjectId,
  serializeSessionProjectCatalog,
} from "../shared/session-projects.ts";

export class SessionProjectCatalogStore {
  declare _userDir: string;
  declare _path: string;

  constructor({ userDir }) {
    if (!userDir) throw new Error("SessionProjectCatalogStore requires userDir");
    this._userDir = userDir;
    this._path = path.join(userDir, SESSION_PROJECTS_FILENAME);
  }

  getCatalog() {
    return normalizeSessionProjectCatalog(this._readRaw());
  }

  createFolder({ name }) {
    const catalog = this.getCatalog();
    const folder = {
      id: this._nextId("folder", new Set(catalog.folders.map(item => item.id))),
      name: requiredName(normalizeProjectName(name), "folder name is required"),
      order: nextOrder(catalog.folders),
    };
    catalog.folders.push(folder);
    this._writeCatalog(catalog);
    return folder;
  }

  updateFolder(id, patch: Record<string, any> = {}) {
    const catalog = this.getCatalog();
    const folderId = normalizeSessionProjectId(id);
    const index = catalog.folders.findIndex(folder => folder.id === folderId);
    if (index < 0) throw new Error("folder not found");
    const current = catalog.folders[index];
    const next = { ...current };
    if (Object.prototype.hasOwnProperty.call(patch, "name")) {
      next.name = requiredName(normalizeProjectName(patch.name), "folder name is required");
    }
    catalog.folders[index] = next;
    this._writeCatalog(catalog);
    return next;
  }

  deleteFolder(id) {
    const catalog = this.getCatalog();
    const folderId = normalizeSessionProjectId(id);
    const folderIndex = catalog.folders.findIndex(folder => folder.id === folderId);
    if (folderIndex < 0) throw new Error("folder not found");

    const movingProjects = catalog.projects
      .filter(project => project.folderId === folderId)
      .sort(compareCatalogItems);
    let order = nextOrder(catalog.projects.filter(project => project.folderId === null));
    const movedById = new Map(movingProjects.map(project => [
      project.id,
      { ...project, folderId: null, order: order++ },
    ]));

    catalog.folders = catalog.folders.filter(folder => folder.id !== folderId);
    catalog.projects = catalog.projects
      .map(project => movedById.get(project.id) || project)
      .sort(compareCatalogItems);
    this._writeCatalog(catalog);
    return catalog;
  }

  reorderFolders({ folderIds = [] } = {}) {
    const catalog = this.getCatalog();
    const order = new Map(normalizeIdArray(folderIds).map((id, index) => [id, index]));
    catalog.folders = reorderScopedItems(catalog.folders, order);
    this._writeCatalog(catalog);
    return catalog;
  }

  createProject({ name, folderId = null }) {
    const catalog = this.getCatalog();
    const normalizedFolderId = resolveFolderId(catalog, folderId);
    const project = {
      id: this._nextId("project", new Set(catalog.projects.map(item => item.id))),
      name: requiredName(normalizeProjectName(name), "project name is required"),
      folderId: normalizedFolderId,
      order: nextOrder(catalog.projects.filter(item => item.folderId === normalizedFolderId)),
    };
    catalog.projects.push(project);
    this._writeCatalog(catalog);
    return project;
  }

  updateProject(id, patch: Record<string, any> = {}) {
    const catalog = this.getCatalog();
    const projectId = normalizeSessionProjectId(id);
    const index = catalog.projects.findIndex(project => project.id === projectId);
    if (index < 0) {
      if (!isAutoProjectId(projectId)) throw new Error("project not found");
      const folderId = Object.prototype.hasOwnProperty.call(patch, "folderId")
        ? resolveFolderId(catalog, patch.folderId)
        : null;
      const project = {
        id: projectId,
        name: requiredName(normalizeProjectName(patch.name), "project name is required"),
        folderId,
        order: nextOrder(catalog.projects.filter(item => item.folderId === folderId)),
      };
      catalog.projects.push(project);
      this._writeCatalog(catalog);
      return project;
    }
    const current = catalog.projects[index];
    const next = { ...current };
    if (Object.prototype.hasOwnProperty.call(patch, "name")) {
      next.name = requiredName(normalizeProjectName(patch.name), "project name is required");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "folderId")) {
      const folderId = resolveFolderId(catalog, patch.folderId);
      if (folderId !== current.folderId) {
        next.folderId = folderId;
        next.order = nextOrder(catalog.projects.filter(item => item.id !== current.id && item.folderId === folderId));
      }
    }
    catalog.projects[index] = next;
    this._writeCatalog(catalog);
    return next;
  }

  deleteProject(id) {
    const catalog = this.getCatalog();
    const projectId = normalizeSessionProjectId(id);
    const index = catalog.projects.findIndex(project => project.id === projectId);
    if (index < 0) {
      if (isAutoProjectId(projectId)) return catalog;
      throw new Error("project not found");
    }
    catalog.projects.splice(index, 1);
    this._writeCatalog(catalog);
    return catalog;
  }

  reorderProjects({ folderId = null, projectIds = [] } = {}) {
    const catalog = this.getCatalog();
    const targetFolderId = resolveFolderId(catalog, folderId);
    const order = new Map(normalizeIdArray(projectIds).map((id, index) => [id, index]));
    const targetProjects = catalog.projects.filter(project => project.folderId === targetFolderId);
    const reorderedTarget = reorderScopedItems(targetProjects, order);
    const reorderedById = new Map(reorderedTarget.map(project => [project.id, project]));
    catalog.projects = catalog.projects
      .map(project => reorderedById.get(project.id) || project)
      .sort(compareCatalogItems);
    this._writeCatalog(catalog);
    return catalog;
  }

  _readRaw() {
    try {
      return JSON.parse(fs.readFileSync(this._path, "utf-8"));
    } catch (err) {
      if (err?.code === "ENOENT") return {};
      return {};
    }
  }

  _writeCatalog(catalog) {
    fs.mkdirSync(this._userDir, { recursive: true });
    atomicWriteSync(this._path, JSON.stringify(serializeSessionProjectCatalog(catalog), null, 2) + "\n");
  }

  _nextId(prefix, existingIds) {
    for (let i = 0; i < 8; i += 1) {
      const id = `${prefix}-${crypto.randomUUID()}`;
      if (!existingIds.has(id)) return id;
    }
    throw new Error(`could not allocate ${prefix} id`);
  }
}

function requiredName(name, message) {
  if (!name) throw new Error(message);
  return name;
}

function nextOrder(items) {
  return items.reduce((max, item) => Math.max(max, Number(item.order) || 0), -1) + 1;
}

function resolveFolderId(catalog, folderId) {
  const normalized = normalizeSessionProjectId(folderId);
  if (!normalized) return null;
  if (!catalog.folders.some(folder => folder.id === normalized)) throw new Error("folder not found");
  return normalized;
}

function normalizeIdArray(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const raw of ids) {
    const id = normalizeSessionProjectId(raw);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function compareCatalogItems(a, b) {
  return (a.order ?? 0) - (b.order ?? 0)
    || String(a.name || "").localeCompare(String(b.name || ""))
    || String(a.id || "").localeCompare(String(b.id || ""));
}

function reorderScopedItems(items: any[], order: Map<string, any>) {
  const byId = new Map(items.map(item => [item.id, item]));
  const next = [];
  const seen = new Set();
  for (const [id] of order) {
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    seen.add(id);
    next.push({ ...item, order: next.length });
  }
  for (const item of items.sort(compareCatalogItems)) {
    if (seen.has(item.id)) continue;
    next.push({ ...item, order: next.length });
  }
  return next;
}
