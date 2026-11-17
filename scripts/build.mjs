// Builds the Chrome extension (dist/extension), the mobile web app (dist/mobile) and, on request,
// the unit tests (dist/tests). Usage: node scripts/build.mjs [--watch] [--serve] [--tests]
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcons } from './icons.mjs';
import { extensionIdFromKey } from './keygen.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const serve = args.has('--serve');
const testsOnly = args.has('--tests');

function loadConfig() {
  const path = join(root, 'config.json');
  const fallback = join(root, 'config.example.json');
  const usedFallback = !existsSync(path);
  const config = JSON.parse(readFileSync(usedFallback ? fallback : path, 'utf8'));
  delete config._readme;
  if (usedFallback) console.warn('config.json not found: building with config.example.json (demo mode only). See docs/SETUP.md.');
  config.extensionId = config.extensionKey ? extensionIdFromKey(config.extensionKey) : '';
  return config;
}

const config = loadConfig();
const define = { __CONFIG__: JSON.stringify(config) };
const common = { bundle: true, target: 'es2022', loader: { '.css': 'text' }, define, logLevel: 'info', sourcemap: 'linked', legalComments: 'none' };

function copyStatic() {
  const ext = join(root, 'dist/extension');
  const mob = join(root, 'dist/mobile');
  mkdirSync(join(ext, 'icons'), { recursive: true });
  mkdirSync(join(mob, 'icons'), { recursive: true });

  const manifest = JSON.parse(readFileSync(join(root, 'src/extension/manifest.json'), 'utf8'));
  if (config.extensionKey) manifest.key = config.extensionKey;
  if (config.proxyUrl) manifest.host_permissions.push(new URL(config.proxyUrl).origin + '/*');
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  cpSync(join(root, 'src/extension/options.html'), join(ext, 'options.html'));

  for (const file of ['index.html', 'manifest.webmanifest', 'sw.js']) cpSync(join(root, 'src/mobile', file), join(mob, file));
  cpSync(join(root, 'src/dev/harness.html'), join(mob, 'dev/index.html'), { recursive: true });

  const icons = makeIcons([16, 32, 48, 128, 192, 512]);
  for (const [size, png] of Object.entries(icons)) {
    if (Number(size) <= 128) writeFileSync(join(ext, `icons/icon${size}.png`), png);
    writeFileSync(join(mob, `icons/icon${size}.png`), png);
  }
}

async function buildTests() {
  const dir = join(root, 'tests');
  const entryPoints = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => join(dir, f));
  await esbuild.build({ ...common, entryPoints, outdir: join(root, 'dist/tests'), platform: 'node', format: 'esm', sourcemap: false, outExtension: { '.js': '.mjs' } });
}

const builds = [
  { entryPoints: { background: 'src/extension/background.ts' }, outdir: 'dist/extension', format: 'esm' },
  { entryPoints: { content: 'src/extension/content.ts', options: 'src/extension/options.ts' }, outdir: 'dist/extension', format: 'iife' },
  { entryPoints: { app: 'src/mobile/app.ts' }, outdir: 'dist/mobile', format: 'esm' },
  { entryPoints: { 'dev/harness': 'src/dev/harness.ts' }, outdir: 'dist/mobile', format: 'esm' },
];

if (testsOnly) {
  await buildTests();
} else {
  copyStatic();
  const contexts = await Promise.all(builds.map((b) => esbuild.context({ ...common, ...b, entryPoints: Object.fromEntries(Object.entries(b.entryPoints).map(([k, v]) => [k, join(root, v)])), outdir: join(root, b.outdir) })));
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    if (serve) {
      const { port } = await contexts[2].serve({ servedir: join(root, 'dist/mobile'), port: 5173, host: 'localhost' });
      console.log(`Mobile app: http://localhost:${port}/   Desktop overlay demo: http://localhost:${port}/dev/`);
    }
    console.log('Watching for changes. Reload the extension in chrome://extensions after edits to background code.');
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
    console.log(`Built dist/extension and dist/mobile${config.extensionId ? ` (extension id ${config.extensionId})` : ''}.`);
  }
}
