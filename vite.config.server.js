import process from "node:process";
import { defineConfig } from "vite";
import { builtinModules } from "module";

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

// LUC_SERVER_BUNDLE_ENTRY lets a caller (scripts/build-server-phases.mjs's
// buildViteServerBundle) override which composition entry gets bundled,
// without this config file knowing anything about "open" vs "full" —
// scripts/build-server.mjs (full) never sets it, so the default below is
// unchanged; scripts/build-server-open.mjs sets it to server/main-open.ts.
const bundleEntry = process.env.LUC_SERVER_BUNDLE_ENTRY || "server/main-full.ts";

export default defineConfig({
  build: {
    lib: {
      // main-full.ts is the thin closed composition entry: it statically
      // imports server/index.ts's open startServer() plus
      // composition/full-root.ts's registerClosedRoutes hook, so the
      // packaged bundle still ships the full product (open + closed-product
      // routes). LUC_SERVER_BUNDLE_ENTRY overrides this for other
      // compositions (see the comment above).
      entry: bundleEntry,
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: "dist-server-bundle",
    rollupOptions: {
      external: [
        ...nodeBuiltins,
        "@node-rs/jieba",
        "better-sqlite3",
        "node-pty",

        // @firecrawl/anydoc: napi native addon. Its per-platform subpackage
        // declares the .node binary itself as "main", so bundling makes
        // Rollup parse Mach-O/ELF bytes as JavaScript. External also means
        // build-server installs it into the packaged server's node_modules
        // (this list is the source of truth for that install set).
        "@firecrawl/anydoc",

        // ws: CJS package, Rollup's CJS→ESM interop loses WebSocketServer
        // named export. Keep external — available as PI SDK transitive dep.
        "ws",
        /^@mariozechner\//,
        /^@earendil-works\//,
        "@silvia-odwyer/photon-node",
        "@larksuiteoapi/node-sdk",
        "node-telegram-bot-api",
        "proxy-agent",
        "undici",
        "exceljs",
        "mammoth",
        // jsdom: CJS package that reads package-local resources via __dirname
        // during initialization. Bundling it into the ESM server bundle breaks
        // packaged runtime startup because __dirname is not defined there.
        "jsdom",
        "fsevents",

        // qrcode: 有 browser/node 双入口，Vite 会选 browser 版（期望 DOM canvas）。
        // 服务端需要 Node.js 版（纯 JS 渲染），必须走 npm 原生解析。
        "qrcode",
      ],
      output: {
        // 所有源码模块全部合并到一个文件。
        // 这个项目 shared/core/lib/hub 之间交叉引用太多，
        // 任何 chunk 拆分都会导致循环依赖的 TDZ ReferenceError。
        inlineDynamicImports: true,
      },
    },
    target: "node24",
    // esbuild minify 只做标识符缩短和空白移除，不做 tree-shaking 变换，
    // 不会触发 inlineDynamicImports 场景下的 TDZ ReferenceError。
    minify: "esbuild",
    sourcemap: false,
  },
  logLevel: "info",
});
