import { createHmac, randomBytes } from "node:crypto";

import { redactLogText } from "../shared/log-redactor.ts";

const PROCESS_FINGERPRINT_KEY = randomBytes(32);
const FINGERPRINT_HEX_LENGTH = 16;

export interface SecretFingerprint {
  length: number;
  hmac: string;
}

function secretText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function safeLabel(value: unknown): string {
  return String(value || "secret").replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 48) || "secret";
}

/**
 * Produces a comparison-only fingerprint. The random process key means the
 * value cannot be correlated across restarts or used as a stable secret hash.
 */
export function fingerprintSecret(value: unknown): SecretFingerprint {
  const text = secretText(value);
  return {
    length: text.length,
    hmac: createHmac("sha256", PROCESS_FINGERPRINT_KEY)
      .update(text, "utf8")
      .digest("hex")
      .slice(0, FINGERPRINT_HEX_LENGTH),
  };
}

export function formatSecretFingerprintComparison({
  stage,
  beforeLabel,
  before,
  afterLabel,
  after,
}: {
  stage: string;
  beforeLabel: string;
  before: unknown;
  afterLabel: string;
  after: unknown;
}): string {
  const left = fingerprintSecret(before);
  const right = fingerprintSecret(after);
  const leftLabel = safeLabel(beforeLabel);
  const rightLabel = safeLabel(afterLabel);
  return [
    `credential_compare stage=${safeLabel(stage)}`,
    `${leftLabel}.length=${left.length}`,
    `${leftLabel}.hmac=${left.hmac}`,
    `${rightLabel}.length=${right.length}`,
    `${rightLabel}.hmac=${right.hmac}`,
    `match=${left.length === right.length && left.hmac === right.hmac}`,
  ].join(" ");
}

/** Replaces exact known secrets before applying the generic log redactor. */
export function redactSecretsFromText(value: unknown, secrets: unknown[] = []): string {
  let text = secretText(value);
  for (const secret of secrets) {
    const candidate = secretText(secret);
    if (candidate) text = text.split(candidate).join("[redacted]");
  }
  return redactLogText(text);
}
