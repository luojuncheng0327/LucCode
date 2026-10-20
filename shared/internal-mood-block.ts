export const INTERNAL_MOOD_TAGS = Object.freeze([
  "mood",
  "pulse",
  "reflect",
] as const);

export type InternalMoodTag = (typeof INTERNAL_MOOD_TAGS)[number];

type LeadingMoodInspection =
  | {
    kind: "open";
    prefix: string;
    tag: InternalMoodTag;
    openTag: string;
    remainder: string;
  }
  | {
    kind: "pending";
    prefix: string;
    pending: string;
  }
  | {
    kind: "text";
  };

export interface LeadingInternalMoodBlock {
  prefix: string;
  tag: InternalMoodTag;
  content: string;
  rest: string;
}

function isLeadingWhitespace(char: string): boolean {
  return char === "\uFEFF" || /\s/u.test(char);
}

/**
 * Classify only the response-leading position. `pending` means a streaming
 * caller must retain the partial opener until another chunk or flush arrives.
 */
export function inspectLeadingInternalMoodOpener(input: string): LeadingMoodInspection {
  let openerIndex = 0;
  while (openerIndex < input.length && isLeadingWhitespace(input[openerIndex])) {
    openerIndex += 1;
  }

  const prefix = input.slice(0, openerIndex);
  const candidate = input.slice(openerIndex);
  if (!candidate) return { kind: "pending", prefix, pending: "" };

  for (const tag of INTERNAL_MOOD_TAGS) {
    const openTag = `<${tag}>`;
    if (candidate.startsWith(openTag)) {
      return {
        kind: "open",
        prefix,
        tag,
        openTag,
        remainder: candidate.slice(openTag.length),
      };
    }
  }

  if (INTERNAL_MOOD_TAGS.some((tag) => `<${tag}>`.startsWith(candidate))) {
    return { kind: "pending", prefix, pending: candidate };
  }
  return { kind: "text" };
}

/** Parse one complete, correctly paired internal block at response start. */
export function parseLeadingInternalMoodBlock(input: string): LeadingInternalMoodBlock | null {
  const inspection = inspectLeadingInternalMoodOpener(input);
  if (inspection.kind !== "open") return null;

  const closeTag = `</${inspection.tag}>`;
  const closeIndex = inspection.remainder.indexOf(closeTag);
  if (closeIndex < 0) return null;

  return {
    prefix: inspection.prefix,
    tag: inspection.tag,
    content: inspection.remainder.slice(0, closeIndex),
    rest: inspection.remainder.slice(closeIndex + closeTag.length),
  };
}
