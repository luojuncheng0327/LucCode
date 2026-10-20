type SessionOperation = "retry" | "fork" | string;

const activeSessionOperations = new Map<string, { token: symbol; operation: SessionOperation }>();

function normalizeKey(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
export function sessionOperationBusyError(operation: SessionOperation, activeOperation: SessionOperation) {
  const error: any = new Error("session_busy");
  error.code = "session_busy";
  error.status = 409;
  error.operation = operation;
  error.activeOperation = activeOperation;
  return error;
}

/**
 * Reserve one Session mutation boundary. Retry and Fork both use this keyed
 * lock so their preflight, transcript commit, and sidecar copies cannot
 * observe different versions of the same Session.
 */
export function acquireSessionOperation(sessionIdentity: unknown, operation: SessionOperation) {
  const key = normalizeKey(sessionIdentity);
  if (!key) throw new Error("session operation requires a stable Session identity");
  const active = activeSessionOperations.get(key);
  if (active) throw sessionOperationBusyError(operation, active.operation);

  const token = Symbol(operation);
  activeSessionOperations.set(key, { token, operation });
  let released = false;
  return () => {
    if (released) return false;
    released = true;
    if (activeSessionOperations.get(key)?.token !== token) return false;
    activeSessionOperations.delete(key);
    return true;
  };
}
