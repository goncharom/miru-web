import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import esbuild from 'esbuild';

const rootDir = process.cwd();
const distDir = resolve(rootDir, 'dist');
const publicDir = resolve(distDir, 'public');
const assetsDir = resolve(publicDir, 'assets');

await mkdir(assetsDir, { recursive: true });
await mkdir(resolve(distDir, 'server'), { recursive: true });

await esbuild.build({
  entryPoints: [resolve(rootDir, 'src/client/main.ts')],
  bundle: true,
  format: 'esm',
  sourcemap: false,
  minify: false,
  outdir: assetsDir,
  entryNames: 'app',
  assetNames: 'assets/[name]-[hash]',
  loader: {
    '.css': 'css',
  },
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: [resolve(rootDir, 'src/server/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  outfile: resolve(distDir, 'server/main.js'),
  external: ['node-pty', 'ws'],
  logLevel: 'info',
});

const indexSrc = resolve(rootDir, 'src/client/index.html');
const indexOut = resolve(publicDir, 'index.html');
await mkdir(dirname(indexOut), { recursive: true });
await copyFile(indexSrc, indexOut);
