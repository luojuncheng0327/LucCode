import path from 'path';
import type { Plugin } from 'vite';

/**
 * CSP 集中管理：
 * 所有窗口的 CSP 策略统一定义在此，Vite 构建/开发时注入。
 * HTML 源文件中保留 CSP meta tag 作为 fallback（loadFile 回退路径）。
 *
 * 修改 CSP 时只改这里，然后同步更新 HTML 源文件。
 *
 * 这个文件原先内联在 vite.config.ts；splash 启用独立构建后，
 * 拥有自己独立的构建配置（vite.config.splash.ts，产出 desktop/dist-splash/，
 * 不再随 dist-renderer 打包进 asar），splash.html 的 CSP profile 需要被两份
 * 构建配置共享，不能只活在主配置文件里。
 */
export const CSP_PROFILES: Record<string, string> = {
  // 主窗口：需要 API 连接、图片、字体（KaTeX）、iframe（artifacts）
  'index.html':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; frame-src blob: data: file: http://127.0.0.1:* http://localhost:*",
  // 设置窗口：需要 API 连接、图片、字体
  'settings.html':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
  // Quick Chat：独立小窗，需要 API/WS、附件预览图片
  'quick-chat.html':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: blob: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
  // Onboarding：需要 API 连接、图片、字体
  'onboarding.html':
    "default-src 'self'; connect-src 'self' http: https: ws: wss:; img-src 'self' data: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
  // 以下窗口不加载第三方字体，保持严格策略
  'splash.html':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' file:",
  'browser-viewer.html':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' file:",
  'viewer-window.html':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: file:",
  'mobile.html':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; frame-src 'self' blob:",
};

export function injectCsp(): Plugin {
  return {
    name: 'luc-inject-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const filename = path.basename(ctx.filename);
        const profile = CSP_PROFILES[filename];
        if (!profile) return html;

        let csp = profile;
        // Dev 模式放宽：React Refresh 需要 unsafe-inline，Vite HMR 需要 ws
        if (process.env.NODE_ENV !== 'production') {
          csp = csp.replace(
            /script-src 'self'/,
            "script-src 'self' 'unsafe-inline'",
          );
          if (csp.includes('connect-src')) {
            csp = csp.replace(
              /connect-src 'self'/,
              "connect-src 'self' ws://localhost:5173",
            );
          }
        }

        return html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/,
          `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
        );
      },
    },
  };
}
