/**
 * 构建脚本 - 把 xterm 也打包进 renderer.js，零外部依赖
 */
import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const distDir = resolve(__dirname, 'dist');
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

// 复制 xterm CSS
const cssSrc = resolve(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
const cssDst = resolve(distDir, 'xterm.css');
if (existsSync(cssSrc)) copyFileSync(cssSrc, cssDst);

// 打包 renderer (包含 xterm)
await build({
  entryPoints: [resolve(__dirname, 'src/renderer.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: resolve(distDir, 'renderer.js'),
  // 不设 external，全部打包
  logLevel: 'info',
  color: true,
});

console.log('[build] 完成 - renderer.js 已打包 (含 xterm)');
