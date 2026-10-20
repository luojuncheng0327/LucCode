/**
 * splash-assets.mjs — 双 artifact 管线：splash 独立构建产物的运行时资源清单
 *
 * splash.html 归壳（vite.config.splash.ts）后不再共享 dist-renderer 里
 * copyLegacyFiles() 那份"整个 lib/modules/themes/assets/locales 目录全copy"
 * 的大而全逻辑——splash 只需要它自己在 SplashApp.tsx 里实际引用的东西：
 *
 * 1. modules/platform.js —— splash.html 用 <script src="modules/platform.js">
 *    直接引入（非 vite 处理的裸脚本），提供 window.platform（Electron 环境
 *    转发到 preload 的 window.luc；Web 环境走 HTTP fallback）。
 * 2. locales/*.json —— SplashApp 运行时才知道用户的 locale（IPC 查询得到），
 *    构建期无法预判要哪一份，因此把全部 locale 文件都带上。
 * 3. yuan 头像 PNG —— SplashApp 的默认头像 + getSplashInfo().yuan 对应的
 *    头像，来源是 shared/yuan-visuals.ts 的 YUAN_VISUALS（唯一真相源，这里
 *    不维护一份私有头像文件名列表，避免跟 SplashApp 实际读取的 avatar 字段
 *    脱节——项目规则：扩展名/资源清单类映射禁止维护私有拷贝）。
 *
 * 抽成独立、无 vite 依赖的纯函数是为了可以脱离真实 vite build 单测——
 * vite.config.splash.ts 的 closeBundle 钩子只是薄薄一层调用它。
 */
import fs from "fs";
import path from "path";
import { YUAN_VISUALS } from "../shared/yuan-visuals.ts";

/**
 * @param {{srcDir: string, outDir: string}} opts - srcDir: desktop/src；
 *   outDir: desktop/dist-splash（vite build 产出目录，已经含 splash.html +
 *   其 JS/CSS，这里只补运行时按需 fetch/script-src 的那几样）
 * @returns {{platformJs: boolean, locales: string[], avatars: string[]}}
 */
export function copySplashAssets({ srcDir, outDir }) {
  const copied = { platformJs: false, locales: [], avatars: [] };

  const platformJsSrc = path.join(srcDir, "modules", "platform.js");
  const platformJsDest = path.join(outDir, "modules", "platform.js");
  fs.mkdirSync(path.dirname(platformJsDest), { recursive: true });
  fs.copyFileSync(platformJsSrc, platformJsDest);
  copied.platformJs = true;

  const localesSrcDir = path.join(srcDir, "locales");
  const localesDestDir = path.join(outDir, "locales");
  fs.mkdirSync(localesDestDir, { recursive: true });
  for (const entry of fs.readdirSync(localesSrcDir)) {
    if (!entry.endsWith(".json")) continue;
    fs.copyFileSync(path.join(localesSrcDir, entry), path.join(localesDestDir, entry));
    copied.locales.push(entry);
  }

  const assetsSrcDir = path.join(srcDir, "assets");
  const assetsDestDir = path.join(outDir, "assets");
  fs.mkdirSync(assetsDestDir, { recursive: true });
  for (const visual of Object.values(YUAN_VISUALS)) {
    fs.copyFileSync(path.join(assetsSrcDir, visual.avatar), path.join(assetsDestDir, visual.avatar));
    copied.avatars.push(visual.avatar);
  }

  return copied;
}
