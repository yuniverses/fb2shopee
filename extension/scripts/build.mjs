import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const baseConfig = {
  bundle: true,
  format: 'iife',
  target: ['chrome114'],
  sourcemap: true,
  logLevel: 'info',
  tsconfig: path.join(root, 'tsconfig.json'),
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  }
};

const entries = [
  {
    entryPoints: [path.join(root, 'src/background/index.ts')],
    outfile: path.join(distDir, 'background.js')
  },
  {
    entryPoints: [path.join(root, 'src/content/facebook.ts')],
    outfile: path.join(distDir, 'content-facebook.js')
  },
  {
    entryPoints: [path.join(root, 'src/content/shopee.ts')],
    outfile: path.join(distDir, 'content-shopee.js')
  },
  {
    entryPoints: [path.join(root, 'src/popup/index.ts')],
    outfile: path.join(distDir, 'popup.js')
  },
  {
    entryPoints: [path.join(root, 'src/options/index.ts')],
    outfile: path.join(distDir, 'options.js')
  }
];

async function copyStatic() {
  await cp(path.join(root, 'public/manifest.json'), path.join(distDir, 'manifest.json'));
  await cp(path.join(root, 'public/popup.html'), path.join(distDir, 'popup.html'));
  await cp(path.join(root, 'public/options.html'), path.join(distDir, 'options.html'));
}

async function runBuild() {
  await rm(distDir, { force: true, recursive: true });
  await mkdir(distDir, { recursive: true });

  if (!watch) {
    await Promise.all(entries.map((cfg) => build({ ...baseConfig, ...cfg })));
    await copyStatic();
    return;
  }

  const contexts = await Promise.all(entries.map((cfg) => context({ ...baseConfig, ...cfg })));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  await copyStatic();
  console.log('Watching extension sources...');
}

runBuild().catch((error) => {
  console.error(error);
  process.exit(1);
});
