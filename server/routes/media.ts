import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { denyWithoutScope } from "../http/capability-guard.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

export function createMediaRoute(engine) {
  const route = new Hono();

  route.post("/media/generate", async (c) => {
    try {
      const body = await safeJson(c);
      const result = await requireMediaManager(engine).generateMedia(body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/media/image/generate", async (c) => {
    try {
      const body = await safeJson(c);
      const result = await requireMediaManager(engine).generateImageFromBus(body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/media/video/generate", async (c) => {
    try {
      const body = await safeJson(c);
      const result = await requireMediaManager(engine).generateVideoFromBus(body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/media/asr/transcribe", async (c) => {
    try {
      const body = await safeJson(c);
      const result = await requireMediaManager(engine).transcribeAudio(body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.get("/media/providers", async (c) => {
    try {
      const capability = c.req.query("capability") || "image_generation";
      if (capability === "speech_recognition" || capability === "asr" || capability === "transcription") {
        return c.json(requireSpeechRecognitionService(engine).listProviders());
      }
      if (capability === "video_generation" || capability === "video" || capability === "videoGeneration") {
        return c.json(await requireMediaManager(engine).listVideoProviders());
      }
      return c.json(await requireMediaManager(engine).listImageProviders());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/media/image/providers", async (c) => {
    try {
      return c.json(await requireMediaManager(engine).listImageProviders());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/media/video/providers", async (c) => {
    try {
      return c.json(await requireMediaManager(engine).listVideoProviders());
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.put("/media/image/config", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const body = await safeJson(c);
      const values = decodeConfigValues(body?.values && typeof body.values === "object" && !Array.isArray(body.values)
        ? body.values
        : body);
      const config = requireMediaManager(engine).setImageConfig(values);
      recordSecurityAuditEvent(c, engine, {
        action: "settings.imageGeneration.update",
        target: "imageGeneration",
        metadata: {
          hasDefaultImageModel: Boolean(config.defaultImageModel),
        },
      });
      return c.json({ ok: true, config, values: config });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.put("/media/video/config", async (c) => {
    try {
      const denied = denyWithoutScope(c, "settings.write");
      if (denied) return denied;
      const body = await safeJson(c);
      const values = decodeConfigValues(body?.values && typeof body.values === "object" && !Array.isArray(body.values)
        ? body.values
        : body);
      const config = requireMediaManager(engine).setVideoConfig(values);
      recordSecurityAuditEvent(c, engine, {
        action: "settings.videoGeneration.update",
        target: "videoGeneration",
        metadata: {
          hasDefaultVideoModel: Boolean(config.defaultVideoModel),
        },
      });
      return c.json({ ok: true, config, values: config });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/media/image/providers/:providerId/models", async (c) => {
    try {
      const denied = denyWithoutScope(c, "providers.manage");
      if (denied) return denied;
      const providerId = c.req.param("providerId");
      const body = await safeJson(c);
      const model = body?.model || body;
      const result = await requireMediaManager(engine).setImageProviderModel(providerId, model);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.post("/media/video/providers/:providerId/models", async (c) => {
    try {
      const denied = denyWithoutScope(c, "providers.manage");
      if (denied) return denied;
      const providerId = c.req.param("providerId");
      const body = await safeJson(c);
      const model = body?.model || body;
      const result = await requireMediaManager(engine).setVideoProviderModel(providerId, model);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.delete("/media/image/providers/:providerId/models/:modelId", async (c) => {
    try {
      const denied = denyWithoutScope(c, "providers.manage");
      if (denied) return denied;
      const result = await requireMediaManager(engine).removeImageProviderModel(
        c.req.param("providerId"),
        c.req.param("modelId"),
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.delete("/media/video/providers/:providerId/models/:modelId", async (c) => {
    try {
      const denied = denyWithoutScope(c, "providers.manage");
      if (denied) return denied;
      const result = await requireMediaManager(engine).removeVideoProviderModel(
        c.req.param("providerId"),
        c.req.param("modelId"),
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  route.get("/media/tasks/batch/:batchId", (c) => {
    try {
      const tasks = requireMediaManager(engine).getTasksByBatch(c.req.param("batchId"));
      return c.json({ tasks });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/media/tasks", (c) => {
    try {
      const tasks = requireMediaManager(engine).listTasks({
        filter: c.req.query("filter"),
      });
      return c.json({ tasks });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/media/tasks/:taskId/retry", async (c) => {
    try {
      const denied = denyWithoutScope(c, "providers.manage");
      if (denied) return denied;
      const result = await requireMediaManager(engine).retryImageTask(c.req.param("taskId"));
      if (!result.ok) return c.json({ error: result.error }, result.status || 500);
      return c.json({
        ok: true,
        taskId: result.taskId,
        placeholder: result.placeholder,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/media/tasks/:taskId", (c) => {
    try {
      const task = requireMediaManager(engine).getTask(c.req.param("taskId"));
      if (!task) return c.json({ error: "not found" }, 404);
      return c.json({ task });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/media/generated/:filename", async (c) => serveGeneratedMedia(c, engine));

  route.post("/media/generated/open/:filename", async (c) => {
    try {
      const filePath = requireMediaManager(engine).generatedFilePath(c.req.param("filename"));
      try { fs.statSync(filePath); } catch { return c.json({ error: "not found" }, 404); }
      await openWithSystem(filePath);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message || "failed to open file" }, 500);
    }
  });

  return route;
}

function requireMediaManager(engine) {
  if (!engine?.media) throw new Error("media manager unavailable");
  return engine.media;
}

function requireSpeechRecognitionService(engine) {
  if (!engine?.speechRecognition) throw new Error("speech recognition service unavailable");
  return engine.speechRecognition;
}

function decodeConfigValues(values: any = {}) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === null ? undefined : value]),
  );
}

async function serveGeneratedMedia(c, engine) {
  const filename = c.req.param("filename");
  let filePath;
  try {
    filePath = requireMediaManager(engine).generatedFilePath(filename);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }

  let stat;
  try { stat = fs.statSync(filePath); } catch { return c.json({ error: "not found" }, 404); }

  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  const total = stat.size;
  const range = c.req.header("range");

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) return c.json({ error: "invalid range" }, 416);
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : total - 1;
    if (start > end || start < 0 || end >= total) return c.json({ error: "invalid range" }, 416);
    const stream = fs.createReadStream(filePath, { start, end });
    const { readable, writable } = new TransformStream();
    streamPipe(stream, writable);
    return new Response(readable, {
      status: 206,
      headers: {
        "Content-Type": mime,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  const stream = fs.createReadStream(filePath);
  const { readable, writable } = new TransformStream();
  streamPipe(stream, writable);
  return new Response(readable, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

function openWithSystem(filePath) {
  return new Promise<void>((resolve, reject) => {
    let cmd, args;
    if (process.platform === "darwin") {
      cmd = "open"; args = [filePath];
    } else if (process.platform === "win32") {
      cmd = "cmd"; args = ["/c", "start", "", filePath];
    } else {
      cmd = "xdg-open"; args = [filePath];
    }
    execFile(cmd, args, (err) => err ? reject(err) : resolve());
  });
}

function streamPipe(nodeStream, writable) {
  const writer = writable.getWriter();
  nodeStream.on("data", (chunk) => writer.write(chunk));
  nodeStream.on("end", () => writer.close());
  nodeStream.on("error", () => writer.close());
}
