import fs from "fs";
import os from "os";
import path from "path";

function basenameForUpload(value, fallback = "skill.skill") {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const name = path.basename(raw).replace(/[\r\n]/g, "").trim();
  return name || fallback;
}

function decodeUploadedFileBody(body) {
  const file = body?.file && typeof body.file === "object" && !Array.isArray(body.file)
    ? body.file
    : body;
  const contentBase64 = typeof file?.contentBase64 === "string" && file.contentBase64.trim()
    ? file.contentBase64.trim()
    : null;
  if (!contentBase64) return null;
  return {
    filename: basenameForUpload(file?.filename || file?.name, "skill.skill"),
    contentBase64,
  };
}

export function materializeUploadedSkillPackage(engine, body) {
  const upload = decodeUploadedFileBody(body);
  if (!upload) return null;
  const base64 = upload.contentBase64.includes(",")
    ? upload.contentBase64.split(",").pop()
    : upload.contentBase64;
  const buffer = Buffer.from(String(base64 || ""), "base64");
  if (buffer.byteLength === 0) {
    const err: any = new Error("uploaded skill package is empty");
    err.status = 400;
    throw err;
  }
  const uploadRoot = path.join(engine?.luccodeHome || os.tmpdir(), "tmp", "skill-install-uploads");
  fs.mkdirSync(uploadRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(uploadRoot, "skill-"));
  const sourcePath = path.join(tempDir, upload.filename);
  fs.writeFileSync(sourcePath, buffer);
  return {
    sourcePath,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}
