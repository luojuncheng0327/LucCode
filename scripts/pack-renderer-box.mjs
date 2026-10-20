/**
 * pack-renderer-box.mjs — CI 单点构建 renderer 热更新归档
 *
 * 背景：renderer 归档（desktop/dist-renderer/ 树打包而成的 renderer-<version>.tar.gz）
 * 是纯 web 静态资源，构建结果平台无关。但 packTree 在 tar 头里写入真实文件
 * mtime，过去四个平台 CI runner（macOS arm64 / macOS x64 / Windows / Linux）各自
 * 现场打包，产生"内容相同、字节不同、sha256 不同"的四份归档——发布货架上只
 * 上传其中一份（mac-arm64），而每个安装包里内嵌的种子却是各自 runner 自己
 * 那份，导致"全新安装后本地种子哈希与货架永远不一致"的生产事故。
 *
 * 修法：由这个独立脚本在 CI 的单点 renderer-box job 里跑一次，产出唯一一份
 * renderer-<version>.tar.gz，四个平台的构建 job 下载同一份字节复用（见
 * scripts/build-server-artifact.mjs 的 packDualKindSeed 的 prebuiltRendererArchive /
 * LUC_PREBUILT_RENDERER_BOX 入参）。本脚本只做"打包 + 打印摘要"，不做签名——
 * renderer 归档的签名对象是 seed manifest（各平台各自生成、各自签），不是归档
 * 本身。
 *
 * 前置条件：desktop/dist-renderer/ 必须已经就绪，即先跑过
 *   npm run build:renderer && npm run build:theme
 * （顺序不能颠倒：build:theme 的产物写进 dist-renderer/lib/theme.js，
 * 必须在 build:renderer 的 emptyOutDir 清空该目录之后才落地——见
 * vite.config.theme.js 文件头注释）。
 *
 * 用法：node scripts/pack-renderer-box.mjs
 * 输出：dist-renderer-artifact/renderer-<version>.tar.gz
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { packRendererArtifact } from "./build-server-artifact.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));

const rendererDistDir = path.join(ROOT, "desktop", "dist-renderer");
const artifactOutDir = path.join(ROOT, "dist-renderer-artifact");

const result = await packRendererArtifact({
  rendererDistDir,
  artifactOutDir,
  version: rootPkg.version,
  log: console.log,
});

console.log(`[pack-renderer-box] archive: ${result.archiveName}`);
console.log(`[pack-renderer-box] sha256:  ${result.sha256}`);
console.log(`[pack-renderer-box] size:    ${result.size} bytes`);
console.log(`[pack-renderer-box] path:    ${result.archivePath}`);
