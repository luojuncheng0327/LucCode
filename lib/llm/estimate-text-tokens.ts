/**
 * The single character-count token estimate shared by every caller that needs
 * to price a plain string against a token budget.
 *
 * This lives in a dependency-free leaf on purpose. The compactor, the session
 * reminder budget and the tool catalog manifest all need the same number, and
 * several of those callers (display projection in the hub and the collab
 * transcript) must not pull the compaction stack in behind it.
 *
 * The heuristic deliberately overestimates: four characters per token is the
 * conservative side of every tokenizer we target, so a budget check that
 * passes here also passes at the provider.
 */
export function estimateTextTokens(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
