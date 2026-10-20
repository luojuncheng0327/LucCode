/**
 * fs.js — 文件系统 API（Web 客户端用）
 *
 * Electron 环境下这些操作走 IPC（preload.cjs），
 * Web / 云部署环境下前端通过这些 HTTP 端点读取文件。
 *
 * 安全：路径限定在 ~/.luccode/ 和 desk 工作台内。
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeReadFile } from "../../shared/safe-fs.ts";

function isInsideRoot(candidatePath, rootPath) {
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + path.sep);
}

/**
 * 解析并校验文件路径。
 * - 现有文件：拒绝 symlink，且 realpath 后必须仍在 allowedRoots 内
 * - 不存在文件：保留原有 404 语义，只要其父目录 realpath 在 allowedRoots 内即可
 * @returns {string|null}
 */
function resolveAllowedPath(filePath, allowedRoots) {
  const resolved = path.resolve(filePath);

  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(root);
    if (!isInsideRoot(resolved, resolvedRoot)) continue;

    let realRoot = null;
    try { realRoot = fs.realpathSync(resolvedRoot); }
    catch { continue; }

    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink()) return null;
      const realPath = fs.realpathSync(resolved);
      if (isInsideRoot(realPath, realRoot)) return realPath;
      return null;
    } catch (err) {
      if (err?.code !== "ENOENT") return null;
      try {
        const realParent = fs.realpathSync(path.dirname(resolved));
        if (isInsideRoot(realParent, realRoot)) return resolved;
      } catch {
        return null;
      }
    }
  }

  return null;
}

function escapeHtmlCell(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function createFsRoute(engine) {
  const route = new Hono();
  const lucHome = path.resolve(engine.luccodeHome);

  /**
   * 收集允许的根目录：数据目录 + 全体 agent 的 desk 工作台（用户可能配在数据目录外面）。
   *
   * 这里不看请求里的 agentId。这条路由的鉴权边界只有 bearer token 一个——agentId
   * 是查询参数，任何拿得到 token 的客户端都能随便填，从来没有把谁挡在门外过。既然
   * 它不承担鉴权，就不该拿它去裁剪可读范围：那样只会让"没写 agentId 的请求"读不到
   * 本来就允许读的文件，而安全性一点没变。所以根取全体 agent 的并集。
   *
   * 每个请求现算：agent 可以在运行时增删，缓存会把删掉的 desk 留在白名单里。
   */
  function getAllowedRoots() {
    const roots = [lucHome];
    for (const entry of engine.listAgents?.() || []) {
      const agent = engine.getAgent?.(entry.id);
      if (!agent) continue;
      const deskHome = agent.config?.desk?.home_folder || engine.getHomeCwd?.(agent.id);
      if (deskHome) roots.push(path.resolve(deskHome));
    }
    return roots;
  }

  // GET /fs/read?path=... → UTF-8 文本
  route.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    const allowedPath = resolveAllowedPath(filePath, getAllowedRoots());
    if (!allowedPath) {
      return c.json({ error: "path not allowed" }, 403);
    }
    const content = safeReadFile(allowedPath, null);
    if (content === null) return c.json({ error: "file not found" }, 404);
    return c.text(content);
  });

  // GET /fs/read-base64?path=... → base64 编码
  route.get("/fs/read-base64", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    const allowedPath = resolveAllowedPath(filePath, getAllowedRoots());
    if (!allowedPath) {
      return c.json({ error: "path not allowed" }, 403);
    }
    try {
      const buf = fs.readFileSync(allowedPath);
      return c.text(buf.toString("base64"));
    } catch {
      return c.json({ error: "file not found" }, 404);
    }
  });

  // GET /fs/docx-html?path=... → mammoth 转 HTML
  route.get("/fs/docx-html", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    const allowedPath = resolveAllowedPath(filePath, getAllowedRoots());
    if (!allowedPath) {
      return c.json({ error: "path not allowed" }, 403);
    }
    try {
      const stat = fs.statSync(allowedPath);
      if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
      if (stat.size > 20 * 1024 * 1024) return c.json({ error: "file too large" }, 413);
      const mammoth = (await import("mammoth")).default;
      const result = await mammoth.convertToHtml({ path: allowedPath });
      return c.text(result.value);
    } catch (err) {
      if (err?.code === "ENOENT") return c.json({ error: "file not found" }, 404);
      return c.json({ error: "docx parse failed" }, 500);
    }
  });

  // GET /fs/xlsx-html?path=... → ExcelJS 转 HTML 表格
  route.get("/fs/xlsx-html", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    const allowedPath = resolveAllowedPath(filePath, getAllowedRoots());
    if (!allowedPath) {
      return c.json({ error: "path not allowed" }, 403);
    }
    try {
      const stat = fs.statSync(allowedPath);
      if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
      if (stat.size > 20 * 1024 * 1024) return c.json({ error: "file too large" }, 413);
      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(allowedPath);
      const sheet = workbook.worksheets[0];
      if (!sheet || sheet.rowCount === 0) return c.json({ error: "xlsx has no rows" }, 422);
      let html = "<table>";
      sheet.eachRow((row) => {
        html += "<tr>";
        for (let i = 1; i <= sheet.columnCount; i += 1) {
          html += `<td>${escapeHtmlCell(row.getCell(i).text)}</td>`;
        }
        html += "</tr>";
      });
      html += "</table>";
      return c.text(html);
    } catch (err) {
      if (err?.code === "ENOENT") return c.json({ error: "file not found" }, 404);
      return c.json({ error: "xlsx parse failed" }, 500);
    }
  });

  return route;
}
