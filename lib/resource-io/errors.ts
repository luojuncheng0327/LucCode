export class ResourceIOError extends Error {
  declare code: string;
  declare status: number;

  constructor(message: string, { code = "resource_io_error", status = 400 }: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "ResourceIOError";
    this.code = code;
    this.status = status;
  }
}

export function capabilityDenied(capability: string, providerId: string): ResourceIOError {
  return new ResourceIOError(`ResourceIO capability denied: ${providerId}.${capability}`, {
    code: "capability_denied",
    status: 403,
  });
}

export function providerNotAvailable(providerId: string): ResourceIOError {
  return new ResourceIOError(`ResourceIO provider not available: ${providerId}`, {
    code: "provider_not_available",
    status: 501,
  });
}

export function resourceAccessDenied(operation: string, filePath: string, reason?: string, details: { safeMessage?: string } = {}): ResourceIOError {
  const err: any = new ResourceIOError(details.safeMessage || reason || `ResourceIO ${operation} denied: ${filePath}`, {
    code: "resource_access_denied",
    status: 403,
  });
  err.operation = operation;
  err.filePath = filePath;
  if (reason) err.reason = reason;
  if (details.safeMessage) err.safeMessage = details.safeMessage;
  return err;
}

export function crossProviderCopyUnsupported(fromProvider: string, toProvider: string): ResourceIOError {
  const err: any = new ResourceIOError(`ResourceIO cross-provider copy is not implemented: ${fromProvider} -> ${toProvider}`, {
    code: "cross_provider_copy_unsupported",
    status: 501,
  });
  err.fromProvider = fromProvider;
  err.toProvider = toProvider;
  return err;
}

export function crossProviderMoveUnsupported(fromProvider: string, toProvider: string): ResourceIOError {
  const err: any = new ResourceIOError(`ResourceIO cross-provider move is not implemented: ${fromProvider} -> ${toProvider}`, {
    code: "cross_provider_move_unsupported",
    status: 501,
  });
  err.fromProvider = fromProvider;
  err.toProvider = toProvider;
  return err;
}

export function resourceNotFound(filePath: string): ResourceIOError {
  const err: any = new ResourceIOError(`ResourceIO resource not found: ${filePath}`, {
    code: "resource_not_found",
    status: 404,
  });
  err.filePath = filePath;
  return err;
}

export function targetAlreadyExists(filePath: string): ResourceIOError {
  const err: any = new ResourceIOError(`ResourceIO target already exists: ${filePath}`, {
    code: "target_already_exists",
    status: 409,
  });
  err.filePath = filePath;
  return err;
}
