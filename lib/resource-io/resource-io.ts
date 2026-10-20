import type { ResourceEventBus } from "./resource-event-bus.ts";
import { capabilityDenied, crossProviderCopyUnsupported, crossProviderMoveUnsupported, providerNotAvailable } from "./errors.ts";
import { normalizeResourceRef, providerIdForResourceRef } from "./resource-refs.ts";
import type {
  MaterializeResult,
  ResourceAuditSink,
  ResourceDescriptor,
  ResourceDeletedEvent,
  ResourceEdit,
  ResourceEventSource,
  ResourceListResult,
  ResourceMutationResult,
  ResourceMoveResult,
  ResourceOperationContext,
  ResourceProvider,
  ResourceProviderCapability,
  ResourceProviderId,
  ResourceReadResult,
  ResourceRef,
  ResourceSearchResult,
  ResourceStat,
  ResourceTrashOptions,
  ResourceTrashResult,
  ResourceVersion,
  ResourceWriteConflictResult,
  ResourceWriteExpectedVersionResult,
} from "./types.ts";

type ResourceIOOptions = {
  providers: Record<string, ResourceProvider>;
  eventBus?: ResourceEventBus | null;
  audit?: ResourceAuditSink | null;
  getSessionPath?: () => string | null;
};

type AuditResourceResult = {
  resourceKey: string;
  resource: ResourceDescriptor;
};

export class ResourceIO {
  declare providers: Record<string, ResourceProvider>;
  declare eventBus: ResourceEventBus | null;
  declare audit: ResourceAuditSink | null;
  declare getSessionPath: () => string | null;

  constructor({ providers, eventBus = null, audit = null, getSessionPath = () => null }: ResourceIOOptions) {
    this.providers = providers || {};
    this.eventBus = eventBus;
    this.audit = audit;
    this.getSessionPath = getSessionPath;
  }

  async stat(input: unknown, options: ResourceOperationContext = {}): Promise<ResourceStat> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceStat>(ref, "stat", options, ref);
    if (options.auditRead) this.auditAllowed("stat", result, options);
    return result;
  }

  async read(input: unknown, options: ResourceOperationContext = {}): Promise<ResourceReadResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceReadResult>(ref, "read", options, ref);
    if (options.auditRead) this.auditAllowed("read", result, options);
    return result;
  }

  async write(input: unknown, content: string | Buffer, options: ResourceOperationContext = {}): Promise<ResourceMutationResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceMutationResult>(ref, "write", options, ref, content);
    this.auditAllowed("write", result, options);
    this.emitChanged(result, options);
    return result;
  }

  async writeExpectedVersion(input: unknown, content: string | Buffer, expectedVersion: ResourceVersion, options: ResourceOperationContext = {}): Promise<ResourceWriteExpectedVersionResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceWriteExpectedVersionResult>(ref, "writeExpectedVersion", options, ref, content, expectedVersion);
    if (isWriteConflict(result)) {
      this.auditConflict("writeExpectedVersion", result, options);
    } else {
      this.auditAllowed("writeExpectedVersion", result, options);
      this.emitChanged(result, options);
    }
    return result;
  }

  async edit(input: unknown, edits: ResourceEdit[], options: ResourceOperationContext = {}): Promise<ResourceMutationResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceMutationResult>(ref, "edit", options, ref, edits);
    this.auditAllowed("edit", result, options);
    this.emitChanged(result, options);
    return result;
  }

  async mkdir(input: unknown, options: ResourceOperationContext = {}): Promise<ResourceMutationResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceMutationResult>(ref, "mkdir", options, ref);
    this.auditAllowed("mkdir", result, options);
    this.emitChanged(result, options);
    return result;
  }

  async delete(input: unknown, options: ResourceOperationContext = {}): Promise<ResourceMutationResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceMutationResult>(ref, "delete", options, ref);
    this.auditAllowed("delete", result, options);
    if (options.emit !== false && this.eventBus) {
      this.eventBus.deleted({
        resourceKey: result.resourceKey,
        resource: result.resource,
        source: options.source || "api",
        sessionPath: options.sessionPath ?? this.getSessionPath?.() ?? null,
      } satisfies Omit<ResourceDeletedEvent, "type" | "sequence" | "occurredAt">);
    }
    return result;
  }

  async list(input: unknown, options: ResourceOperationContext = {}): Promise<ResourceListResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceListResult>(ref, "list", options, ref);
    if (options.auditRead) this.auditAllowed("list", result, options);
    return result;
  }

  async search(input: unknown, options: Record<string, unknown> = {}, context: ResourceOperationContext = {}): Promise<ResourceSearchResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceSearchResult>(ref, "search", context, ref, options);
    if (context.auditRead) this.auditAllowed("search", result, context);
    return result;
  }

  async materialize(input: unknown, options: ResourceOperationContext = {}): Promise<MaterializeResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<MaterializeResult>(ref, "materialize", options, ref);
    if (options.auditRead) this.auditAllowed("materialize", result, options);
    return result;
  }

  resolveWatchTarget(input: unknown, options: ResourceOperationContext = {}) {
    const ref = normalizeResourceRef(input);
    const provider = this.providerFor(ref);
    const capabilities = provider.capabilities?.(ref) || {};
    if (capabilities.watch === false || typeof provider.watchTarget !== "function") {
      const err = capabilityDenied("watch", providerIdForResourceRef(ref));
      this.auditDenied("watch", providerIdForResourceRef(ref), options, err);
      throw err;
    }
    return provider.watchTarget(ref);
  }

  async copy(from: unknown, to: unknown, options: ResourceOperationContext = {}): Promise<ResourceMutationResult> {
    const fromRef = normalizeResourceRef(from);
    const toRef = normalizeResourceRef(to);
    if (fromRef.kind !== toRef.kind) {
      throw crossProviderCopyUnsupported(providerIdForResourceRef(fromRef), providerIdForResourceRef(toRef));
    }
    const result = await this.callProvider<ResourceMutationResult>(toRef, "copy", options, fromRef, toRef);
    this.auditAllowed("copy", result, options);
    this.emitChanged(result, options);
    return result;
  }

  async rename(from: unknown, to: unknown, options: ResourceOperationContext = {}): Promise<ResourceMoveResult> {
    return this.moveLike("rename", from, to, options);
  }

  async move(from: unknown, to: unknown, options: ResourceOperationContext = {}): Promise<ResourceMoveResult> {
    return this.moveLike("move", from, to, options);
  }

  async trash(input: unknown, trashOptions: ResourceTrashOptions = {}, options: ResourceOperationContext = {}): Promise<ResourceTrashResult> {
    const ref = normalizeResourceRef(input);
    const result = await this.callProvider<ResourceTrashResult>(ref, "trash", options, ref, trashOptions);
    this.auditAllowed("trash", result, options);
    this.emitDeletedResult(result, options);
    return result;
  }

  async moveLike(capability: "rename" | "move", from: unknown, to: unknown, options: ResourceOperationContext = {}): Promise<ResourceMoveResult> {
    const fromRef = normalizeResourceRef(from);
    const toRef = normalizeResourceRef(to);
    if (providerIdForResourceRef(fromRef) !== providerIdForResourceRef(toRef)) {
      throw crossProviderMoveUnsupported(providerIdForResourceRef(fromRef), providerIdForResourceRef(toRef));
    }
    const result = await this.callProvider<ResourceMoveResult>(toRef, capability, options, fromRef, toRef);
    this.auditAllowed(capability, {
      resourceKey: result.newResourceKey,
      resource: result.newResource,
    }, options);
    this.emitRenamed(result, options);
    return result;
  }

  providerFor(ref: ResourceRef): ResourceProvider {
    const id = providerIdForResourceRef(ref);
    const provider = this.providers[id];
    if (!provider) throw providerNotAvailable(id);
    return provider;
  }

  async callProvider<T>(ref: ResourceRef, capability: ResourceProviderCapability, context: ResourceOperationContext, ...args: unknown[]): Promise<T> {
    const providerId = providerIdForResourceRef(ref);
    const provider = this.providers[providerId];
    if (!provider) {
      const err = providerNotAvailable(providerId);
      this.auditDenied(capability, providerId, context, err);
      throw err;
    }
    const capabilities = provider.capabilities?.(ref) || {};
    if (capabilities[capability] === false || typeof provider[capability] !== "function") {
      const err = capabilityDenied(String(capability), providerId);
      this.auditDenied(capability, providerId, context, err);
      throw err;
    }
    try {
      return await (provider[capability] as (...args: unknown[]) => Promise<T>)(...args);
    } catch (err) {
      if (isDeniedProviderError(err)) {
        this.auditDenied(capability, providerId, context, err);
      }
      throw err;
    }
  }

  emitChanged(result: ResourceMutationResult, options: ResourceOperationContext): void {
    if (options.emit === false || !this.eventBus) return;
    this.eventBus.changed({
      changeType: result.changeType,
      resourceKey: result.resourceKey,
      resource: result.resource,
      ...(result.version ? { version: result.version } : {}),
      source: options.source || "api",
      reason: options.reason,
      sessionPath: options.sessionPath ?? this.getSessionPath?.() ?? null,
    });
  }

  emitDeletedResult(result: ResourceTrashResult | ResourceMutationResult, options: ResourceOperationContext): void {
    if (options.emit === false || !this.eventBus) return;
    this.eventBus.deleted({
      resourceKey: result.resourceKey,
      resource: result.resource,
      source: options.source || "api",
      reason: options.reason,
      sessionPath: options.sessionPath ?? this.getSessionPath?.() ?? null,
    } as any);
  }

  emitRenamed(result: ResourceMoveResult, options: ResourceOperationContext): void {
    if (options.emit === false || !this.eventBus) return;
    this.eventBus.renamed({
      oldResourceKey: result.oldResourceKey,
      newResourceKey: result.newResourceKey,
      oldResource: result.oldResource,
      newResource: result.newResource,
      source: options.source || "api",
      reason: options.reason,
      sessionPath: options.sessionPath ?? this.getSessionPath?.() ?? null,
    } as any);
  }

  auditAllowed(operation: ResourceProviderCapability, result: AuditResourceResult, context: ResourceOperationContext): void {
    this.recordAudit({
      outcome: "allowed",
      operation,
      providerId: providerIdForResourceRef(result.resource),
      resourceKey: result.resourceKey,
      resource: result.resource,
      ...auditContext(context, this.getSessionPath),
    });
  }

  auditConflict(operation: ResourceProviderCapability, result: ResourceWriteConflictResult, context: ResourceOperationContext): void {
    this.recordAudit({
      outcome: "conflict",
      operation,
      providerId: providerIdForResourceRef(result.resource),
      resourceKey: result.resourceKey,
      resource: result.resource,
      safeMessage: "Resource write conflict",
      ...auditContext(context, this.getSessionPath),
    });
  }

  auditDenied(operation: ResourceProviderCapability, providerId: ResourceProviderId, context: ResourceOperationContext, err: unknown): void {
    this.recordAudit({
      outcome: "denied",
      operation,
      providerId,
      code: errorCode(err),
      safeMessage: safeDeniedMessage(operation, providerId, err),
      ...auditContext(context, this.getSessionPath),
    });
  }

  recordAudit(event: Parameters<ResourceAuditSink["record"]>[0]): void {
    if (!this.audit || typeof this.audit.record !== "function") return;
    this.audit.record(event);
  }
}

function isWriteConflict(result: ResourceWriteExpectedVersionResult): result is ResourceWriteConflictResult {
  return Boolean((result as any)?.ok === false && (result as any)?.conflict === true);
}

function auditContext(context: ResourceOperationContext, getSessionPath: () => string | null) {
  return {
    ...(context.reason ? { reason: context.reason } : {}),
    ...(context.principal ? { principal: context.principal } : {}),
    sessionId: context.sessionId ?? context.principal?.sessionId ?? null,
    sessionPath: context.sessionPath ?? context.principal?.sessionPath ?? getSessionPath?.() ?? null,
    requestId: context.requestId ?? context.principal?.requestId ?? null,
  };
}

function errorCode(err: unknown): string | undefined {
  return typeof (err as any)?.code === "string" ? (err as any).code : undefined;
}

function isDeniedProviderError(err: unknown): boolean {
  const code = errorCode(err);
  return code === "resource_access_denied" || code === "capability_denied";
}

function safeDeniedMessage(operation: ResourceProviderCapability, providerId: ResourceProviderId, err: unknown): string {
  if (typeof (err as any)?.safeMessage === "string" && (err as any).safeMessage) {
    return (err as any).safeMessage;
  }
  return `ResourceIO ${operation} denied by provider ${providerId}`;
}
