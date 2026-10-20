import {
  cloneExperiment,
  normalizeExperimentDefinition,
  normalizeExperimentValue,
} from "../../shared/experiments-schema.ts";
import {
  COMPACTION_MODE_EXPERIMENT_ID,
  COMPACTION_MODES,
  getResolvedInstantSimpleCompactionEnabled,
  INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID,
} from "../../shared/compaction-mode.ts";

export const CACHE_SNAPSHOT_EXPERIMENT_ID = "memory.cache_snapshot_reflection";
export const DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID = "provider.deepseek_roleplay_reasoning_patch";
export const PROACTIVE_SUBAGENT_EXPERIMENT_ID = "subagent.proactive_delegation";
export { COMPACTION_MODE_EXPERIMENT_ID, INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID };

const RETIRED_EXPERIMENT_VALUES = new Map([
  [CACHE_SNAPSHOT_EXPERIMENT_ID, "off"],
]);

const DEFINITIONS = [
  normalizeExperimentDefinition({
    id: COMPACTION_MODE_EXPERIMENT_ID,
    titleKey: "settings.experiments.compaction.title",
    descriptionKey: "settings.experiments.compaction.description",
    owner: "session",
    scope: "global",
    defaultValue: COMPACTION_MODES.AUTO,
    valueSchema: {
      type: "enum",
      presentation: {
        type: "select",
      },
      options: [
        { value: COMPACTION_MODES.AUTO, labelKey: "settings.experiments.compaction.auto" },
        { value: COMPACTION_MODES.CACHE_PRESERVING, labelKey: "settings.experiments.compaction.cachePreserving" },
        { value: COMPACTION_MODES.PI_COMPATIBLE, labelKey: "settings.experiments.compaction.piCompatible" },
      ],
    },
    status: "beta",
    risk: "low",
    restartPolicy: "immediate",
    targetHome: {
      tab: "experiments",
      section: "compaction",
      whenStable: "Move to General / Sessions after compaction behavior stabilizes across providers.",
    },
    exitCriteria: [
      "Auto mode consistently chooses a successful compaction path for long sessions.",
      "Cache-preserving and Pi-compatible modes both keep the same persisted compaction entry schema.",
      "Usage logs clearly identify which compaction path handled each request.",
    ],
    sunsetPolicy: {
      removeWhenRetired: false,
      migration: "Keep reading session.compaction_mode until the setting graduates out of Experiments.",
    },
  }),
  normalizeExperimentDefinition({
    id: INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID,
    titleKey: "settings.experiments.instantSimpleCompaction.title",
    descriptionKey: "settings.experiments.instantSimpleCompaction.description",
    owner: "session",
    scope: "global",
    defaultValue: false,
    valueSchema: {
      type: "boolean",
      presentation: {
        type: "toggle",
      },
    },
    status: "alpha",
    risk: "medium",
    restartPolicy: "immediate",
    targetHome: {
      tab: "experiments",
      section: "compaction",
      whenStable: "Keep the one-shot action beside the context ring and graduate only its visibility control.",
    },
    exitCriteria: [
      "The action appears only while the experiment is enabled.",
      "Invoking it never changes automatic or ordinary compaction behavior.",
      "The local checkpoint preserves the retained tail and strips complete tool transactions.",
    ],
    sunsetPolicy: {
      removeWhenRetired: false,
      migration: "Keep the one-shot action hidden when disabled; never promote it into session.compaction_mode.",
    },
  }),
  normalizeExperimentDefinition({
    id: DEEPSEEK_ROLEPLAY_REASONING_PATCH_EXPERIMENT_ID,
    titleKey: "settings.experiments.deepseekRoleplay.title",
    descriptionKey: "settings.experiments.deepseekRoleplay.description",
    owner: "provider",
    scope: "global",
    defaultValue: false,
    valueSchema: {
      type: "boolean",
      presentation: {
        type: "toggle",
      },
    },
    status: "alpha",
    risk: "medium",
    restartPolicy: "new_session",
    targetHome: {
      tab: "providers",
      section: "deepseek",
      whenStable: "Move to provider-level DeepSeek behavior settings if the patch improves mood and persona adherence without hurting task reliability.",
    },
    exitCriteria: [
      "DeepSeek V4 keeps Luc's mood / pulse / reflect contract more consistently in new sessions.",
      "The marker never appears in UI, JSONL history, restore output, memory extraction, or summaries.",
      "Code, tool-heavy, and utility-like chat tasks do not become noticeably more theatrical.",
    ],
    sunsetPolicy: {
      removeWhenRetired: true,
      migration: "Drop the experiment value once the patch is either promoted to a DeepSeek provider option or retired.",
    },
  }),
  normalizeExperimentDefinition({
    id: PROACTIVE_SUBAGENT_EXPERIMENT_ID,
    titleKey: "settings.experiments.proactiveSubagent.title",
    descriptionKey: "settings.experiments.proactiveSubagent.description",
    owner: "session",
    scope: "global",
    defaultValue: false,
    valueSchema: {
      type: "boolean",
      presentation: {
        type: "toggle",
      },
    },
    status: "beta",
    risk: "low",
    restartPolicy: "new_session",
    targetHome: {
      tab: "agent",
      section: "subagent",
      whenStable: "Promote to Agent / Subagent settings if delegation quality improves measurably.",
    },
    exitCriteria: [
      "Subagent delegation reduces main context token usage without degrading task accuracy.",
      "3-query threshold feels natural across coding, research, and conversational tasks.",
    ],
    sunsetPolicy: {
      removeWhenRetired: true,
      migration: "Drop the experiment value once promoted or retired.",
    },
  }),
];

const DEFINITIONS_BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

export function getExperimentDefinitions() {
  return DEFINITIONS.map(cloneExperiment);
}

export function getExperimentDefinition(id) {
  const definition = DEFINITIONS_BY_ID.get(id);
  return definition ? cloneExperiment(definition) : null;
}

function requireDefinition(id) {
  const definition = DEFINITIONS_BY_ID.get(id);
  if (!definition) throw new Error(`unknown experiment id: ${id}`);
  return definition;
}

function requirePreferencesManager(preferencesManager) {
  if (!preferencesManager || typeof preferencesManager.setExperimentValue !== "function") {
    throw new Error("preferences manager is required");
  }
}

export function getResolvedExperimentValue(preferencesManager, id) {
  if (RETIRED_EXPERIMENT_VALUES.has(id)) return RETIRED_EXPERIMENT_VALUES.get(id);
  const definition = requireDefinition(id);
  const stored = preferencesManager?.getExperimentValue?.(id);
  if (id === INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID) {
    return getResolvedInstantSimpleCompactionEnabled(preferencesManager);
  }
  if (stored === undefined) return definition.defaultValue;
  try {
    return normalizeExperimentValue(definition, stored);
  } catch {
    return definition.defaultValue;
  }
}

export function setExperimentValue(preferencesManager, id, value) {
  if (RETIRED_EXPERIMENT_VALUES.has(id)) {
    requirePreferencesManager(preferencesManager);
    const retiredValue = RETIRED_EXPERIMENT_VALUES.get(id);
    preferencesManager.setExperimentValue(id, retiredValue);
    return retiredValue;
  }
  const definition = requireDefinition(id);
  if (definition.scope !== "global") {
    throw new Error(`experiment ${id} requires ${definition.scope} scope`);
  }
  requirePreferencesManager(preferencesManager);
  const normalized = normalizeExperimentValue(definition, value);
  preferencesManager.setExperimentValue(id, normalized);
  return normalized;
}

export function listResolvedExperiments(preferencesManager) {
  return DEFINITIONS.map((definition) => ({
    ...cloneExperiment(definition),
    value: getResolvedExperimentValue(preferencesManager, definition.id),
  }));
}
