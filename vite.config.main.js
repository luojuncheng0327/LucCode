import fs from "fs";
import path from "path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { builtinModules } from "module";

// This file is a real ES module ("type": "module" in package.json) — no
// ambient __dirname, unlike vite.config.ts (CJS-transpiled by vite's own
// config loader). Derive it explicitly, same as vitest.config.js does.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

// ── LUC_SIGN_KEYSET：构建期 keyset 替换（签名 seed 管线）──
// keyset.cjs 里 `require("./pinned-keyset.json")` 会被本 bundle 内联——
// keyset 随主进程 bundle 一起被 codesign，不作为松散资源存在。设置
// LUC_SIGN_KEYSET=<path> 时，把该 JSON 模块替换为指定文件（本地验证用
// 一次性测试密钥对时，让打进构建的 keyset 与 seed 签名自洽）。这是构建期
// 输入，不是运行期校验旁路：运行时永远读被内联进 bundle 的那份。正式发版
// 不设置此变量，默认内联 repo 的 shared/artifact-core/pinned-keyset.json。
const signKeysetOverride = process.env.LUC_SIGN_KEYSET;
const mainAliases = [];
if (signKeysetOverride) {
  const overridePath = path.resolve(signKeysetOverride);
  if (!fs.existsSync(overridePath)) {
    throw new Error(`[vite.config.main] LUC_SIGN_KEYSET points at a missing file: ${overridePath}`);
  }
  // 匹配以 pinned-keyset.json 结尾的完整 specifier（keyset.cjs 内的相对
  // require 以及任何已解析的绝对形态），整串替换为覆盖文件的绝对路径——
  // 部分替换会把 "./" 前缀残留拼进结果。仓库里只有这一个同名文件。
  mainAliases.push({ find: /^.*pinned-keyset\.json$/, replacement: overridePath });
}

// ── OTA dev-bypass 常量折叠（后台 OTA）──
// artifact-ota.cjs 的 LUC_ARTIFACT_MANIFEST 排练开关只活在
// artifact-ota-dev-bypass.cjs 一个文件里（该文件自己的头注释解释了为什么
// 这条 require 必须是静态字面量）。这条别名对*任何一次* `vite build` 都无
// 条件生效——不像上面的 keysetAlias 只在设了 LUC_SIGN_KEYSET 时才替换：
// 一次用测试密钥的本地 pack 构建仍然是同一条能被启动、能被公证、理论上能
// 被分发的构建管线产出，dev-bypass 必须在这条管线的*任何*产物里都不可见
// （`grep LUC_ARTIFACT_MANIFEST desktop/main.bundle.cjs` 必须查无此文件）。
// 想排练 OTA 全流程只能跑未打包的 `desktop/main.cjs`（dev 模式，
// `app.isPackaged === false`，bootstrap.cjs 走源文件而不是这份 bundle，
// 这条别名完全不适用）。
mainAliases.push({
  // 锚定整串（跟上面 keysetAlias 同一条纪律）：只匹配文件名后缀会把
  // require("./artifact-ota-dev-bypass.cjs") 里残留的 "./" 前缀原样拼进
  // 替换结果，产出 ".//abs/path" 这种坏路径——rollup-plugin-alias 对
  // RegExp find 做的是整串 `importee.replace(find, replacement)`。
  find: /^.*artifact-ota-dev-bypass\.cjs$/,
  replacement: path.resolve(__dirname, "desktop/src/shared/artifact-ota-dev-bypass.prod-stub.cjs"),
});

export default defineConfig({
  build: {
    lib: {
      entry: "desktop/main.cjs",
      formats: ["cjs"],
      fileName: () => "main.bundle.cjs",
    },
    // Output to the same directory as source — preserves __dirname semantics
    // (main.cjs uses __dirname extensively for preload, assets, locales, etc.)
    outDir: "desktop",
    emptyOutDir: false,
    rollupOptions: {
      external: [
        "electron",
        ...nodeBuiltins,

        // ws: CJS native addon (bufferutil/utf-8-validate) breaks when bundled.
        // Keep external — Electron runtime resolves from node_modules.
        "ws",

        // mammoth / exceljs: large CJS deps with deep dependency trees.
        // Kept external — electron-builder includes them from node_modules.
        "mammoth",
        "exceljs",
      ],
    },
    target: "node24",
    minify: "esbuild",
    sourcemap: false,
  },

  // Force Node.js resolution: include "node" condition and exclude "browser"
  // to prevent ws and similar packages from resolving to browser stubs.
  resolve: {
    conditions: ["node", "import", "module", "require", "default"],
    mainFields: ["main", "module"],
    alias: mainAliases,
  },
});
