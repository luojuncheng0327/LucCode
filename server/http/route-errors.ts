import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status";

export type RouteErrorStatus = ClientErrorStatusCode | ServerErrorStatusCode;

export type RouteErrorOptions = {
  code: string;
  message: string;
  status: RouteErrorStatus;
  traceId?: string | null;
};

export class HttpRouteError extends Error {
  code: string;
  status: RouteErrorStatus;
  traceId?: string;

  constructor(options: RouteErrorOptions) {
    assertRouteErrorOptions(options);
    super(options.message);
    this.name = "HttpRouteError";
    this.code = options.code;
    this.status = options.status;
    if (options.traceId) this.traceId = options.traceId;
  }
}

export function jsonRouteError(c, input: HttpRouteError | RouteErrorOptions) {
  const err = toHttpRouteError(input);
  return c.json({
    error: {
      code: err.code,
      message: err.message,
      ...(err.traceId ? { traceId: err.traceId } : {}),
    },
  }, err.status);
}

function toHttpRouteError(input: HttpRouteError | RouteErrorOptions) {
  if (input instanceof HttpRouteError) return input;
  return new HttpRouteError(input);
}

function assertRouteErrorOptions(value: unknown): asserts value is RouteErrorOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("RouteErrorOptions must be an object");
  }
  const options = value as Partial<RouteErrorOptions>;
  if (typeof options.code !== "string" || options.code.trim().length === 0) {
    throw new TypeError("RouteErrorOptions.code must be a non-empty string");
  }
  if (typeof options.message !== "string" || options.message.trim().length === 0) {
    throw new TypeError("RouteErrorOptions.message must be a non-empty string");
  }
  assertRouteErrorStatus(options.status);
  if (options.traceId !== undefined && options.traceId !== null && typeof options.traceId !== "string") {
    throw new TypeError("RouteErrorOptions.traceId must be a string when provided");
  }
}

export function assertRouteErrorStatus(value: unknown): asserts value is RouteErrorStatus {
  if (!isRouteErrorStatus(value)) {
    throw new TypeError("RouteErrorOptions.status must be a supported 4xx or 5xx HTTP status");
  }
}

function isRouteErrorStatus(value: unknown): value is RouteErrorStatus {
  return typeof value === "number" && ROUTE_ERROR_STATUSES.has(value as RouteErrorStatus);
}

const ROUTE_ERROR_STATUSES = new Set<RouteErrorStatus>([
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409,
  410, 411, 412, 413, 414, 415, 416, 417, 418, 421,
  422, 423, 424, 425, 426, 428, 429, 431, 451,
  500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
]);
