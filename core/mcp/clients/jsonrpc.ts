// Inbound JSON-RPC message triage shared by every MCP transport.
//
// A transport receives three kinds of message from a server: responses to our
// own requests, notifications, and — from servers speaking a revision that
// still allowed it — server-initiated requests (elicitation/create,
// sampling/createMessage, roots/list). We implement none of the latter, so the
// only correct answer is an explicit "method not found". Dropping such a
// request on the floor strands the server waiting for a reply that never
// arrives, and filing it as a response corrupts the response bookkeeping.

export const JSON_RPC_METHOD_NOT_FOUND = -32601;

// A response carries an id and exactly one of result/error, and never a method.
export function isJsonRpcResponse(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || message.id == null) return false;
  if (Object.prototype.hasOwnProperty.call(message, "method")) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  return hasResult !== hasError;
}

// A server-initiated request carries both a method and an id. A method without
// an id is a notification, which each transport keeps handling as before.
export function isJsonRpcServerRequest(message) {
  return !!message
    && typeof message === "object"
    && message.jsonrpc === "2.0"
    && message.id != null
    && typeof message.method === "string";
}

export function methodNotFoundResponse(id, method) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: JSON_RPC_METHOD_NOT_FOUND,
      message: `Method not found: ${method}`,
    },
  };
}
