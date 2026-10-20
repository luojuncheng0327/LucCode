import fs from "fs";
import path from "path";
import { capabilityDenied, ResourceIOError } from "../errors.ts";
import { resourceKeyForRef } from "../resource-refs.ts";
import type {
  MaterializeResult,
  ResourceDescriptor,
  ResourceMutationResult,
  ResourceReadResult,
  ResourceRef,
  ResourceStat,
  ResourceVersion,
} from "../types.ts";

type Options = {
  resourceService: {
    getResource?: (resourceId: string) => any;
    resolveContent: (resourceId: string) => any;
  };
};

export class ResourceProvider {
  readonly id = "resource" as const;

  declare resourceService: Options["resourceService"];

  constructor({ resourceService }: Options) {
    if (!resourceService) throw new Error("resourceService is required");
    this.resourceService = resourceService;
  }

  capabilities() {
    return {
      stat: true,
      read: true,
      materialize: true,
      writeExpectedVersion: false,
      write: false,
      edit: false,
      list: false,
      search: false,
      watch: false,
      copy: false,
      rename: false,
      move: false,
      trash: false,
      delete: false,
      mkdir: false,
    };
  }

  async stat(ref: ResourceRef): Promise<ResourceStat> {
    const { normalized, content } = this.resolveContent(ref);
    return {
      resourceKey: resourceKeyForRef(normalized),
      resource: descriptorForContent(normalized, content),
      exists: true,
      isDirectory: false,
      version: {
        mtimeMs: content.mtimeMs,
        size: content.size,
        etag: content.etag,
      },
      filePath: content.filePath,
    };
  }

  async read(ref: ResourceRef): Promise<ResourceReadResult> {
    const { normalized, content } = this.resolveContent(ref);
    return {
      resourceKey: resourceKeyForRef(normalized),
      resource: descriptorForContent(normalized, content),
      content: fs.readFileSync(content.filePath),
      version: {
        mtimeMs: content.mtimeMs,
        size: content.size,
        etag: content.etag,
      },
      filePath: content.filePath,
    };
  }

  async materialize(ref: ResourceRef): Promise<MaterializeResult> {
    const { normalized, content } = this.resolveContent(ref);
    return {
      resourceKey: resourceKeyForRef(normalized),
      resource: descriptorForContent(normalized, content),
      filePath: content.filePath,
      version: {
        mtimeMs: content.mtimeMs,
        size: content.size,
        etag: content.etag,
      },
    };
  }

  async write(_ref?: ResourceRef, _content?: string | Buffer): Promise<ResourceMutationResult> { throw capabilityDenied("write", this.id); }
  async writeExpectedVersion(_ref?: ResourceRef, _content?: string | Buffer, _expectedVersion?: ResourceVersion): Promise<never> { throw capabilityDenied("writeExpectedVersion", this.id); }
  async edit(_ref?: ResourceRef, _edits?: unknown[]): Promise<ResourceMutationResult> { throw capabilityDenied("edit", this.id); }
  async list(_ref?: ResourceRef): Promise<never> { throw capabilityDenied("list", this.id); }
  async search(_ref?: ResourceRef): Promise<never> { throw capabilityDenied("search", this.id); }
  async copy(_from?: ResourceRef, _to?: ResourceRef): Promise<never> { throw capabilityDenied("copy", this.id); }
  async rename(_from?: ResourceRef, _to?: ResourceRef): Promise<never> { throw capabilityDenied("rename", this.id); }
  async move(_from?: ResourceRef, _to?: ResourceRef): Promise<never> { throw capabilityDenied("move", this.id); }
  async trash(_ref?: ResourceRef): Promise<never> { throw capabilityDenied("trash", this.id); }
  async delete(_ref?: ResourceRef): Promise<ResourceMutationResult> { throw capabilityDenied("delete", this.id); }
  async mkdir(_ref?: ResourceRef): Promise<ResourceMutationResult> { throw capabilityDenied("mkdir", this.id); }

  resolveContent(ref: ResourceRef) {
    if (ref.kind !== "resource") {
      throw new ResourceIOError(`resource provider cannot resolve ${ref.kind}`, {
        code: "invalid_resource_ref",
        status: 400,
      });
    }
    try {
      return {
        normalized: ref,
        content: this.resourceService.resolveContent(ref.resourceId),
      };
    } catch (err) {
      throw normalizeResourceServiceError(err);
    }
  }
}

function descriptorForContent(ref: Extract<ResourceRef, { kind: "resource" }>, content: any): ResourceDescriptor {
  return {
    kind: "resource",
    resourceId: ref.resourceId,
    provider: "resource",
    filePath: content.filePath,
    displayName: content.filename || path.basename(content.filePath),
  };
}

function normalizeResourceServiceError(err: any): Error {
  if (err?.code) {
    return new ResourceIOError(err.message || "resource error", {
      code: err.code,
      status: err.status || 500,
    });
  }
  return err;
}
