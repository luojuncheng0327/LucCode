/**
 * Tool-owned invocation permission descriptors.
 *
 * The tool resolves its own action semantics. This host boundary only accepts a
 * small, deterministic descriptor shape and binds the declared capability to
 * the tool that will actually execute it. Actor, server, and session identity
 * remain host-owned and must never be supplied by a tool resolver.
 */

export type ToolInvocationKind = "read" | "routine" | "review";

export type ToolInvocationTargetType =
  | "url"
  | "browser_tab"
  | "background_task"
  | "channel"
  | "channel_draft"
  | "agent"
  | "notification_route"
  | "setting"
  | "memory_store"
  | "pinned_memory_item"
  | "pinned_memory_query"
  | "experience_category"
  | "session_files"
  | "terminal_process";

export interface ToolInvocationTarget {
  type: ToolInvocationTargetType;
  id: string;
  label?: string;
}

export interface NormalizedToolInvocationDescriptor {
  action: string;
  kind: ToolInvocationKind;
  capability: string;
  target?: ToolInvocationTarget;
  sideEffect?: Record<string, unknown>;
}

export type ToolInvocationPermissionResolution =
  | {
    ok: true;
    source: "descriptor";
    descriptor: NormalizedToolInvocationDescriptor;
    targetKey: string | null;
  }
  | {
    ok: true;
    source: "legacy";
    descriptor: null;
    targetKey: null;
    sessionPermission: Record<string, unknown> | null;
  }
  | {
    ok: false;
    source: "resolver";
    error: {
      code: "TOOL_INVOCATION_RESOLVER_FAILED" | "TOOL_INVOCATION_DESCRIPTOR_INVALID";
      reason: string;
      toolName: string;
      message: string;
      field?: string;
    };
  };

const DESCRIPTOR_FIELDS = new Set([
  "action",
  "kind",
  "capability",
  "target",
  "sideEffect",
]);

const TARGET_FIELDS = new Set(["type", "id", "label"]);

const TARGET_TYPES = new Set<ToolInvocationTargetType>([
  "url",
  "browser_tab",
  "background_task",
  "channel",
  "channel_draft",
  "agent",
  "notification_route",
  "setting",
  "memory_store",
  "pinned_memory_item",
  "pinned_memory_query",
  "experience_category",
  "session_files",
  "terminal_process",
]);

const ACTION_RE = /^[a-z][a-z0-9_]*$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const MAX_TARGET_ID_LENGTH = 4096;
const MAX_LABEL_LENGTH = 512;
const MAX_SIDE_EFFECT_DEPTH = 6;
const MAX_SIDE_EFFECT_ITEMS = 256;
const MAX_SIDE_EFFECT_STRING_LENGTH = 8192;
const MAX_INPUT_DEPTH = 16;
const MAX_INPUT_ITEMS = 4096;
const MAX_INPUT_STRING_LENGTH = 2 * 1024 * 1024;

export type ToolInvocationInputSnapshot =
  | { ok: true; value: any }
  | { ok: false; reason: "invalid_input" | "input_too_large" };

type InputCloneState = {
  count: number;
  seen: WeakSet<object>;
  freeze: boolean;
};

function cloneToolInputValue(
  value: unknown,
  depth: number,
  state: InputCloneState,
): ToolInvocationInputSnapshot {
  state.count += 1;
  if (depth > MAX_INPUT_DEPTH || state.count > MAX_INPUT_ITEMS) {
    return { ok: false, reason: "input_too_large" };
  }
  if (value === null || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false, reason: "invalid_input" };
  }
  if (typeof value === "string") {
    return value.length <= MAX_INPUT_STRING_LENGTH
      ? { ok: true, value }
      : { ok: false, reason: "input_too_large" };
  }
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "invalid_input" };
  }

  let prototype: object | null;
  let symbols: symbol[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return { ok: false, reason: "invalid_input" };
  }
  if (symbols.length > 0 || state.seen.has(value)) {
    return { ok: false, reason: "invalid_input" };
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return { ok: false, reason: "invalid_input" };
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)) {
        return { ok: false, reason: "invalid_input" };
      }
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_INPUT_ITEMS) {
        return { ok: false, reason: "input_too_large" };
      }
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (keys.length !== length || keys.some((key) => !/^(0|[1-9]\d*)$/.test(key))) {
        return { ok: false, reason: "invalid_input" };
      }
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) {
          return { ok: false, reason: "invalid_input" };
        }
        const cloned = cloneToolInputValue(descriptor.value, depth + 1, state);
        if (!cloned.ok) return cloned;
        output.push(cloned.value);
      }
      return { ok: true, value: state.freeze ? Object.freeze(output) : output };
    }

    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, reason: "invalid_input" };
    }
    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        !key
        || key === "__proto__"
        || key === "prototype"
        || key === "constructor"
        || !("value" in descriptor)
      ) {
        return { ok: false, reason: "invalid_input" };
      }
      const cloned = cloneToolInputValue(descriptor.value, depth + 1, state);
      if (!cloned.ok) return cloned;
      output[key] = cloned.value;
    }
    return { ok: true, value: state.freeze ? Object.freeze(output) : output };
  } finally {
    state.seen.delete(value);
  }
}

/**
 * Copy tool parameters without evaluating accessors or accepting executable,
 * inherited, cyclic, or otherwise non-JSON input. The permission resolver and
 * reviewer both consume this frozen snapshot instead of the caller's object.
 */
export function snapshotToolInvocationInput(value: unknown): ToolInvocationInputSnapshot {
  return cloneToolInputValue(value, 0, {
    count: 0,
    seen: new WeakSet(),
    freeze: true,
  });
}

/** Create a fresh mutable execution copy from an already validated snapshot. */
export function cloneToolInvocationInput(value: unknown): ToolInvocationInputSnapshot {
  return cloneToolInputValue(value, 0, {
    count: 0,
    seen: new WeakSet(),
    freeze: false,
  });
}

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

type OwnDataPropertyRead =
  | { ok: true; present: false }
  | { ok: true; present: true; value: unknown }
  | { ok: false };

/** Read an own data property without invoking accessors or accepting inheritance. */
function readOwnDataProperty(value: unknown, key: string): OwnDataPropertyRead {
  if (!isObjectLike(value)) return { ok: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      return key in value ? { ok: false } : { ok: true, present: false };
    }
    if (!("value" in descriptor)) return { ok: false };
    return { ok: true, present: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

type OwnDataRecordRead =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false };

/** Snapshot a plain record without evaluating any accessor properties. */
function snapshotPlainOwnDataRecord(value: unknown): OwnDataRecordRead {
  if (!isPlainRecord(value)) return { ok: false };
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return { ok: false };
      output[key] = descriptor.value;
    }
    return { ok: true, value: output };
  } catch {
    return { ok: false };
  }
}

function hasOnlyKnownFields(value: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeStableString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  if (!value || value !== value.trim() || value.length > maxLength) return null;
  if (hasControlCharacters(value)) return null;
  return value;
}

function hasControlCharacters(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// sideEffect string values are command/output text, not identity tokens: \t \n \r
// are bounded whitespace that legitimately appears in multiline command payloads.
// Every other C0 control character (including 0x1B ESC, used for ANSI/terminal
// injection) and 0x7F stay rejected. normalizeStableString (action/capability/
// target ids) must not be relaxed the same way, so it keeps hasControlCharacters.
function hasDisallowedSideEffectControlCharacters(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function containsWildcard(value: string) {
  return value.includes("*") || value.includes("?");
}

function normalizedIdentityKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isHostIdentityKey(key: string) {
  const normalized = normalizedIdentityKey(key);
  return normalized.includes("actor")
    || normalized.includes("server")
    || normalized.includes("session");
}

type SideEffectNormalization =
  | { ok: true; value: unknown; count: number }
  | { ok: false; reason: "host_identity_forbidden" | "invalid_side_effect"; field?: string };

function normalizeSideEffectValue(value: unknown, depth: number, count: number): SideEffectNormalization {
  if (count > MAX_SIDE_EFFECT_ITEMS || depth > MAX_SIDE_EFFECT_DEPTH) {
    return { ok: false, reason: "invalid_side_effect" };
  }
  if (value === null || typeof value === "boolean") {
    return { ok: true, value, count: count + 1 };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { ok: true, value, count: count + 1 }
      : { ok: false, reason: "invalid_side_effect" };
  }
  if (typeof value === "string") {
    return value.length <= MAX_SIDE_EFFECT_STRING_LENGTH && !hasDisallowedSideEffectControlCharacters(value)
      ? { ok: true, value, count: count + 1 }
      : { ok: false, reason: "invalid_side_effect" };
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SIDE_EFFECT_ITEMS) return { ok: false, reason: "invalid_side_effect" };
    const output: unknown[] = [];
    let nextCount = count + 1;
    for (const item of value) {
      const normalized = normalizeSideEffectValue(item, depth + 1, nextCount);
      if (!normalized.ok) return normalized;
      output.push(normalized.value);
      nextCount = normalized.count;
    }
    return { ok: true, value: output, count: nextCount };
  }
  const record = snapshotPlainOwnDataRecord(value);
  if (!record.ok) return { ok: false, reason: "invalid_side_effect" };

  const output: Record<string, unknown> = {};
  let nextCount = count + 1;
  for (const [key, item] of Object.entries(record.value)) {
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
      return { ok: false, reason: "invalid_side_effect", field: "sideEffect" };
    }
    if (isHostIdentityKey(key)) {
      return { ok: false, reason: "host_identity_forbidden", field: "sideEffect" };
    }
    const normalized = normalizeSideEffectValue(item, depth + 1, nextCount);
    if (!normalized.ok) return normalized;
    output[key] = normalized.value;
    nextCount = normalized.count;
  }
  return { ok: true, value: output, count: nextCount };
}

/**
 * Host-held capability delegation.
 *
 * By default a tool may only declare a capability inside its own namespace:
 * `<its own local name>.<action>`. That rule is what stops one tool from
 * claiming another's session-level grant, since the capability string is the
 * entire key a grant is stored under.
 *
 * A bridge tool legitimately needs to break that rule: `mcp_call` resolves a
 * real target at call time and must produce the target's capability, so that a
 * grant issued for a tool means the same thing whether the model reached it
 * directly or through the bridge.
 *
 * The trust anchor is object identity, not anything the tool says about
 * itself. Only code holding the actual tool object can register it, the
 * registry lives here rather than on the tool, and a structural copy of a
 * registered tool is not registered. A tool that declares a delegation field on
 * itself gains nothing.
 */
const capabilityDelegates = new WeakMap<object, (capability: string, action: string) => boolean>();

export function registerToolCapabilityDelegate(
  tool: object,
  predicate: (capability: string, action: string) => boolean,
): void {
  if (!tool || (typeof tool !== "object" && typeof tool !== "function")) {
    throw new TypeError("registerToolCapabilityDelegate requires a tool object");
  }
  if (typeof predicate !== "function") {
    throw new TypeError("registerToolCapabilityDelegate requires a predicate function");
  }
  capabilityDelegates.set(tool, predicate);
}

export function unregisterToolCapabilityDelegate(tool: object): boolean {
  if (!tool || (typeof tool !== "object" && typeof tool !== "function")) return false;
  return capabilityDelegates.delete(tool);
}

/**
 * A delegated capability is accepted only when the host registered this exact
 * object and its predicate returns literally true. A throwing or non-boolean
 * predicate fails closed, matching the rest of this module.
 */
function capabilityIsDelegated(
  tool: Record<string, unknown>,
  capability: string,
  action: string,
): boolean {
  const predicate = capabilityDelegates.get(tool as object);
  if (typeof predicate !== "function") return false;
  try {
    return predicate(capability, action) === true;
  } catch {
    return false;
  }
}

function invocationToolName(tool: Record<string, unknown>) {
  const nameProperty = readOwnDataProperty(tool, "name");
  if (!nameProperty.ok || !nameProperty.present) return null;
  const rawName = normalizeStableString(nameProperty.value, 160);
  if (!rawName) return null;
  const pluginProperty = readOwnDataProperty(tool, "_pluginId");
  if (!pluginProperty.ok) return null;
  const pluginId = pluginProperty.present
    ? normalizeStableString(pluginProperty.value, 120)
    : null;
  if (pluginProperty.present && !pluginId) return null;
  const prefix = pluginId ? `${pluginId}_` : "";
  const localName = prefix && rawName.startsWith(prefix)
    ? rawName.slice(prefix.length)
    : rawName;
  return TOOL_NAME_RE.test(localName) ? localName : null;
}

function failure({
  toolName,
  code = "TOOL_INVOCATION_DESCRIPTOR_INVALID",
  reason,
  message,
  field,
}: {
  toolName: string;
  code?: "TOOL_INVOCATION_RESOLVER_FAILED" | "TOOL_INVOCATION_DESCRIPTOR_INVALID";
  reason: string;
  message: string;
  field?: string;
}): ToolInvocationPermissionResolution {
  return {
    ok: false,
    source: "resolver",
    error: {
      code,
      reason,
      toolName,
      message,
      ...(field ? { field } : {}),
    },
  };
}

function normalizeTarget(raw: unknown): { ok: true; target: ToolInvocationTarget } | { ok: false; field?: string } {
  const record = snapshotPlainOwnDataRecord(raw);
  if (!record.ok || !hasOnlyKnownFields(record.value, TARGET_FIELDS)) {
    return { ok: false };
  }
  const type = normalizeStableString(record.value.type, 64);
  const id = normalizeStableString(record.value.id, MAX_TARGET_ID_LENGTH);
  if (!type || !TARGET_TYPES.has(type as ToolInvocationTargetType)) {
    return { ok: false, field: "target.type" };
  }
  if (!id || (type !== "url" && containsWildcard(id))) {
    return { ok: false, field: "target.id" };
  }

  let label: string | undefined;
  if (record.value.label !== undefined) {
    label = normalizeStableString(record.value.label, MAX_LABEL_LENGTH) || undefined;
    if (!label) return { ok: false, field: "target.label" };
  }
  return {
    ok: true,
    target: {
      type: type as ToolInvocationTargetType,
      id,
      ...(label ? { label } : {}),
    },
  };
}

function normalizeDescriptor(
  tool: Record<string, unknown>,
  raw: unknown,
): ToolInvocationPermissionResolution {
  const toolName = invocationToolName(tool) || "unknown";
  const record = snapshotPlainOwnDataRecord(raw);
  if (!record.ok) {
    return failure({
      toolName,
      reason: "invalid_descriptor",
      message: "Tool invocation resolver must return a plain synchronous descriptor with only known fields.",
    });
  }
  const descriptorInput = record.value;

  for (const key of Object.keys(descriptorInput)) {
    if (isHostIdentityKey(key)) {
      return failure({
        toolName,
        reason: "host_identity_forbidden",
        field: "descriptor",
        message: "Actor, server, and session identity are derived by the host and cannot be tool-declared.",
      });
    }
  }
  if (!hasOnlyKnownFields(descriptorInput, DESCRIPTOR_FIELDS)) {
    return failure({
      toolName,
      reason: "invalid_descriptor",
      message: "Tool invocation resolver must return a plain synchronous descriptor with only known fields.",
    });
  }

  const action = normalizeStableString(descriptorInput.action, 80);
  if (!action || !ACTION_RE.test(action)) {
    return failure({
      toolName,
      reason: "invalid_action",
      field: "action",
      message: "Invocation action must be a stable lowercase action id.",
    });
  }
  if (
    descriptorInput.kind !== "read"
    && descriptorInput.kind !== "routine"
    && descriptorInput.kind !== "review"
  ) {
    return failure({
      toolName,
      reason: "unknown_kind",
      field: "kind",
      message: "Invocation kind must be read, routine, or review.",
    });
  }

  const capabilityToolName = invocationToolName(tool);
  const capability = normalizeStableString(descriptorInput.capability, 256);
  const expectedCapability = capabilityToolName ? `${capabilityToolName}.${action}` : null;
  // A capability outside the tool's own namespace is refused unless the host
  // registered this exact object as a delegate and its predicate accepts. An
  // empty or malformed capability is refused either way.
  if (
    !capability
    || ((!expectedCapability || capability !== expectedCapability)
      && !capabilityIsDelegated(tool, capability, action))
  ) {
    return failure({
      toolName,
      reason: "unknown_capability",
      field: "capability",
      message: expectedCapability
        ? `Invocation capability must be ${expectedCapability}.`
        : "The executing tool has no stable capability namespace.",
    });
  }

  let target: ToolInvocationTarget | undefined;
  if (descriptorInput.target !== undefined) {
    const normalized = normalizeTarget(descriptorInput.target);
    if (normalized.ok === false) {
      return failure({
        toolName,
        reason: "invalid_target",
        field: normalized.field,
        message: "Invocation target must have an allowed type and an exact wildcard-free id.",
      });
    }
    target = normalized.target;
  }
  let sideEffect: Record<string, unknown> | undefined;
  if (descriptorInput.sideEffect !== undefined) {
    if (!isPlainRecord(descriptorInput.sideEffect)) {
      return failure({
        toolName,
        reason: "invalid_side_effect",
        field: "sideEffect",
        message: "Invocation sideEffect must be a bounded plain JSON object.",
      });
    }
    const normalized = normalizeSideEffectValue(descriptorInput.sideEffect, 0, 0);
    if (normalized.ok === false) {
      return failure({
        toolName,
        reason: normalized.reason,
        field: normalized.field,
        message: normalized.reason === "invalid_side_effect"
          ? "Invocation sideEffect must be a bounded plain JSON object."
          : "Actor, server, and session identity are derived by the host and cannot be tool-declared.",
      });
    }
    if (!isPlainRecord(normalized.value)) {
      return failure({
        toolName,
        reason: "invalid_side_effect",
        field: "sideEffect",
        message: "Invocation sideEffect must be a bounded plain JSON object.",
      });
    }
    sideEffect = normalized.value;
  }

  const descriptor: NormalizedToolInvocationDescriptor = {
    action,
    kind: descriptorInput.kind,
    capability,
    ...(target ? { target } : {}),
    ...(sideEffect ? { sideEffect } : {}),
  };
  return {
    ok: true,
    source: "descriptor",
    descriptor,
    targetKey: target ? invocationTargetKey(target) : null,
  };
}

/** Stable reviewer target identity. Labels are intentionally display-only. */
export function invocationTargetKey(target: Pick<ToolInvocationTarget, "type" | "id">) {
  return JSON.stringify([target.type, target.id]);
}

type LegacyPermissionNormalization =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false };

function normalizeLegacyPermission(permission: unknown): LegacyPermissionNormalization {
  const snapshot = snapshotPlainOwnDataRecord(permission);
  if (!snapshot.ok) return { ok: false };
  const raw = snapshot.value;
  const output: Record<string, unknown> = Object.create(null);

  if (raw.readOnly !== undefined) {
    if (typeof raw.readOnly !== "boolean") return { ok: false };
    output.readOnly = raw.readOnly;
  }
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== "string") return { ok: false };
    output.kind = raw.kind;
  }
  if (raw.auto !== undefined) {
    if (raw.auto !== "allow" && raw.auto !== "review") return { ok: false };
    output.auto = raw.auto;
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") return { ok: false };
    output.description = raw.description;
  }
  if (raw.sideEffect !== undefined) {
    const sideEffect = normalizeSideEffectValue(raw.sideEffect, 0, 0);
    if (!sideEffect.ok || !isPlainRecord(sideEffect.value)) return { ok: false };
    output.sideEffect = sideEffect.value;
  }
  if (raw.describeSideEffect !== undefined) {
    if (typeof raw.describeSideEffect !== "function") return { ok: false };
    output.describeSideEffect = raw.describeSideEffect;
  }
  return { ok: true, value: output };
}

type ThenableInspection = "not_thenable" | "thenable" | "invalid";

function consumeResolverThenable(value: unknown): ThenableInspection {
  if (!isObjectLike(value)) return "not_thenable";
  let then: unknown;
  try {
    then = Reflect.get(value, "then");
  } catch {
    return "invalid";
  }
  if (typeof then !== "function") return "not_thenable";
  try {
    void Promise.resolve(value).catch(() => {});
  } catch {
    // Some hostile thenables can throw during assimilation. No details cross
    // the permission boundary, and a fixed failure is returned below.
  }
  return "thenable";
}

/**
 * Resolve and strictly normalize a tool-owned invocation descriptor.
 *
 * Only tools with no resolver take the legacy static metadata path. A present
 * resolver that throws, returns null, returns a Promise, or violates the
 * descriptor contract fails closed and never falls back to legacy review.
 */
export function resolveToolInvocationPermission(
  tool: Record<string, unknown>,
  input: unknown,
): ToolInvocationPermissionResolution {
  const toolName = invocationToolName(tool) || "unknown";
  const permissionProperty = readOwnDataProperty(tool, "sessionPermission");
  if (!permissionProperty.ok) {
    return failure({
      toolName,
      code: "TOOL_INVOCATION_RESOLVER_FAILED",
      reason: "invalid_session_permission",
      message: "sessionPermission must be an own plain data property.",
    });
  }
  if (!permissionProperty.present || permissionProperty.value === null || permissionProperty.value === undefined) {
    return {
      ok: true,
      source: "legacy",
      descriptor: null,
      targetKey: null,
      sessionPermission: null,
    };
  }

  const permission = permissionProperty.value;
  if (!isPlainRecord(permission)) {
    return failure({
      toolName,
      code: "TOOL_INVOCATION_RESOLVER_FAILED",
      reason: "invalid_session_permission",
      message: "sessionPermission must be a resolver-bearing or resolver-less plain data record.",
    });
  }

  const resolverProperty = readOwnDataProperty(permission, "resolveInvocation");
  if (!resolverProperty.ok) {
    return failure({
      toolName,
      code: "TOOL_INVOCATION_RESOLVER_FAILED",
      reason: "invalid_resolver",
      message: "sessionPermission.resolveInvocation must be an own synchronous data function when present.",
    });
  }
  if (!resolverProperty.present) {
    const legacyPermission = normalizeLegacyPermission(permission);
    if (!legacyPermission.ok) {
      return failure({
        toolName,
        code: "TOOL_INVOCATION_RESOLVER_FAILED",
        reason: "invalid_session_permission",
        message: "Legacy sessionPermission metadata must contain only safe own data fields.",
      });
    }
    return {
      ok: true,
      source: "legacy",
      descriptor: null,
      targetKey: null,
      sessionPermission: legacyPermission.value,
    };
  }

  const resolver = resolverProperty.value;
  if (typeof resolver !== "function") {
    return failure({
      toolName,
      code: "TOOL_INVOCATION_RESOLVER_FAILED",
      reason: "invalid_resolver",
      message: "sessionPermission.resolveInvocation must be a synchronous function.",
    });
  }

  let raw: unknown;
  try {
    raw = resolver(input);
  } catch (error) {
    void error;
    return failure({
      toolName,
      code: "TOOL_INVOCATION_RESOLVER_FAILED",
      reason: "resolver_threw",
      message: "Tool invocation resolver failed before producing a descriptor.",
    });
  }
  if (raw === null || raw === undefined) {
    return failure({
      toolName,
      code: "TOOL_INVOCATION_RESOLVER_FAILED",
      reason: "resolver_rejected",
      message: "Tool invocation resolver rejected an unknown action or invalid target.",
    });
  }

  const thenable = consumeResolverThenable(raw);
  if (thenable === "thenable") {
    return failure({
      toolName,
      code: "TOOL_INVOCATION_RESOLVER_FAILED",
      reason: "async_resolver",
      message: "Tool invocation resolvers must return synchronously.",
    });
  }
  if (thenable === "invalid") {
    return failure({
      toolName,
      reason: "invalid_descriptor",
      message: "Tool invocation descriptor could not be inspected safely.",
    });
  }

  try {
    return normalizeDescriptor(tool, raw);
  } catch (error) {
    void error;
    return failure({
      toolName,
      reason: "invalid_descriptor",
      message: "Tool invocation descriptor could not be normalized safely.",
    });
  }
}
