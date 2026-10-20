const RECEIPT_CLAIMS = new WeakMap<object, any>();

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameNullableText(left: unknown, right: unknown) {
  return text(left) === text(right);
}

function sameNullableRevision(left: unknown, right: unknown) {
  const normalizedLeft = Number.isSafeInteger(left) ? Number(left) : null;
  const normalizedRight = Number.isSafeInteger(right) ? Number(right) : null;
  return normalizedLeft === normalizedRight;
}

export function issueAutomationSuggestionReceipt(claims: {
  suggestionId: string;
  confirmedAt: string;
  expiresAt: number;
  studioId?: string | null;
  operation: "create" | "update";
  jobId?: string | null;
  baseConfigRevision?: number | null;
}, { now = () => Date.now() }: { now?: () => number } = {}) {
  const receipt = Object.freeze({});
  RECEIPT_CLAIMS.set(receipt, Object.freeze({ ...claims, now }));
  return receipt;
}

export function inspectAutomationSuggestionReceipt(receipt: unknown, expected: {
  studioId?: string | null;
  operation?: "create" | "update";
  jobId?: string | null;
  baseConfigRevision?: number | null;
} = {}) {
  if (!receipt || typeof receipt !== "object") {
    throw Object.assign(new Error("automation suggestion receipt is required"), {
      code: "automation_suggestion_receipt_required",
    });
  }
  const claims = RECEIPT_CLAIMS.get(receipt as object);
  if (!claims) {
    throw Object.assign(new Error("automation suggestion receipt is invalid or already consumed"), {
      code: "automation_suggestion_receipt_invalid",
    });
  }
  if (claims.expiresAt <= claims.now()) {
    RECEIPT_CLAIMS.delete(receipt as object);
    throw Object.assign(new Error("automation suggestion receipt expired"), {
      code: "automation_suggestion_receipt_expired",
    });
  }
  const hasExpectedStudioId = Object.prototype.hasOwnProperty.call(expected, "studioId");
  const hasExpectedOperation = Object.prototype.hasOwnProperty.call(expected, "operation");
  const hasExpectedJobId = Object.prototype.hasOwnProperty.call(expected, "jobId");
  const hasExpectedRevision = Object.prototype.hasOwnProperty.call(expected, "baseConfigRevision");
  const expectedOperation = expected.operation === "update" ? "update" : "create";
  if (
    (hasExpectedOperation && claims.operation !== expectedOperation)
    || (hasExpectedStudioId && !sameNullableText(claims.studioId, expected.studioId))
    || (hasExpectedJobId && !sameNullableText(claims.jobId, expected.jobId))
    || (hasExpectedRevision && !sameNullableRevision(claims.baseConfigRevision, expected.baseConfigRevision))
  ) {
    throw Object.assign(new Error("automation suggestion receipt does not match this job"), {
      code: "automation_suggestion_receipt_mismatch",
    });
  }
  const { now: _now, ...publicClaims } = claims;
  return publicClaims;
}

export function consumeAutomationSuggestionReceipt(
  receipt: unknown,
  expected: Parameters<typeof inspectAutomationSuggestionReceipt>[1] = {},
) {
  const claims = inspectAutomationSuggestionReceipt(receipt, expected);
  RECEIPT_CLAIMS.delete(receipt as object);
  return claims;
}

/**
 * Finish a receipt that was already inspected synchronously by the committing
 * store. This deliberately performs no second TTL check: once the atomic write
 * succeeds, crossing the expiry boundary must not turn a committed mutation
 * into an apparent API failure.
 */
export function finalizeAutomationSuggestionReceipt(receipt: unknown) {
  if (!receipt || typeof receipt !== "object") return false;
  return RECEIPT_CLAIMS.delete(receipt as object);
}
