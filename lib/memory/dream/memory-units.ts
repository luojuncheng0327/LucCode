import type { DreamSections } from "./revision-store.ts";

export type DreamEditableSection = "facts" | "longterm";
export type DreamDedupeRelation = "distinct" | "same_meaning" | "subsumes";
export type DreamRemovalReason = "completed_transient" | "obsolete" | "operational_noise";

export type DreamSourceBlock = {
  id: string;
  section: DreamEditableSection;
  text: string;
  order: number;
};

export type DreamAtomicUnit = {
  id: string;
  sourceBlockIds: string[];
  section: DreamEditableSection;
  text: string;
  order: number;
};

export type ExactDuplicateOperation = {
  kind: "remove_exact_duplicate";
  canonicalUnitId: string;
  removedUnitIds: string[];
};

export type DreamDedupeGroup = {
  id: string;
  sourceUnitIds: string[];
  sourceBlockIds: string[];
  section: DreamEditableSection;
  relation: DreamDedupeRelation;
  order: number;
};

export type DreamDedupePlan = {
  inputUnits: DreamAtomicUnit[];
  units: DreamAtomicUnit[];
  groups: DreamDedupeGroup[];
  exactDuplicateOperations: ExactDuplicateOperation[];
};

export type DreamOptimizedUnit = {
  id: string;
  groupId: string;
  sourceUnitIds: string[];
  sourceBlockIds: string[];
  section: DreamEditableSection;
  text: string;
  order: number;
};

export type DreamRemovedGroup = {
  groupId: string;
  sourceUnitIds: string[];
  sourceBlockIds: string[];
  reason: DreamRemovalReason;
};

export type DreamComposedParagraph = {
  id: string;
  section: DreamEditableSection;
  topic: string;
  sourceUnitIds: string[];
  text: string;
  order: number;
};

export type DreamUnitOperation =
  | ExactDuplicateOperation
  | { kind: "split" | "merge" | "rewrite" | "compose"; sourceUnitIds: string[]; resultUnitIds: string[] }
  | { kind: "forget"; sourceUnitIds: string[]; resultUnitIds: [] };

export type DreamOptimizationPlan = {
  sourceBlocks: DreamSourceBlock[];
  atomicUnits: DreamAtomicUnit[];
  dedupePlan: DreamDedupePlan;
  optimizedUnits: DreamOptimizedUnit[];
  removedGroups: DreamRemovedGroup[];
  operations: DreamUnitOperation[];
  sections: DreamSections;
  mergedCount: number;
  forgottenCount: number;
};

export type DreamUnitPlan = DreamOptimizationPlan & {
  paragraphs: DreamComposedParagraph[];
};

export const DREAM_ATOMIC_UNIT_MAX_CHARS = 240;
export const DREAM_COMPOSE_PARAGRAPH_MAX_CHARS = 500;
export const DREAM_COMPOSE_TOPIC_MAX_CHARS = 80;

const LIST_PREFIX_RE = /^\s*(?:[-*+]\s+|\d+[.)、]\s*)/;
const HEADING_PREFIX_RE = /^\s*#{1,6}\s+/;
const EMPTY_PLACEHOLDERS = new Set(["（暂无）", "(none)", "none"]);
const DEDUPE_RELATIONS = new Set<DreamDedupeRelation>(["distinct", "same_meaning", "subsumes"]);
const REMOVAL_REASONS = new Set<DreamRemovalReason>([
  "completed_transient",
  "obsolete",
  "operational_noise",
]);

export function normalizeDreamText(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function cleanInputLine(line: string) {
  const value = line.replace(LIST_PREFIX_RE, "").replace(HEADING_PREFIX_RE, "").trim();
  return EMPTY_PLACEHOLDERS.has(value.toLowerCase()) ? "" : value;
}

function splitSourceClauses(text: string) {
  return text
    .split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z0-9])/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function bodySourceTexts(body: string) {
  const texts: string[] = [];
  let heading = "";
  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (HEADING_PREFIX_RE.test(rawLine)) {
      heading = cleanInputLine(rawLine);
      continue;
    }
    const line = cleanInputLine(rawLine);
    if (!line) continue;
    for (const clause of splitSourceClauses(line)) {
      const contextualized = heading && !normalizeDreamText(clause).startsWith(normalizeDreamText(heading))
        ? `${heading}: ${clause}`
        : clause;
      texts.push(contextualized);
    }
  }
  return texts;
}

export function buildDreamSourceBlocks(sections: DreamSections) {
  const blocks: DreamSourceBlock[] = [];
  let order = 0;
  const add = (body: string, section: DreamEditableSection) => {
    bodySourceTexts(body).forEach((text, index) => {
      blocks.push({ id: `source:${section}:${index}`, section, text, order: order++ });
    });
  };
  add(sections.facts, "facts");
  add(sections.longterm, "longterm");
  return blocks;
}

function parseStringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Dream ${field} must be a string array`);
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function validatePlainAtomicText(value: unknown, stage: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`Dream ${stage} returned an empty unit`);
  if (/\r|\n/.test(text) || LIST_PREFIX_RE.test(text) || HEADING_PREFIX_RE.test(text)) {
    throw new Error(`Dream ${stage} must return plain one-line unit text without Markdown markers`);
  }
  if (text.length > DREAM_ATOMIC_UNIT_MAX_CHARS) {
    throw new Error(`Dream ${stage} unit exceeds the ${DREAM_ATOMIC_UNIT_MAX_CHARS}-character atomic limit`);
  }
  const withoutTerminal = text.replace(/[。！？!?；;]+$/u, "");
  if (/[。！？!?；;]/u.test(withoutTerminal)) {
    throw new Error(`Dream ${stage} returned a compound multi-sentence unit`);
  }
  return text;
}

export function validateDreamAtomization(raw: Record<string, unknown>, sourceBlocks: DreamSourceBlock[]) {
  if (!Array.isArray(raw.units)) throw new Error("Dream atomizer omitted units[]");
  const known = new Map(sourceBlocks.map((block) => [block.id, block]));
  const covered = new Set<string>();
  const perBlockOrder = new Map<string, number>();
  const units: DreamAtomicUnit[] = [];

  for (const item of raw.units as Record<string, unknown>[]) {
    const sourceBlockId = typeof item?.sourceBlockId === "string" ? item.sourceBlockId : "";
    const source = known.get(sourceBlockId);
    if (!source) throw new Error("Dream atomizer referenced an unknown source block");
    const section = item?.section === "facts" || item?.section === "longterm" ? item.section : null;
    if (section !== source.section) throw new Error("Dream atomizer moved a source block to another section");
    const localOrder = perBlockOrder.get(sourceBlockId) || 0;
    perBlockOrder.set(sourceBlockId, localOrder + 1);
    covered.add(sourceBlockId);
    units.push({
      id: `atom:${units.length}`,
      sourceBlockIds: [sourceBlockId],
      section,
      text: validatePlainAtomicText(item?.text, "atomizer"),
      order: source.order * 1_000 + localOrder,
    });
  }

  for (const block of sourceBlocks) {
    if (!covered.has(block.id)) throw new Error(`Dream atomizer omitted source block ${block.id}`);
  }
  return units;
}

function canonicalAtomicUnit(left: DreamAtomicUnit, right: DreamAtomicUnit) {
  if (left.section === "facts" && right.section === "longterm") return left;
  if (right.section === "facts" && left.section === "longterm") return right;
  return left.order <= right.order ? left : right;
}

export function removeExactDreamDuplicates(inputUnits: DreamAtomicUnit[]) {
  const units = inputUnits.map((unit) => ({ ...unit, sourceBlockIds: [...unit.sourceBlockIds] }));
  const groups = new Map<string, DreamAtomicUnit[]>();
  for (const unit of units) {
    const normalized = normalizeDreamText(unit.text);
    const group = groups.get(normalized) || [];
    group.push(unit);
    groups.set(normalized, group);
  }

  const removedIds = new Set<string>();
  const operations: ExactDuplicateOperation[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const canonical = group.reduce(canonicalAtomicUnit);
    const removed = group.filter((unit) => unit.id !== canonical.id).sort((a, b) => a.order - b.order);
    removed.forEach((unit) => removedIds.add(unit.id));
    canonical.sourceBlockIds = [...new Set(group.flatMap((unit) => unit.sourceBlockIds))];
    operations.push({
      kind: "remove_exact_duplicate",
      canonicalUnitId: canonical.id,
      removedUnitIds: removed.map((unit) => unit.id),
    });
  }
  return { units: units.filter((unit) => !removedIds.has(unit.id)), operations };
}

export function prepareDreamDedupe(inputUnits: DreamAtomicUnit[]) {
  const exact = removeExactDreamDuplicates(inputUnits);
  return {
    inputUnits: inputUnits.map((unit) => ({ ...unit, sourceBlockIds: [...unit.sourceBlockIds] })),
    units: exact.units,
    exactDuplicateOperations: exact.operations,
  };
}

export function validateDreamDedupe(
  raw: Record<string, unknown>,
  prepared: ReturnType<typeof prepareDreamDedupe>,
): DreamDedupePlan {
  if (!Array.isArray(raw.groups)) throw new Error("Dream deduper omitted groups[]");
  const known = new Map(prepared.units.map((unit) => [unit.id, unit]));
  const covered = new Set<string>();
  const groups: DreamDedupeGroup[] = [];

  for (const item of raw.groups as Record<string, unknown>[]) {
    const sourceUnitIds = parseStringArray(item?.sourceUnitIds, "deduper sourceUnitIds");
    if (sourceUnitIds.length === 0) throw new Error("Dream deduper returned an empty group");
    const sources = sourceUnitIds.map((id) => {
      const source = known.get(id);
      if (!source || covered.has(id)) throw new Error("Dream deduper referenced an unknown or repeated unit");
      covered.add(id);
      return source;
    });
    const relation = typeof item?.relation === "string" ? item.relation as DreamDedupeRelation : null;
    if (!relation || !DEDUPE_RELATIONS.has(relation)) throw new Error("Dream deduper returned an invalid relation");
    if (relation === "distinct" && sources.length !== 1) {
      throw new Error("Dream deduper may not group related or conflicting units as distinct");
    }
    if (relation !== "distinct" && sources.length < 2) {
      throw new Error(`Dream ${relation} group requires at least two units`);
    }
    const section: DreamEditableSection = sources.some((unit) => unit.section === "facts")
      ? "facts"
      : "longterm";
    groups.push({
      id: `group:${groups.length}`,
      sourceUnitIds,
      sourceBlockIds: [...new Set(sources.flatMap((unit) => unit.sourceBlockIds))],
      section,
      relation,
      order: Math.min(...sources.map((unit) => unit.order)),
    });
  }

  for (const unit of prepared.units) {
    if (!covered.has(unit.id)) throw new Error(`Dream deduper omitted unit ${unit.id}`);
  }
  return { ...prepared, groups };
}

function renderOptimizedUnits(units: DreamOptimizedUnit[], current: DreamSections): DreamSections {
  const ordered = [...units].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, "en"));
  const render = (section: DreamEditableSection) => ordered
    .filter((unit) => unit.section === section)
    .map((unit) => `- ${unit.text}`)
    .join("\n");
  return {
    facts: render("facts"),
    today: current.today,
    weekDays: current.weekDays.map((entry) => ({ ...entry })),
    longterm: render("longterm"),
  };
}

export function validateAndRenderDreamOptimization(
  raw: Record<string, unknown>,
  sourceBlocks: DreamSourceBlock[],
  atomicUnits: DreamAtomicUnit[],
  dedupePlan: DreamDedupePlan,
  current: DreamSections,
): DreamOptimizationPlan {
  if (!Array.isArray(raw.units)) throw new Error("Dream optimizer omitted units[]");
  const rawRemoved = raw.removedGroups === undefined ? [] : raw.removedGroups;
  if (!Array.isArray(rawRemoved)) throw new Error("Dream optimizer removedGroups must be an array");
  const knownGroups = new Map(dedupePlan.groups.map((group) => [group.id, group]));
  const covered = new Set<string>();
  const optimizedUnits: DreamOptimizedUnit[] = [];

  for (const item of raw.units as Record<string, unknown>[]) {
    const groupId = typeof item?.groupId === "string" ? item.groupId : "";
    const group = knownGroups.get(groupId);
    if (!group || covered.has(groupId)) throw new Error("Dream optimizer referenced an unknown or repeated group");
    const section = item?.section === "facts" || item?.section === "longterm" ? item.section : null;
    if (section !== group.section) throw new Error("Dream optimizer moved a dedupe group to another section");
    covered.add(groupId);
    optimizedUnits.push({
      id: `result:${optimizedUnits.length}`,
      groupId,
      sourceUnitIds: [...group.sourceUnitIds],
      sourceBlockIds: [...group.sourceBlockIds],
      section,
      text: validatePlainAtomicText(item?.text, "optimizer"),
      order: group.order,
    });
  }

  const removedGroups: DreamRemovedGroup[] = [];
  for (const item of rawRemoved as Record<string, unknown>[]) {
    const groupId = typeof item?.groupId === "string" ? item.groupId : "";
    const group = knownGroups.get(groupId);
    if (!group || covered.has(groupId)) throw new Error("Dream optimizer removed an unknown or repeated group");
    const reason = typeof item?.reason === "string" ? item.reason as DreamRemovalReason : null;
    if (!reason || !REMOVAL_REASONS.has(reason)) throw new Error("Dream optimizer returned an invalid removal reason");
    covered.add(groupId);
    removedGroups.push({
      groupId,
      sourceUnitIds: [...group.sourceUnitIds],
      sourceBlockIds: [...group.sourceBlockIds],
      reason,
    });
  }

  for (const group of dedupePlan.groups) {
    if (!covered.has(group.id)) throw new Error(`Dream optimizer omitted group ${group.id}`);
  }

  const operations: DreamUnitOperation[] = [...dedupePlan.exactDuplicateOperations];
  const atomsBySource = new Map<string, DreamAtomicUnit[]>();
  for (const atom of atomicUnits) {
    for (const sourceBlockId of atom.sourceBlockIds) {
      const values = atomsBySource.get(sourceBlockId) || [];
      values.push(atom);
      atomsBySource.set(sourceBlockId, values);
    }
  }
  for (const [sourceBlockId, atoms] of atomsBySource) {
    if (atoms.length > 1) {
      operations.push({ kind: "split", sourceUnitIds: [sourceBlockId], resultUnitIds: atoms.map((atom) => atom.id) });
    }
  }
  for (const group of dedupePlan.groups) {
    if (group.relation !== "distinct") {
      const result = optimizedUnits.find((unit) => unit.groupId === group.id);
      operations.push({ kind: "merge", sourceUnitIds: group.sourceUnitIds, resultUnitIds: result ? [result.id] : [] });
    }
  }
  const unitById = new Map(dedupePlan.units.map((unit) => [unit.id, unit]));
  for (const unit of optimizedUnits) {
    if (unit.sourceUnitIds.length !== 1) continue;
    const source = unitById.get(unit.sourceUnitIds[0]);
    if (source && normalizeDreamText(source.text) !== normalizeDreamText(unit.text)) {
      operations.push({ kind: "rewrite", sourceUnitIds: unit.sourceUnitIds, resultUnitIds: [unit.id] });
    }
  }
  if (removedGroups.length > 0) {
    operations.push({
      kind: "forget",
      sourceUnitIds: removedGroups.flatMap((group) => group.sourceUnitIds),
      resultUnitIds: [],
    });
  }

  const mergedCount = dedupePlan.exactDuplicateOperations
    .reduce((sum, operation) => sum + operation.removedUnitIds.length, 0)
    + dedupePlan.groups.reduce(
      (sum, group) => sum + (group.relation === "distinct" ? 0 : Math.max(0, group.sourceUnitIds.length - 1)),
      0,
    );
  return {
    sourceBlocks,
    atomicUnits,
    dedupePlan,
    optimizedUnits,
    removedGroups,
    operations,
    sections: renderOptimizedUnits(optimizedUnits, current),
    mergedCount,
    forgottenCount: removedGroups.length,
  };
}

function validateComposeTopic(value: unknown) {
  const topic = typeof value === "string" ? value.trim() : "";
  if (!topic) throw new Error("Dream composer returned an empty topic");
  if (/\r|\n/.test(topic) || LIST_PREFIX_RE.test(topic) || HEADING_PREFIX_RE.test(topic)) {
    throw new Error("Dream composer topic must be plain one-line text");
  }
  if (topic.length > DREAM_COMPOSE_TOPIC_MAX_CHARS) {
    throw new Error(`Dream composer topic exceeds the ${DREAM_COMPOSE_TOPIC_MAX_CHARS}-character limit`);
  }
  return topic;
}

function validateComposeText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error("Dream composer returned an empty paragraph");
  if (/\r|\n/.test(text) || LIST_PREFIX_RE.test(text) || HEADING_PREFIX_RE.test(text)) {
    throw new Error("Dream composer paragraph must be plain text without Markdown markers or line breaks");
  }
  if (text.length > DREAM_COMPOSE_PARAGRAPH_MAX_CHARS) {
    throw new Error(`Dream composer paragraph exceeds the ${DREAM_COMPOSE_PARAGRAPH_MAX_CHARS}-character limit`);
  }
  return text;
}

function strictComposeSourceIds(value: unknown) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Dream composer sourceUnitIds must be a string array");
  }
  const ids = value.map((entry) => entry.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("Dream composer returned a paragraph without sources");
  if (new Set(ids).size !== ids.length) {
    throw new Error("Dream composer repeated a source unit inside one paragraph");
  }
  return ids;
}

function renderComposedParagraphs(
  paragraphs: DreamComposedParagraph[],
  current: DreamSections,
): DreamSections {
  const ordered = [...paragraphs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, "en"));
  const render = (section: DreamEditableSection) => ordered
    .filter((paragraph) => paragraph.section === section)
    .map((paragraph) => paragraph.text)
    .join("\n\n");
  return {
    facts: render("facts"),
    today: current.today,
    weekDays: current.weekDays.map((entry) => ({ ...entry })),
    longterm: render("longterm"),
  };
}

export function validateAndRenderDreamComposition(
  raw: Record<string, unknown>,
  optimization: DreamOptimizationPlan,
  current: DreamSections,
): DreamUnitPlan {
  if (!Array.isArray(raw.paragraphs)) throw new Error("Dream composer omitted paragraphs[]");
  const known = new Map(optimization.optimizedUnits.map((unit) => [unit.id, unit]));
  const covered = new Set<string>();
  const paragraphs: DreamComposedParagraph[] = [];

  for (const item of raw.paragraphs as Record<string, unknown>[]) {
    const sourceUnitIds = strictComposeSourceIds(item?.sourceUnitIds);
    const sources = sourceUnitIds.map((id) => {
      const source = known.get(id);
      if (!source) throw new Error(`Dream composer referenced unknown source unit ${id}`);
      if (covered.has(id)) throw new Error(`Dream composer repeated source unit ${id}`);
      return source;
    });
    const section = item?.section === "facts" || item?.section === "longterm" ? item.section : null;
    if (!section || sources.some((source) => source.section !== section)) {
      throw new Error("Dream composer moved or combined source units across sections");
    }
    sourceUnitIds.forEach((id) => covered.add(id));
    paragraphs.push({
      id: `paragraph:${paragraphs.length}`,
      section,
      topic: validateComposeTopic(item?.topic),
      sourceUnitIds,
      text: validateComposeText(item?.text),
      order: Math.min(...sources.map((source) => source.order)),
    });
  }

  for (const unit of optimization.optimizedUnits) {
    if (!covered.has(unit.id)) throw new Error(`Dream composer omitted retained source unit ${unit.id}`);
  }

  const composeOperations: DreamUnitOperation[] = paragraphs.map((paragraph) => ({
    kind: "compose",
    sourceUnitIds: [...paragraph.sourceUnitIds],
    resultUnitIds: [paragraph.id],
  }));
  return {
    ...optimization,
    paragraphs,
    operations: [...optimization.operations, ...composeOperations],
    sections: renderComposedParagraphs(paragraphs, current),
  };
}
