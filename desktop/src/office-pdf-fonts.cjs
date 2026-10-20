/**
 * office PDF 渲染的 Luc 字体注入素材。
 *
 * PDF helper 的 Chromium 窗口加载的是裸 HTML，app 打包字体不在系统字体表里，
 * 不注入则 printToPDF 嵌入的是回退字体（宋体 / Times）。本模块从字体 CSS
 * 真值源提取白名单字体族的 @font-face，把相对 url 重写为绝对 file:// URL，
 * 供 helper 以 insertCSS 注入；Chromium 按 unicode-range 惰性加载，printToPDF
 * 只嵌实际用到的字形子集。
 *
 * 无 electron 依赖，可直接被 vitest 加载。
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const FONTS_CSS_FILENAME = "new-warm-paper-fonts.css";

// 生成 HTML 的衬线 / 等宽字体栈实际引用的三族；UI 无衬线走 system-ui，无需注入。
const LUC_PDF_FONT_FAMILIES = ["EB Garamond", "Noto Serif SC", "JetBrains Mono"];

/**
 * 未注入 renderer artifact 路径时，字体 CSS 的兼容候选目录：
 * - 开发：desktop/src/themes/（源文件，永远最新）
 * - 旧布局：desktop/dist-renderer/themes/（保留给曾把 renderer 放在 app 树内的版本）
 *
 * 当前打包布局的 renderer 是独立 artifact，不在 asar 内；生产路径由 Desktop
 * 通过 LUC_RENDERER_DIST 显式注入，不能在这里从相对位置猜测。
 */
function defaultThemesDirCandidates() {
  return [
    path.join(__dirname, "themes"),
    path.join(__dirname, "..", "dist-renderer", "themes"),
  ];
}

function hasFontsCss(dir) {
  try {
    return fs.statSync(path.join(dir, FONTS_CSS_FILENAME)).isFile();
  } catch {
    return false;
  }
}

function locateThemesDir(candidates = defaultThemesDirCandidates()) {
  for (const dir of candidates) {
    if (hasFontsCss(dir)) return dir;
  }
  throw new Error(
    `Luc font css (${FONTS_CSS_FILENAME}) not found; looked in: ${candidates.join(", ")}. ` +
    "Run build:renderer or check the packaged resources.",
  );
}

/**
 * 解析当前进程应该使用的 themes 目录。
 *
 * LUC_RENDERER_DIST 一旦注入就是生产真值源：错误指针必须显式失败，不能
 * 静默退回源码或旧 renderer，否则 PDF 会悄悄使用与当前激活内容不一致的字体。
 * 只有完全未注入时，才允许开发 / 旧布局候选。
 */
function resolveThemesDir({ env = process.env, fallbackCandidates = defaultThemesDirCandidates() } = {}) {
  const injected = env?.LUC_RENDERER_DIST;
  if (injected !== undefined) {
    const rendererDist = String(injected).trim();
    if (!rendererDist || !path.isAbsolute(rendererDist)) {
      throw new Error(`LUC_RENDERER_DIST must be an absolute path: ${injected}`);
    }
    const themesDir = path.join(rendererDist, "themes");
    const cssPath = path.join(themesDir, FONTS_CSS_FILENAME);
    if (!hasFontsCss(themesDir)) {
      throw new Error(
        `LUC_RENDERER_DIST is set to ${rendererDist}, but its Luc font css is missing or not a file: ${cssPath}`,
      );
    }
    return themesDir;
  }
  return locateThemesDir(fallbackCandidates);
}

function extractFontFaceBlocks(css) {
  return css.match(/@font-face\s*\{[^}]*\}/g) || [];
}

function familyOf(block) {
  const match = block.match(/font-family:\s*(['"]?)([^;'"]+)\1\s*;/);
  return match ? match[2].trim() : null;
}

function isPathInside(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function rewriteAndValidateFontUrls(block, { cssPath, fontsDir, family }) {
  let matchedUrlCount = 0;
  const declaredUrlCount = (block.match(/url\s*\(/gi) || []).length;
  const rewritten = block.replace(
    /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g,
    (_match, _quote, rawUrl) => {
      matchedUrlCount += 1;
      const fontUrl = String(rawUrl).trim();
      if (!fontUrl.startsWith("./fonts/")) {
        throw new Error(
          `Luc font css at ${cssPath} has an unsupported font URL for ${family}: ${fontUrl}`,
        );
      }
      const relativeFontPath = fontUrl.slice("./fonts/".length);
      const fontPath = path.resolve(fontsDir, relativeFontPath);
      if (!relativeFontPath || !isPathInside(fontsDir, fontPath)) {
        throw new Error(
          `Luc font css at ${cssPath} has a font URL outside themes/fonts for ${family}: ${fontUrl}`,
        );
      }

      let stat;
      try {
        stat = fs.statSync(fontPath);
      } catch {
        throw new Error(
          `Luc font css at ${cssPath} references a missing font file for ${family}: ${fontPath}`,
        );
      }
      if (!stat.isFile() || stat.size <= 0) {
        throw new Error(
          `Luc font css at ${cssPath} references a font that is not a non-empty file for ${family}: ${fontPath}`,
        );
      }
      return `url('${pathToFileURL(fontPath).href}')`;
    },
  );
  if (declaredUrlCount === 0 || matchedUrlCount !== declaredUrlCount) {
    throw new Error(`Luc font css at ${cssPath} has an invalid font URL declaration for ${family}`);
  }
  return rewritten;
}

function validatedFontInjectionCss({ themesDir, families = LUC_PDF_FONT_FAMILIES }) {
  const cssPath = path.join(themesDir, FONTS_CSS_FILENAME);
  const css = fs.readFileSync(cssPath, "utf-8");
  const wanted = new Set(families);
  const selectedBlocks = extractFontFaceBlocks(css).filter((block) => wanted.has(familyOf(block)));
  const covered = new Set(selectedBlocks.map(familyOf));
  const missing = families.filter((family) => !covered.has(family));
  if (missing.length > 0) {
    throw new Error(`Luc font css at ${cssPath} is missing families: ${missing.join(", ")}`);
  }

  const fontsDir = path.join(themesDir, "fonts");
  return selectedBlocks
    .map((block) => rewriteAndValidateFontUrls(block, {
      cssPath,
      fontsDir,
      family: familyOf(block),
    }))
    .join("\n");
}

/**
 * 构建 / 装箱入口共用的 fail-closed 资产断言。返回 true 只表示完整验证通过。
 */
function assertOfficePdfFontAssets({ themesDir, families = LUC_PDF_FONT_FAMILIES } = {}) {
  if (typeof themesDir !== "string" || !themesDir) {
    throw new Error("themesDir is required to validate Luc PDF font assets");
  }
  validatedFontInjectionCss({ themesDir, families });
  return true;
}

/**
 * 构建可注入的 @font-face CSS。白名单任一族缺失即抛错：宁可 PDF 转换失败，
 * 也不静默产出回退字体的 PDF。
 */
function buildFontInjectionCss({ themesDir = resolveThemesDir(), families = LUC_PDF_FONT_FAMILIES } = {}) {
  return validatedFontInjectionCss({ themesDir, families });
}

module.exports = {
  FONTS_CSS_FILENAME,
  LUC_PDF_FONT_FAMILIES,
  assertOfficePdfFontAssets,
  buildFontInjectionCss,
  locateThemesDir,
  resolveThemesDir,
};
