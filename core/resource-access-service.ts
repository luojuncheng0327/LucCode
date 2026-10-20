import { ResourceError } from "./resource-service.ts";

const PATH_FIELD_NAMES = new Set(["filePath", "realPath"]);
const CONTENT_COMPATIBILITY_CAPABILITIES = ["resources.content", "resources.read"];

export class ResourceAccessService {
  declare _resourceService: any;
  declare _authorizeCapability: any;
  declare _audit: any;

  constructor({ resourceService, authorizeCapability, audit }: any = {}) {
    if (!resourceService) throw new Error("resourceService required");
    this._resourceService = resourceService;
    this._authorizeCapability = authorizeCapability || defaultAuthorizeCapability;
    this._audit = typeof audit === "function" ? audit : null;
  }

  getMetadata(resourceId, requestContext) {
    const resource = this._getResource(resourceId, requestContext);
    if (!resource) return null;
    const decision = this._authorize("resources.read", resourceTarget(resource, resourceId), requestContext);
    if (!decision.allowed) {
      this._auditDecision("resources.metadata", resource, decision, requestContext);
      throw new ResourceError("resource access denied", {
        status: 403,
        code: "resource_forbidden",
      });
    }
    this._auditDecision("resources.metadata", resource, decision, requestContext);
    return this._sanitizeResource(resource, requestContext);
  }

  resolveContent(resourceId, requestContext) {
    const content = this._resolveContent(resourceId, requestContext);
    const resource = content.resource || this._getResource(resourceId, requestContext) || {
      resourceId,
      studioId: requestContext?.studioId || null,
    };
    const decision = this._authorizeAny(CONTENT_COMPATIBILITY_CAPABILITIES, resourceTarget(resource, resourceId), requestContext);
    if (!decision.allowed) {
      this._auditDecision("resources.content", resource, decision, requestContext);
      throw new ResourceError("resource content access denied", {
        status: 403,
        code: "resource_content_forbidden",
      });
    }
    this._auditDecision("resources.content", resource, decision, requestContext);
    return {
      ...content,
      resource: this._sanitizeResource(resource, requestContext),
    };
  }

  resolveTrustedContent(resourceId, requestContext = null) {
    const content = this._resolveContent(resourceId, requestContext);
    return {
      ...content,
      resource: content.resource ? this._sanitizeResource(content.resource, requestContext) : content.resource,
    };
  }

  sanitizeSessionFile(file, requestContext) {
    if (isLocalOwner(requestContext)) return file;
    return removePathFields(file);
  }

  classifyMediaEventPayload(event, requestContext) {
    if (isLocalOwner(requestContext)) {
      return { allowed: true, event };
    }
    if (!event || typeof event !== "object") {
      return { allowed: false, reason: "invalid_event" };
    }
    if (event.thumbnail && typeof event.thumbnail === "string") {
      return { allowed: false, reason: "remote_base64_media_event" };
    }
    return { allowed: true, event: removePathFields(event) };
  }

  _getResource(resourceId, requestContext) {
    if (typeof this._resourceService.getResource === "function") {
      return this._resourceService.getResource(resourceId, { requestContext });
    }
    throw new ResourceError("resource service unavailable", {
      status: 500,
      code: "resource_service_unavailable",
    });
  }

  _resolveContent(resourceId, requestContext) {
    if (typeof this._resourceService.resolveContent === "function") {
      return this._resourceService.resolveContent(resourceId, { requestContext });
    }
    if (typeof this._resourceService.resolveResourceContent === "function") {
      return this._resourceService.resolveResourceContent(resourceId, { requestContext });
    }
    throw new ResourceError("resource service unavailable", {
      status: 500,
      code: "resource_service_unavailable",
    });
  }

  _authorize(capability, target, requestContext) {
    return this._authorizeCapability({
      principal: requestContext?.authPrincipal,
      capability,
      target,
      requestContext,
    });
  }

  _authorizeAny(capabilities, target, requestContext) {
    let lastDecision = null;
    for (const capability of capabilities) {
      const decision = this._authorize(capability, target, requestContext);
      if (decision.allowed) return decision;
      lastDecision = decision;
    }
    return lastDecision || {
      allowed: false,
      reason: "missing_capability",
      capability: capabilities[0],
      target,
    };
  }

  _sanitizeResource(resource, requestContext) {
    if (isLocalOwner(requestContext)) return resource;
    return removePathFields(resource);
  }

  _auditDecision(action, resource, decision, requestContext) {
    if (!this._audit) return;
    this._audit({
      action,
      target: resourceTarget(resource, resource?.resourceId),
      result: decision.allowed ? "success" : "denied",
      actor: requestContext?.authPrincipal || null,
      decision,
    });
  }
}

function defaultAuthorizeCapability({ requestContext, capability, target }) {
  if (typeof requestContext?.authorize === "function") {
    return requestContext.authorize(capability, target);
  }
  if (isLocalOwner(requestContext)) {
    return {
      allowed: true,
      reason: "local_owner",
      capability,
      target,
      principalId: requestContext?.authPrincipal?.principalId || null,
    };
  }
  return {
    allowed: false,
    reason: "missing_policy",
    capability,
    target,
    principalId: requestContext?.authPrincipal?.principalId || null,
  };
}

function resourceTarget(resource, resourceId) {
  return {
    kind: "resource",
    studioId: resource?.studioId || null,
    resourceId: resource?.resourceId || resourceId || null,
  };
}

function removePathFields(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(removePathFields);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PATH_FIELD_NAMES.has(key)) continue;
    out[key] = removePathFields(entry);
  }
  return out;
}

function isLocalOwner(requestContext) {
  const principal = requestContext?.authPrincipal;
  return principal?.kind === "local_user"
    && principal?.connectionKind === "local"
    && principal?.credentialKind === "loopback_token";
}
