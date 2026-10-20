/**
 * 把脚本给的 JSON Schema 包成一个一次性 StructuredOutput 工具，
 * 注入子 agent 的 extraCustomTools。子 agent 调用它把结构化结果交回；getResult() 取出。
 *
 * MVP 不做深度 schema 校验：子 agent 已被 schema（作为工具 parameters）约束并被 prompt 指示按 schema 返回。
 * 严格校验（ajv）留二期。
 *
 * @param {object} [schema]  JSON Schema（顶层应为 type:'object'）
 * @returns {{ tool: { name: string, label: string, description: string, parameters: object, execute: Function }, getResult: () => any }}
 */
export function createStructuredOutputTool(schema) {
  let captured;
  const tool = {
    name: "structured_output",
    label: "Structured Output",
    description: "返回严格符合所需 schema 的结构化结果。完成任务后必须调用一次。",
    sessionPermission: {
      resolveInvocation: () => ({
        action: "record",
        kind: "routine",
        capability: "structured_output.record",
      }),
    },
    parameters: schema && typeof schema === "object" ? schema : { type: "object" },
    execute: async (_toolCallId, params) => {
      captured = params;
      return { content: [{ type: "text", text: "结果已记录" }] };
    },
  };
  return {
    tool,
    getResult() { return captured; },
  };
}
