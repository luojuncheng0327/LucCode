import { Hono } from "hono";

export function createSessionProjectsRoute(engine) {
  const route = new Hono();

  route.get("/session-projects", (c) => {
    try {
      return c.json({ catalog: engine.getSessionProjectCatalog() });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/session-projects/projects", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const project = engine.createSessionProject({
        name: body?.name,
        folderId: body?.folderId ?? null,
      });
      return c.json({ ok: true, project });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/session-projects/folders", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const folder = engine.createSessionProjectFolder({ name: body?.name });
      return c.json({ ok: true, folder });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.patch("/session-projects/folders/:id", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const folder = engine.updateSessionProjectFolder(c.req.param("id"), body);
      return c.json({ ok: true, folder });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.delete("/session-projects/folders/:id", (c) => {
    try {
      const catalog = engine.deleteSessionProjectFolder(c.req.param("id"));
      return c.json({ ok: true, catalog });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/session-projects/folders/reorder", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const catalog = engine.reorderSessionProjectFolders({ folderIds: body?.folderIds });
      return c.json({ ok: true, catalog });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.patch("/session-projects/projects/:id", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const project = engine.updateSessionProject(c.req.param("id"), body);
      return c.json({ ok: true, project });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.delete("/session-projects/projects/:id", async (c) => {
    try {
      const result = await engine.deleteSessionProject(c.req.param("id"));
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/session-projects/projects/reorder", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const catalog = engine.reorderSessionProjects({
        folderId: body?.folderId ?? null,
        projectIds: body?.projectIds,
      });
      return c.json({ ok: true, catalog });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/session-projects/session-assignment", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const assignment = await engine.setSessionProjectAssignment({
        sessionPath: body?.sessionPath,
        projectId: body?.projectId ?? null,
      });
      return c.json({ ok: true, assignment });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return route;
}
