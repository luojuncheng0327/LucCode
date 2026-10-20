import { randomBytes } from "crypto";

const SESSION_ID_RANDOM_BYTES = 10;

export function generateSessionId(now = Date.now) {
  const timestamp = Number(now()).toString(36).padStart(9, "0");
  const random = randomBytes(SESSION_ID_RANDOM_BYTES).toString("hex");
  return `sess_${timestamp}_${random}`;
}

