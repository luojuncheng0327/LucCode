import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { injectCsp } from './vite.csp-profiles';

/**
 * vite.config.splash.ts — 双 artifact 管线：splash 独立构建
 *
 * splash 是壳自持表面："The shell never serves UI
 * from Resources directly; splash remains the only shell-owned surface"）：
 * 装箱后的安装器不再把 renderer 打进 asar（改成签名归档、首启在 LUC_HOME
 * 解压），但 splash 必须在"LUC_HOME 空、还没解压任何 artifact"这个时间点
 * 就能渲染——所以它不能依赖 renderer 的构建产物，需要一份自己的、随 asar
 * 走的独立构建。
 *
 * 只构建 splash.html 这一个入口，输出到 desktop/dist-splash/（跟主配置的
 * ../dist-renderer 同级）。dev 模式完全不用这份配置——`vite dev` 走
 * vite.config.ts 的 dev server，按目录直接服务 splash.html，不依赖任何
 * rollupOptions.input 列表（entry 列表只在 `vite build` 时起作用）。
 */
function copySplashRuntimeAssets(): Plugin {
  return {
    name: 'luc-copy-splash-runtime-assets',
    async closeBundle() {
      // 动态 import：splash-assets.mjs 本身 import 了 shared/yuan-visuals.ts
      // （Node 原生 TS type-stripping 处理，这个仓库已有先例）。放进
      // closeBundle 而不是顶层 import，避免让 vite 自己的 config-loading
      // esbuild 打包阶段去处理这条依赖链——两条路径都该能工作，但
      // closeBundle 里跑等价于直接 `node scripts/splash-assets.mjs`，
      // 是这个仓库里已经验证过的执行环境，行为最可预期。
      const { copySplashAssets } = await import('./scripts/splash-assets.mjs');
      const srcDir = path.resolve(__dirname, 'desktop/src');
      const outDir = path.resolve(__dirname, 'desktop/dist-splash');
      copySplashAssets({ srcDir, outDir });
    },
  };
}

export default defineConfig({
  root: 'desktop/src',
  base: './',
  plugins: [react(), injectCsp(), copySplashRuntimeAssets()],
  build: {
    outDir: '../dist-splash',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        splash: path.resolve(__dirname, 'desktop/src/splash.html'),
      },
    },
  },
});
