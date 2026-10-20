import {
  convertToLlm as defaultConvertToLlm,
  serializeConversation as defaultSerializeConversation,
} from "@earendil-works/pi-coding-agent";

export const NATIVE_SUMMARIZATION_SYSTEM_PROMPT =
  `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

function cappedOutputTokens(reserveTokens: number, fraction: number, model: any) {
  const reserveCap = Math.floor(fraction * reserveTokens);
  const modelCap = model?.maxTokens > 0
    ? model.maxTokens
    : Number.POSITIVE_INFINITY;
  return Math.min(reserveCap, modelCap);
}

function requestMessage(promptText: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text: promptText }],
    timestamp: Date.now(),
  };
}

function serializeNativeConversation(messages: any[], convertToLlm, serializeConversation) {
  return serializeConversation(convertToLlm(messages));
}

export function buildNativeCompactionRequestShapes({
  preparation,
  model,
  customInstructions,
  convertToLlm = defaultConvertToLlm,
  serializeConversation = defaultSerializeConversation,
}: {
  preparation?: any;
  model?: any;
  customInstructions?: any;
  convertToLlm?: (messages: any[]) => any[];
  serializeConversation?: (messages: any[]) => string;
} = {}) {
  const messagesToSummarize = Array.isArray(preparation?.messagesToSummarize)
    ? preparation.messagesToSummarize
    : [];
  const turnPrefixMessages = Array.isArray(preparation?.turnPrefixMessages)
    ? preparation.turnPrefixMessages
    : [];
  const reserveTokens = preparation?.settings?.reserveTokens ?? 4096;
  const requests: any[] = [];

  if (!preparation?.isSplitTurn || messagesToSummarize.length > 0) {
    const conversationText = serializeNativeConversation(
      messagesToSummarize,
      convertToLlm,
      serializeConversation,
    );
    let basePrompt = preparation?.previousSummary
      ? UPDATE_SUMMARIZATION_PROMPT
      : SUMMARIZATION_PROMPT;
    if (customInstructions) {
      basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
    }
    let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
    if (preparation?.previousSummary) {
      promptText += `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n`;
    }
    promptText += basePrompt;
    requests.push({
      kind: "history",
      systemPrompt: NATIVE_SUMMARIZATION_SYSTEM_PROMPT,
      promptText,
      messages: [requestMessage(promptText)],
      maxTokens: cappedOutputTokens(reserveTokens, 0.8, model),
    });
  }

  if (preparation?.isSplitTurn && turnPrefixMessages.length > 0) {
    const conversationText = serializeNativeConversation(
      turnPrefixMessages,
      convertToLlm,
      serializeConversation,
    );
    const promptText =
      `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
    requests.push({
      kind: "turn-prefix",
      systemPrompt: NATIVE_SUMMARIZATION_SYSTEM_PROMPT,
      promptText,
      messages: [requestMessage(promptText)],
      maxTokens: cappedOutputTokens(reserveTokens, 0.5, model),
    });
  }

  return { requests };
}
