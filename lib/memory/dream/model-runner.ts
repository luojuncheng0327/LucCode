import { callText } from "../../../core/llm-client.ts";
import { callTextConfigFromResolvedModel } from "../../../core/model-execution-config.ts";
import { getLocale } from "../../i18n.ts";
import { attachPromptLayoutMetadata, buildUtilityPromptLayout } from "../../llm/prompt-layout.ts";
import { withMemoryReasoningBuffer } from "../llm-budget.ts";
import {
  buildDreamAtomizerPrompt,
  buildDreamComposerPrompt,
  buildDreamDeduperPrompt,
  buildDreamOptimizerPrompt,
  buildDreamVerifierPrompt,
} from "../prompts/dream.ts";
import {
  DREAM_ATOMIC_UNIT_MAX_CHARS,
  DREAM_COMPOSE_PARAGRAPH_MAX_CHARS,
  DREAM_COMPOSE_TOPIC_MAX_CHARS,
  buildDreamSourceBlocks,
  prepareDreamDedupe,
  validateAndRenderDreamOptimization,
  validateAndRenderDreamComposition,
  validateDreamAtomization,
  validateDreamDedupe,
  type DreamAtomicUnit,
  type DreamDedupePlan,
  type DreamOptimizationPlan,
  type DreamSourceBlock,
  type DreamUnitPlan,
} from "./memory-units.ts";
import type { DreamSections } from "./revision-store.ts";
import type { DreamRunTrigger } from "./state-store.ts";

export const DREAM_MEMORY_HARD_MAX_CHARS = 5_000;
export const DREAM_COMPOSE_SOFT_TARGETS = Object.freeze({ facts: 400, longterm: 800 });

function stripJsonFence(raw: string) {
  const text = String(raw || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

function parseObject(raw: string) {
  const parsed = JSON.parse(stripJsonFence(raw));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("structured Dream response must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function usageContext(operation: string, trigger: DreamRunTrigger, resolvedModel: any, layout: any) {
  return attachPromptLayoutMetadata({
    source: { subsystem: "memory", operation, surface: "system", trigger },
    attribution: { kind: "memory", agentId: resolvedModel?.usageAgentId || null },
  }, layout.usageMetadata);
}

async function callStructured(options: {
  promptSpec: { cacheGroup: string; templateVersion: string; systemPrompt: string };
  userContent: string;
  resolvedModel: any;
  operation: string;
  trigger: DreamRunTrigger;
  maxTokens: number;
  signal?: AbortSignal;
}) {
  const run = async (userContent: string, operation: string) => {
    const layout = buildUtilityPromptLayout({
      cacheGroup: options.promptSpec.cacheGroup,
      templateVersion: options.promptSpec.templateVersion,
      systemPrompt: options.promptSpec.systemPrompt,
      userContent,
    });
    return callText({
      ...callTextConfigFromResolvedModel(options.resolvedModel),
      messages: layout.messages,
      systemPrompt: layout.systemPrompt,
      temperature: 0.1,
      maxTokens: withMemoryReasoningBuffer(options.maxTokens, options.resolvedModel),
      timeoutMs: 90_000,
      signal: options.signal,
      usageLedger: options.resolvedModel?.usageLedger,
      usageContext: usageContext(operation, options.trigger, options.resolvedModel, layout),
    }) as Promise<string>;
  };

  const raw = await run(options.userContent, options.operation);
  try {
    return parseObject(raw);
  } catch (err: any) {
    const repairInput = `${options.userContent}\n\nThe previous response was invalid JSON (${err?.message || err}). Return one corrected JSON object only. Previous response:\n${String(raw).slice(0, 12_000)}`;
    return parseObject(await run(repairInput, `${options.operation}_repair`));
  }
}

async function runValidatedStage<T>(options: {
  promptSpec: { cacheGroup: string; templateVersion: string; systemPrompt: string };
  payload: Record<string, unknown>;
  validate: (raw: Record<string, unknown>) => T;
  resolvedModel: any;
  trigger: DreamRunTrigger;
  operation: string;
  repairInstruction: string;
  maxTokens?: number;
  signal?: AbortSignal;
}) {
  const userContent = JSON.stringify(options.payload);
  const raw = await callStructured({
    promptSpec: options.promptSpec,
    userContent,
    resolvedModel: options.resolvedModel,
    operation: options.operation,
    trigger: options.trigger,
    maxTokens: options.maxTokens || 8192,
    signal: options.signal,
  });
  try {
    return options.validate(raw);
  } catch (err: any) {
    const repaired = await callStructured({
      promptSpec: options.promptSpec,
      userContent: `${userContent}\n\nValidation error: ${err?.message || err}. ${options.repairInstruction}`,
      resolvedModel: options.resolvedModel,
      operation: `${options.operation}_validation_repair`,
      trigger: options.trigger,
      maxTokens: options.maxTokens || 8192,
      signal: options.signal,
    });
    return options.validate(repaired);
  }
}

export async function atomizeDreamMemory(options: {
  current: DreamSections;
  resolvedModel: any;
  trigger: DreamRunTrigger;
  signal?: AbortSignal;
}) {
  const sourceBlocks = buildDreamSourceBlocks(options.current);
  if (sourceBlocks.length === 0) return { sourceBlocks, units: [] as DreamAtomicUnit[] };
  const units = await runValidatedStage({
    promptSpec: buildDreamAtomizerPrompt(getLocale()),
    payload: {
      sourceBlocks,
      constraints: {
        requiredSourceBlockIds: sourceBlocks.map((block) => block.id),
        maxUnitChars: DREAM_ATOMIC_UNIT_MAX_CHARS,
        editableSections: ["facts", "longterm"],
        externalMemorySources: "forbidden",
      },
    },
    validate: (raw) => validateDreamAtomization(raw, sourceBlocks),
    resolvedModel: options.resolvedModel,
    trigger: options.trigger,
    operation: "memory.dream.atomize",
    repairInstruction: "Return atomic units that cover every sourceBlockId, preserve its section, and add no outside information.",
    signal: options.signal,
  });
  return { sourceBlocks, units };
}

export async function dedupeDreamMemory(options: {
  units: DreamAtomicUnit[];
  resolvedModel: any;
  trigger: DreamRunTrigger;
  signal?: AbortSignal;
}) {
  const prepared = prepareDreamDedupe(options.units);
  if (prepared.units.length === 0) return { ...prepared, groups: [] } satisfies DreamDedupePlan;
  return runValidatedStage({
    promptSpec: buildDreamDeduperPrompt(getLocale()),
    payload: {
      units: prepared.units,
      exactDuplicateOperations: prepared.exactDuplicateOperations,
      constraints: {
        requiredUnitIds: prepared.units.map((unit) => unit.id),
        allowedRelations: ["distinct", "same_meaning", "subsumes"],
        factsPreferredOverLongterm: true,
      },
    },
    validate: (raw) => validateDreamDedupe(raw, prepared),
    resolvedModel: options.resolvedModel,
    trigger: options.trigger,
    operation: "memory.dream.dedupe",
    repairInstruction: "Cover each known unit exactly once. Keep related, different, or conflicting assertions in separate distinct groups.",
    signal: options.signal,
  });
}

function totalBodyChars(sections: DreamSections) {
  return sections.facts.length
    + sections.today.length
    + sections.longterm.length
    + sections.weekDays.reduce((sum, entry) => sum + entry.body.length, 0);
}

function optimizerSafetyLimit(current: DreamSections) {
  const preservedBodyChars = current.today.length
    + current.weekDays.reduce((sum, entry) => sum + entry.body.length, 0);
  const currentTotalBodyChars = totalBodyChars(current);
  const maxTotalBodyChars = Math.max(DREAM_MEMORY_HARD_MAX_CHARS, currentTotalBodyChars);
  return {
    maxTotalBodyChars,
    maxEditableBodyChars: Math.max(0, maxTotalBodyChars - preservedBodyChars),
    currentEditableBodyChars: current.facts.length + current.longterm.length,
    preservedBodyChars,
    role: "safety_ceiling_not_target" as const,
  };
}

export async function optimizeDreamMemory(options: {
  current: DreamSections;
  sourceBlocks: DreamSourceBlock[];
  atomicUnits: DreamAtomicUnit[];
  dedupePlan: DreamDedupePlan;
  resolvedModel: any;
  trigger: DreamRunTrigger;
  signal?: AbortSignal;
}) {
  const safetyLimit = optimizerSafetyLimit(options.current);
  const unitById = new Map(options.dedupePlan.units.map((unit) => [unit.id, unit]));
  const groups = options.dedupePlan.groups.map((group) => ({
    ...group,
    sources: group.sourceUnitIds.map((id) => unitById.get(id)),
  }));
  const validate = (raw: Record<string, unknown>) => {
    const plan = validateAndRenderDreamOptimization(
      raw,
      options.sourceBlocks,
      options.atomicUnits,
      options.dedupePlan,
      options.current,
    );
    const total = totalBodyChars(plan.sections);
    if (total > safetyLimit.maxTotalBodyChars) {
      throw new Error(`Dream optimizer output is ${total} characters; the safety limit is ${safetyLimit.maxTotalBodyChars}; no changes were applied`);
    }
    return plan;
  };
  return runValidatedStage({
    promptSpec: buildDreamOptimizerPrompt(getLocale()),
    payload: {
      groups,
      safetyLimit,
      constraints: {
        requiredGroupIds: groups.map((group) => group.id),
        allowedRemovalReasons: ["completed_transient", "obsolete", "operational_noise"],
        maxUnitChars: DREAM_ATOMIC_UNIT_MAX_CHARS,
        outputFormat: "plain_one_line_units",
        externalMemorySources: "forbidden",
      },
    },
    validate,
    resolvedModel: options.resolvedModel,
    trigger: options.trigger,
    operation: "memory.dream.optimize",
    repairInstruction: "Cover every group exactly once, preserve source meaning, keep assigned sections, remove only objectively transient/obsolete/noise groups, and stay below the safety ceiling.",
    signal: options.signal,
  });
}

function composerSafetyLimit(current: DreamSections) {
  const preservedBodyChars = current.today.length
    + current.weekDays.reduce((sum, entry) => sum + entry.body.length, 0);
  const currentTotalBodyChars = current.facts.length + current.longterm.length + preservedBodyChars;
  return {
    maxParagraphChars: DREAM_COMPOSE_PARAGRAPH_MAX_CHARS,
    maxTopicChars: DREAM_COMPOSE_TOPIC_MAX_CHARS,
    maxTotalBodyChars: Math.max(DREAM_MEMORY_HARD_MAX_CHARS, currentTotalBodyChars),
    softTargets: DREAM_COMPOSE_SOFT_TARGETS,
    role: "global_safety_ceiling_with_soft_section_targets" as const,
  };
}

export async function composeDreamMemory(options: {
  current: DreamSections;
  optimization: DreamOptimizationPlan;
  resolvedModel: any;
  trigger: DreamRunTrigger;
  compressionRepair?: {
    previousParagraphs: DreamUnitPlan["paragraphs"];
    feedback: string[];
  };
  signal?: AbortSignal;
}) {
  const safetyLimit = composerSafetyLimit(options.current);
  const retainedUnits = options.optimization.optimizedUnits.map((unit) => ({
    id: unit.id,
    section: unit.section,
    text: unit.text,
  }));
  const validate = (raw: Record<string, unknown>) => {
    const plan = validateAndRenderDreamComposition(raw, options.optimization, options.current);
    const total = totalBodyChars(plan.sections);
    if (total > safetyLimit.maxTotalBodyChars) {
      throw new Error(
        `Dream composer output is ${total} total characters; the safety limit is ${safetyLimit.maxTotalBodyChars}; no changes were applied`,
      );
    }
    return plan;
  };
  if (retainedUnits.length === 0) {
    return validate({ paragraphs: [] });
  }
  const payload = {
    units: retainedUnits,
    constraints: {
      requiredSourceUnitIds: retainedUnits.map((unit) => unit.id),
      maxParagraphChars: safetyLimit.maxParagraphChars,
      maxTopicChars: safetyLimit.maxTopicChars,
      maxTotalBodyChars: safetyLimit.maxTotalBodyChars,
      softTargets: safetyLimit.softTargets,
      outputFormat: "natural_paragraphs_separated_by_blank_lines",
      externalMemorySources: "forbidden",
    },
    ...(options.compressionRepair ? {
      compressionRepair: {
        previousParagraphs: options.compressionRepair.previousParagraphs,
        verifierFeedback: options.compressionRepair.feedback,
        directive: "Compress phrasing and compose naturally related units more tightly without dropping any unique information. Soft targets may be exceeded when faithful coverage requires it.",
      },
    } : {}),
  };
  if (options.compressionRepair) {
    const raw = await callStructured({
      promptSpec: buildDreamComposerPrompt(getLocale()),
      userContent: JSON.stringify(payload),
      resolvedModel: options.resolvedModel,
      operation: "memory.dream.compose_compression_repair",
      trigger: options.trigger,
      maxTokens: 8192,
      signal: options.signal,
    });
    return validate(raw);
  }
  return runValidatedStage({
    promptSpec: buildDreamComposerPrompt(getLocale()),
    payload,
    validate,
    resolvedModel: options.resolvedModel,
    trigger: options.trigger,
    operation: "memory.dream.compose",
    repairInstruction: "Cover every retained unit exactly once, preserve its section, add no unsupported information, respect paragraph/topic hard limits, and stay below the global safety ceiling. Treat section targets as soft and preserve unique information first.",
    signal: options.signal,
  });
}

function stringArray(raw: unknown) {
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

export async function verifyDreamSections(options: {
  current: DreamSections;
  plan: DreamUnitPlan;
  resolvedModel: any;
  trigger: DreamRunTrigger;
  signal?: AbortSignal;
}) {
  const raw = await callStructured({
    promptSpec: buildDreamVerifierPrompt(getLocale()),
    userContent: JSON.stringify({
      currentSections: options.current,
      sourceBlocks: options.plan.sourceBlocks,
      atomicUnits: options.plan.atomicUnits,
      exactDuplicateOperations: options.plan.dedupePlan.exactDuplicateOperations,
      dedupeGroups: options.plan.dedupePlan.groups,
      optimizedUnits: options.plan.optimizedUnits,
      removedGroups: options.plan.removedGroups,
      composedParagraphs: options.plan.paragraphs,
      proposedSections: options.plan.sections,
    }),
    resolvedModel: options.resolvedModel,
    operation: "memory.dream.verify",
    trigger: options.trigger,
    maxTokens: 4096,
    signal: options.signal,
  });
  const fields = [
    "missingClaims",
    "compoundUnits",
    "incorrectMerges",
    "unsupportedClaims",
    "subjectLeaks",
    "unsafeRemovals",
    "duplicateClaims",
    "fragmentedTopics",
    "incoherentParagraphs",
  ] as const;
  const failures = Object.fromEntries(fields.map((field) => [field, stringArray(raw[field])])) as Record<typeof fields[number], string[]>;
  const semanticOk = raw.ok === true && fields.every((field) => failures[field].length === 0);
  if (!semanticOk) {
    throw new Error(`Dream verification failed: ${fields.map((field) => `${field}=${failures[field].length}`).join(", ")}`);
  }
  const compressionFeedback = stringArray(raw.insufficientCompression);
  return {
    ok: true as const,
    insufficientCompression: compressionFeedback.length > 0,
    compressionFeedback,
  };
}

export function dreamModelId(resolvedModel: any) {
  return String(resolvedModel?.model?.id || resolvedModel?.id || resolvedModel?.model || "");
}
