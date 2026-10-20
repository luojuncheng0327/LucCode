/**
 * diary.js — 日记 REST API
 *
 * POST /api/diary/write — 生成当日日记
 * GET  /api/diary/list  — 列出已有日记
 */

import fs from "fs";
import { Hono } from "hono";
import { resolveDiaryDir } from "../../lib/diary/diary-writer.ts";
import { createModuleLogger } from "../../lib/debug-log.ts";

const log = createModuleLogger("diary");

export function createDiaryRoute(engine) {
  const route = new Hono();

  /** POST /diary/write — 触发日记生成 */
  route.post("/diary/write", async (c) => {
    try {
      let body: any = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const targetDate = typeof body?.targetDate === "string" ? body.targetDate : undefined;
      const result = await engine.writeDiary({ targetDate });
      if (result.error) {
        return c.json({
          error: result.error,
          ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        }, 400);
      }
      return c.json({
        filePath: result.filePath,
        content: result.content,
        logicalDate: result.logicalDate,
        ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      });
    } catch (err) {
      log.error(`write failed: ${err.message}`);
      return c.json({ error: err.message }, 500);
    }
  });

  /** GET /diary/list — 列出已有日记文件 */
  route.get("/diary/list", async (c) => {
    const cwd = engine.homeCwd || process.cwd();
    const diaryDir = resolveDiaryDir(cwd);
    try {
      const files = fs.readdirSync(diaryDir)
        .filter(f => f.endsWith(".md"))
        .sort()
        .reverse();
      return c.json({ files });
    } catch {
      return c.json({ files: [] });
    }
  });

  return route;
}
