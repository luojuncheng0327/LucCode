import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { denyWithoutScope } from "../http/capability-guard.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";

export function createSpeechRecognitionRoute(engine) {
  const route = new Hono();

  route.get("/speech-recognition/providers", async (c) => {
    try {
      const service = requireSpeechRecognitionService(engine);
      return c.json(service.listProviders());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/speech-recognition/config", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const body = await safeJson(c);
      const values = body?.values && typeof body.values === "object" && !Array.isArray(body.values)
        ? body.values
        : body;
      const service = requireSpeechRecognitionService(engine);
      const config = service.setConfig(values || {});
      recordSecurityAuditEvent(c, engine, {
        action: "settings.speechRecognition.update",
        target: "speechRecognition",
        metadata: { enabled: config.enabled === true },
      });
      return c.json({ ok: true, config });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  return route;
}

function requireSpeechRecognitionService(engine) {
  if (!engine?.speechRecognition) {
    throw new Error("speech recognition service unavailable");
  }
  return engine.speechRecognition;
}
