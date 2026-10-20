export const EXPERIMENT_STATUSES = new Set(["alpha", "beta", "deprecated", "retired"]);
export const EXPERIMENT_SCOPES = new Set(["global", "agent", "session"]);
export const EXPERIMENT_VALUE_SCHEMA_TYPES = new Set(["boolean", "enum", "number"]);
export const EXPERIMENT_PRESENTATION_TYPES = new Set(["toggle", "select", "segmented", "paired_toggles"]);

export function cloneExperiment(value) {
  return structuredClone(value);
}

export function normalizeExperimentDefinition(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("experiment definition must be an object");
  }
  if (!raw.id || typeof raw.id !== "string") throw new Error("experiment definition requires id");
  if (!EXPERIMENT_SCOPES.has(raw.scope)) throw new Error(`invalid experiment scope: ${raw.id}`);
  if (!EXPERIMENT_STATUSES.has(raw.status)) throw new Error(`invalid experiment status: ${raw.id}`);

  const valueSchema = raw.valueSchema || {
    type: typeof raw.defaultValue === "boolean" ? "boolean" : "enum",
  };
  if (!EXPERIMENT_VALUE_SCHEMA_TYPES.has(valueSchema.type)) {
    throw new Error(`invalid experiment value schema: ${raw.id}`);
  }
  if (valueSchema.presentation && !EXPERIMENT_PRESENTATION_TYPES.has(valueSchema.presentation.type)) {
    throw new Error(`invalid experiment presentation: ${raw.id}`);
  }
  if (valueSchema.type === "enum") {
    const options = Array.isArray(valueSchema.options) ? valueSchema.options : [];
    if (options.length === 0) throw new Error(`enum experiment requires options: ${raw.id}`);
    if (!options.some((opt) => opt.value === raw.defaultValue)) {
      throw new Error(`enum default must be in options: ${raw.id}`);
    }
  }

  return cloneExperiment({ ...raw, valueSchema });
}

export function normalizeExperimentValue(definition, value) {
  const schema = definition.valueSchema || {};
  if (schema.type === "boolean") return value === true;
  if (schema.type === "number") {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`invalid experiment value for ${definition.id}`);
    return num;
  }
  if (schema.type === "enum") {
    const allowed = new Set((schema.options || []).map((opt) => opt.value));
    if (!allowed.has(value)) throw new Error(`invalid experiment value for ${definition.id}`);
    return value;
  }
  throw new Error(`invalid experiment value schema for ${definition.id}`);
}
