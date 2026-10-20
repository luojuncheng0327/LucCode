export const COMPACTION_MODE_EXPERIMENT_ID = "session.compaction_mode";
export const INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID = "session.instant_simple_compaction";
export const INSTANT_SIMPLE_COMPACTION_METHOD = "instant_simple";
export const INSTANT_SIMPLE_COMPACTION_RUNTIME_MODE = "lossy_local";

export const COMPACTION_MODES = Object.freeze({
  AUTO: "auto",
  CACHE_PRESERVING: "cache_preserving",
  PI_COMPATIBLE: "pi_compatible",
} as const);

export type CompactionMode =
  | typeof COMPACTION_MODES.AUTO
  | typeof COMPACTION_MODES.CACHE_PRESERVING
  | typeof COMPACTION_MODES.PI_COMPATIBLE;

export type CompactionLifecycleMode =
  | CompactionMode
  | typeof INSTANT_SIMPLE_COMPACTION_RUNTIME_MODE;

const KNOWN_COMPACTION_MODES = new Set<string>(Object.values(COMPACTION_MODES));

export function normalizeCompactionMode(value: unknown): CompactionMode {
  const mode = typeof value === "string" ? value : "";
  return KNOWN_COMPACTION_MODES.has(mode) ? (mode as CompactionMode) : COMPACTION_MODES.AUTO;
}

export function normalizeCompactionLifecycleMode(value: unknown): CompactionLifecycleMode {
  if (value === INSTANT_SIMPLE_COMPACTION_RUNTIME_MODE) {
    return INSTANT_SIMPLE_COMPACTION_RUNTIME_MODE;
  }
  return normalizeCompactionMode(value);
}

export function getResolvedCompactionMode(preferencesManager: unknown): CompactionMode {
  return normalizeCompactionMode(
    (preferencesManager as any)?.getExperimentValue?.(COMPACTION_MODE_EXPERIMENT_ID),
  );
}

export function getResolvedInstantSimpleCompactionEnabled(preferencesManager: unknown): boolean {
  const manager = preferencesManager as any;
  const stored = manager?.getExperimentValue?.(INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID);
  if (typeof stored === "boolean") return stored;
  if (stored !== undefined) return false;

  // Read compatibility for early releases, where this one-shot capability briefly
  // appeared as the persisted compaction mode instead of a separate toggle.
  return manager?.getExperimentValue?.(COMPACTION_MODE_EXPERIMENT_ID)
    === INSTANT_SIMPLE_COMPACTION_RUNTIME_MODE;
}
