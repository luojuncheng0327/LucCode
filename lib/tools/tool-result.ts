type ToolTextContent = { type: "text"; text: string };
type ToolResult<TDetails extends object> = {
  content: ToolTextContent[];
  details: TDetails;
  isError?: true;
};

/**
 * Standardized tool result constructors.
 * All Pi SDK tools return { content: ContentBlock[], details?: object }.
 */

export function toolOk<TDetails extends object = Record<string, never>>(
  text: string,
  details = {} as TDetails,
): ToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function toolError<TDetails extends object = Record<string, never>>(
  text: string,
  details = {} as TDetails,
): ToolResult<TDetails & { error: string }> {
  return {
    isError: true,
    content: [{ type: "text", text }],
    details: { ...details, error: text },
  };
}
