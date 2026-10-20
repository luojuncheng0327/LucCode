import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { injectCsp } from './vite.csp-profiles';

interface DevWebClientConfig {
  serverPort: string;
  apiBaseUrl: string;
}

/**
 * 保留旧 CSS link 标签：
 * Vite 默认会把 <link rel="stylesheet" href="..."> 打包进 bundle。
 * 渐进迁移期间，styles.css 和 themes/*.css 必须保持为独立文件
 * （theme.js 运行时动态切换 themeSheet 的 href）。
 *
 * 做法：在 HTML 处理前把旧 CSS link 替换成占位符，build 后再还原。
 */
function preserveLegacyCss(): Plugin {
  const CSS_PLACEHOLDER_RE = /<!--LUC_CSS:(.*?)-->/g;
  return {
    name: 'luc-preserve-legacy-css',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // 把 <link rel="stylesheet" href="..."> 替换成 HTML 注释占位符
        // 保留 id 等属性
        return html.replace(
          /<link\s+rel="stylesheet"\s+href="([^"]+)"([^>]*)>/g,
          (_match, href, rest) => `<!--LUC_CSS:${href}${rest}-->`
        );
      },
    },
  };
}

function restoreLegacyCss(): Plugin {
  return {
    name: 'luc-restore-legacy-css',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // 把占位符还原为 <link> 标签
        return html.replace(
          /<!--LUC_CSS:(.*?)-->/g,
          (_match, content) => {
            // content 是 "styles.css" 或 "themes/warm-paper.css" id="themeSheet"
            const parts = content.split(/\s+/);
            const href = parts[0];
            const rest = parts.slice(1).join(' ');
            return `<link rel="stylesheet" href="${href}"${rest ? ' ' + rest : ''}>`;
          }
        );
      },
    },
  };
}

/**
 * Vite dev server 直接服务 source HTML 时，theme helper 不能再依赖 dist-renderer/lib/theme.js。
 * 开发模式把旧 script 标签重写到 source theme.ts，保持和 build:theme 同一份实现。
 */
function useSourceThemeInDev(): Plugin {
  return {
    name: 'luc-use-source-theme-in-dev',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(
          /<script\s+src="lib\/theme\.js"><\/script>/g,
          '<script type="module" src="/shared/theme.ts"></script>',
        );
      },
    },
  };
}

function readDevWebClientConfig(): DevWebClientConfig | null {
  if (process.env.LUC_DEV_WEB !== '1') return null;
  const apiBaseUrl = process.env.LUC_DEV_WEB_API_BASE_URL?.trim();
  if (!apiBaseUrl) {
    throw new Error('LUC_DEV_WEB requires LUC_DEV_WEB_API_BASE_URL');
  }
  const parsed = new URL(apiBaseUrl);
  const serverPort = process.env.LUC_DEV_WEB_CLIENT_PORT?.trim() || parsed.port;
  if (!serverPort) {
    throw new Error('LUC_DEV_WEB requires LUC_DEV_WEB_CLIENT_PORT or a port in LUC_DEV_WEB_API_BASE_URL');
  }
  return { serverPort, apiBaseUrl };
}

/**
 * Browser-only dev entry for Codex Preview.
 * Electron keeps using preload; this injects only the Vite-facing browser
 * endpoint when scripts/dev-web.js starts Vite with LUC_DEV_WEB=1. The
 * loopback owner token stays in the Vite proxy environment.
 */
function injectDevWebConfig(): Plugin {
  return {
    name: 'luc-inject-dev-web-config',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (path.basename(ctx.filename) !== 'index.html') return html;
        const config = readDevWebClientConfig();
        if (!config) return html;
        const payload = JSON.stringify(config).replace(/</g, '\\u003c');
        return html.replace(
          '</head>',
          `<script>window.__LUC_DEV_WEB__=${payload};</script>\n</head>`,
        );
      },
    },
  };
}

/**
 * Vite dev only: synthesize an ESM `default` export for project-owned
 * CommonJS `.cjs` files when they get pulled into the browser graph.
 *
 * Several shared/*.cjs modules are the single Node-side source of truth (the
 * desktop shell raw-`require`s them from a plain CommonJS main.cjs, so they
 * cannot become .ts/.mjs), and thin shared/*.ts wrappers re-export them for the
 * renderer via `import x from './x.cjs'` (default import + destructure).
 * Production bundles synthesize the CJS→ESM default export through Rollup, but
 * Vite's dev server serves source .cjs individually WITHOUT synthesizing one,
 * so in dev the default import resolves to nothing and the entire static import
 * graph fails silently — no console error, and the module's top-level code
 * (including main.tsx) never executes. This closes that dev-only gap.
 *
 * Only PURE .cjs (no `require`, no Node builtins) can actually run in a browser.
 * If a .cjs that reaches the browser graph uses require(), we throw loudly
 * instead of shipping a broken module: such a file must move its constants to
 * JSON (see shared/contract-versions.json) or split its Node-only logic out —
 * silently degrading would just reproduce the invisible-failure this fixes.
 */
function browserCjsDefaultInterop(): Plugin {
  return {
    name: 'luc-browser-cjs-default-interop',
    apply: 'serve',
    enforce: 'pre',
    transform(code, id, options) {
      // Real dev-server browser context only. Vitest runs a Node-based module
      // runner (even under jsdom) that resolves CommonJS natively, so this
      // interop is both unnecessary and unsafe there — its require()-guard's
      // premise ("a browser cannot require()") does not hold for the vitest
      // runner and would spuriously throw on a legitimately CJS-importing test.
      if (process.env.VITEST) return null;
      if (options?.ssr) return null;
      const filePath = id.split('?')[0];
      if (!filePath.endsWith('.cjs')) return null;
      if (filePath.includes('/node_modules/')) return null;
      if (/\brequire\s*\(/.test(code)) {
        const rel = path.relative(__dirname, filePath);
        throw new Error(
          `[luc-browser-cjs-default-interop] ${rel} is imported into the browser graph but uses require(); ` +
          `browser-graph .cjs must be pure — move constants to JSON or split Node-only logic out.`,
        );
      }
      // Provide CJS `module`/`exports` bindings, run the original body, then
      // expose the result as the ESM default the .ts wrappers import.
      return {
        code: `const module = { exports: {} };\nconst exports = module.exports;\n${code}\nexport default module.exports;`,
        map: null,
      };
    },
  };
}

function serveMobilePwaStaticFiles(): Plugin {
  const srcDir = path.resolve(__dirname, 'desktop/src');
  const filesByUrl = new Map<string, { file: string; contentType: string }>([
    ['/sw.js', { file: path.join(srcDir, 'mobile-sw.js'), contentType: 'application/javascript; charset=utf-8' }],
    ['/manifest.webmanifest', { file: path.join(srcDir, 'mobile-manifest.webmanifest'), contentType: 'application/manifest+json; charset=utf-8' }],
    ['/icon.png', { file: path.join(srcDir, 'icon.png'), contentType: 'image/png' }],
  ]);

  return {
    name: 'luc-serve-mobile-pwa-static-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        // 带 query string 的请求（如 /icon.png?import）属于 Vite 的资源转换管线：
        // AboutTab 的 `import appIconUrl from '../../../icon.png'` 需要 Vite 把 icon.png
        // 转成返回 URL 字符串的 JS 模块（MIME text/javascript）。若在此按裸路径命中并回
        // image/png，type="module" 脚本的严格 MIME 校验会失败，整个静态 import 图崩掉，
        // main.tsx 一行都跑不起来。只有裸路径的直接请求（PWA 注册的 sw.js / manifest /
        // 图标）才由本中间件回原始字节，其余一律放行给 Vite 自己处理。
        if (url.includes('?')) {
          next();
          return;
        }
        const asset = filesByUrl.get(url);
        if (!asset) {
          next();
          return;
        }
        fs.readFile(asset.file, (err, data) => {
          if (err) {
            next(err);
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', asset.contentType);
          res.setHeader('Cache-Control', 'no-cache');
          res.end(data);
        });
      });
    },
  };
}

function createDevWebProxy(): Record<string, ProxyOptions> | undefined {
  if (process.env.LUC_DEV_WEB !== '1') return undefined;
  const target = process.env.LUC_DEV_WEB_SERVER_URL?.trim();
  const token = process.env.LUC_DEV_WEB_SERVER_TOKEN?.trim();
  if (!target || !token) {
    throw new Error('LUC_DEV_WEB proxy requires LUC_DEV_WEB_SERVER_URL and LUC_DEV_WEB_SERVER_TOKEN');
  }
  const auth = `Bearer ${token}`;
  const targetUrl = new URL(target);
  const wsTarget = `${targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${targetUrl.host}`;

  const withAuth = (proxyTarget: string, extra: ProxyOptions = {}): ProxyOptions => ({
    target: proxyTarget,
    changeOrigin: true,
    ...extra,
    headers: {
      ...(extra.headers || {}),
      Authorization: auth,
    },
    configure(proxy, options) {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.setHeader('Authorization', auth);
      });
      proxy.on('proxyReqWs', (proxyReq) => {
        proxyReq.setHeader('Authorization', auth);
      });
      extra.configure?.(proxy, options);
    },
  });

  return {
    '/api': withAuth(target),
    '/preview': withAuth(target),
    '/ws': withAuth(wsTarget, { ws: true }),
  };
}

/**
 * Build 后复制旧文件到 dist-renderer/：
 * 旧 JS 模块、CSS、主题、资源、语言包等，
 * 在渐进迁移完成前还需要从 dist-renderer/ 加载。
 */
function copyLegacyFiles(): Plugin {
  return {
    name: 'luc-copy-legacy-files',
    closeBundle() {
      const srcDir = path.resolve(__dirname, 'desktop/src');
      const outDir = path.resolve(__dirname, 'desktop/dist-renderer');

      const dirs = ['lib', 'modules', 'themes', 'assets', 'locales'];
      const files = ['styles.css', 'animations.css', 'mobile-manifest.webmanifest', 'mobile-sw.js', 'icon.png'];

      for (const dir of dirs) {
        const src = path.join(srcDir, dir);
        const dest = path.join(outDir, dir);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true });
        }
      }

      for (const file of files) {
        const src = path.join(srcDir, file);
        const destName = file === 'mobile-manifest.webmanifest'
          ? 'manifest.webmanifest'
          : file === 'mobile-sw.js'
          ? 'sw.js'
          : file;
        const dest = path.join(outDir, destName);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest);
        }
      }
    },
  };
}

export default defineConfig({
  root: 'desktop/src',
  base: './',
  plugins: [
    browserCjsDefaultInterop(),
    preserveLegacyCss(),
    react(),
    injectCsp(),
    injectDevWebConfig(),
    serveMobilePwaStaticFiles(),
    useSourceThemeInDev(),
    restoreLegacyCss(),
    copyLegacyFiles(),
  ],
  resolve: {
    alias: {
      '@luccode/plugin-protocol': path.resolve(__dirname, 'packages/plugin-protocol/src/index.ts'),
      '@luccode/plugin-sdk': path.resolve(__dirname, 'packages/plugin-sdk/src/index.ts'),
      '@luccode/plugin-runtime': path.resolve(__dirname, 'packages/plugin-runtime/src/index.ts'),
      '@luccode/plugin-components': path.resolve(__dirname, 'packages/plugin-components/src/index.ts'),
      '@': path.resolve(__dirname, 'desktop/src/react'),
    },
  },
  css: {
    modules: {
      // luc-* 是 animations.css 全局 keyframe 命名空间，不要被 CSS Modules hash 化。
      // 否则模块文件里的 animation: luc-popout 会变成 animation: _luc-popout_xxxx，
      // 跟全局 @keyframes luc-popout 对不上，浏览器静默忽略，动画完全不会播。
      generateScopedName(name: string, filename: string): string {
        if (name.startsWith('luc-')) return name;
        const hash = crypto.createHash('md5').update(filename + '|' + name).digest('hex').slice(0, 5);
        return `_${name}_${hash}`;
      },
    },
  },
  build: {
    outDir: '../dist-renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'desktop/src/index.html'),
        mobile: path.resolve(__dirname, 'desktop/src/mobile.html'),
        settings: path.resolve(__dirname, 'desktop/src/settings.html'),
        'quick-chat': path.resolve(__dirname, 'desktop/src/quick-chat.html'),
        onboarding: path.resolve(__dirname, 'desktop/src/onboarding.html'),
        // splash 不在这里：启用双 artifact 管线后它是壳自持表面，独立构建进
        // desktop/dist-splash/（见 vite.config.splash.ts），不随 dist-renderer
        // 打包进 asar，也不随 renderer artifact 一起走首启解压/OTA 那条路。
        // dev 模式不受影响——vite dev server 按目录直接服务 splash.html，
        // 不依赖这份 rollupOptions.input 列表。
        'browser-viewer': path.resolve(__dirname, 'desktop/src/browser-viewer.html'),
        'viewer-window': path.resolve(__dirname, 'desktop/src/viewer-window.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: createDevWebProxy(),
  },
  test: {
    root: path.resolve(__dirname),
  },
});
