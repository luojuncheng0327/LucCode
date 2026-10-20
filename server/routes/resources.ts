import fs from "fs";
import { Readable } from "stream";
import { Hono } from "hono";
import { ResourceError } from "../../core/resource-service.ts";
import {
  issueResourceTicket,
  verifyResourceTicket,
  ResourceTicketError,
} from "../../core/resource-ticket-service.ts";
import { createRequestContext, jsonError } from "../http/boundary.ts";

export function createResourcesRoute(engine) {
  const route = new Hono();

  route.get("/resources/:resourceId", (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const resource = getResource(engine, c.req.param("resourceId"), requestContext);
      if (!resource) return jsonError(c, { code: "resource_not_found", detail: undefined, status: 404 });
      return c.json(resource);
    } catch (err) {
      return resourceRouteError(c, err);
    }
  });

  route.post("/resources/:resourceId/ticket", (c) => {
    try {
      const resourceId = c.req.param("resourceId");
      const requestContext = createRequestContext(c, engine);
      const content = resolveResourceContent(engine, resourceId, requestContext);
      const studioId = content.resource?.studioId || requestContext.studioId;
      const issued = issueResourceTicket({
        lucHome: engine?.luccodeHome,
        resourceId,
        studioId,
        principalId: requestContext.principalId,
      });
      return c.json({
        ticket: issued.ticket,
        ticketId: issued.ticketId,
        resourceId,
        expiresAt: issued.expiresAt,
        contentUrl: `/api/resources/${encodeURIComponent(resourceId)}/content?ticket=${encodeURIComponent(issued.ticket)}`,
      });
    } catch (err) {
      return resourceRouteError(c, err);
    }
  });

  route.get("/resources/:resourceId/content", (c) => serveResourceContent(c, engine, false));
  route.on("HEAD", "/resources/:resourceId/content", (c) => serveResourceContent(c, engine, true));

  return route;
}

function getResource(engine, resourceId, requestContext) {
  const access = getResourceAccess(engine);
  if (access) return access.getMetadata(resourceId, requestContext);
  const options = { requestContext };
  if (typeof engine?.getResource === "function") return engine.getResource(resourceId, options);
  return engine?.resources?.getResource?.(resourceId, options) || null;
}

function resolveResourceContent(engine, resourceId, requestContext) {
  const access = getResourceAccess(engine);
  if (access) return access.resolveContent(resourceId, requestContext);
  const options = { requestContext };
  if (typeof engine?.resolveResourceContent === "function") {
    return engine.resolveResourceContent(resourceId, options);
  }
  if (typeof engine?.resources?.resolveContent === "function") {
    return engine.resources.resolveContent(resourceId, options);
  }
  throw new ResourceError("resource service unavailable", {
    status: 500,
    code: "resource_service_unavailable",
  });
}

function resolveTrustedResourceContent(engine, resourceId) {
  const options = { requestContext: { authPrincipal: { kind: "resource_ticket" } } };
  if (typeof engine?.resolveResourceContent === "function") {
    return engine.resolveResourceContent(resourceId, options);
  }
  if (typeof engine?.resources?.resolveContent === "function") {
    return engine.resources.resolveContent(resourceId, options);
  }
  const access = getResourceAccess(engine);
  if (typeof access?.resolveTrustedContent === "function") {
    return access.resolveTrustedContent(resourceId, options.requestContext);
  }
  throw new ResourceError("resource service unavailable", {
    status: 500,
    code: "resource_service_unavailable",
  });
}

function getResourceAccess(engine) {
  if (typeof engine?.getResourceAccessService === "function") return engine.getResourceAccessService();
  return engine?.resourceAccess || null;
}

function serveResourceContent(c, engine, headOnly) {
  try {
    const resourceId = c.req.param("resourceId");
    const ticket = c.req.query("ticket");
    const content = ticket
      ? resolveTicketContent(c, engine, resourceId, ticket)
      : resolveResourceContent(engine, resourceId, createRequestContext(c, engine));
    if (c.req.header("if-none-match") && c.req.header("if-none-match") === content.etag) {
      c.header("ETag", content.etag);
      return c.body(null, 304);
    }

    const range = parseRangeHeader(c.req.header("range"), content.size);
    if (range?.unsatisfiable) {
      c.header("Content-Range", `bytes */${content.size}`);
      c.header("Accept-Ranges", "bytes");
      return c.body(null, 416);
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : content.size - 1;
    const length = content.size === 0 ? 0 : end - start + 1;
    const status = range ? 206 : 200;

    c.header("Content-Type", content.mime || "application/octet-stream");
    c.header("Accept-Ranges", "bytes");
    c.header("Content-Length", String(length));
    c.header("Cache-Control", "private, max-age=0, must-revalidate");
    if (content.etag) c.header("ETag", content.etag);
    if (range) c.header("Content-Range", `bytes ${start}-${end}/${content.size}`);
    if (content.filename) c.header("Content-Disposition", contentDisposition(content.filename));
    if (headOnly || content.size === 0) return c.body(null, status);

    const stream = fs.createReadStream(content.filePath, { start, end });
    return c.body(Readable.toWeb(stream), status);
  } catch (err) {
    return resourceRouteError(c, err);
  }
}

function resolveTicketContent(c, engine, resourceId, ticket) {
  verifyResourceTicket({
    lucHome: engine?.luccodeHome,
    ticket,
    resourceId,
  });
  return resolveTrustedResourceContent(engine, resourceId);
}

function parseRangeHeader(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return { unsatisfiable: true };

  let start;
  let end;
  if (match[1] === "" && match[2] === "") return { unsatisfiable: true };
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    start = Math.max(size - suffixLength, 0);
    end = Math.max(size - 1, 0);
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { unsatisfiable: true };
  if (size <= 0 || start >= size || start > end) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

function contentDisposition(filename) {
  const fallback = asciiFilenameFallback(filename);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function asciiFilenameFallback(filename) {
  const source = typeof filename === "string" ? filename : "";
  const dot = source.lastIndexOf(".");
  const ext = dot >= 0 ? source.slice(dot + 1) : "";
  const safeExt = /^[A-Za-z0-9]{1,12}$/.test(ext) ? `.${ext}` : "";
  const stem = source
    .slice(0, dot >= 0 ? dot : source.length)
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\\r\n;/]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return /^[A-Za-z0-9._-]+$/.test(stem)
    ? `${stem}${safeExt}`
    : `download${safeExt}`;
}

function resourceRouteError(c, err) {
  if (err instanceof ResourceTicketError) {
    return jsonError(c, { code: err.code, detail: err.message, status: err.status });
  }
  if (err instanceof ResourceError) {
    return jsonError(c, { code: err.code, detail: err.message, status: err.status });
  }
  return jsonError(c, {
    code: "resource_error",
    detail: err?.message || String(err),
    status: 500,
  });
}
