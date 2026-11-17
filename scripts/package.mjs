// Packages the built extension for testers: dist/mobile/download/priority-assistant.zip plus the install page
// (dist/mobile/install.html) that links to it. Run after scripts/build.mjs; `npm run deploy:app` does both.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'dist/extension');
const out = join(root, 'dist/mobile');
if (!existsSync(join(ext, 'manifest.json'))) { console.error('Build first: node scripts/build.mjs'); process.exit(1); }

const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
if (!manifest.key) console.warn('Warning: manifest has no "key", so each tester would get a different extension ID and sign-in would fail. Set extensionKey in config.json.');
const version = manifest.version;

const readme = `Priority Assistant ${version}

Install (Chrome):
1. Keep this folder somewhere it can stay (for example Documents). Chrome runs the extension from here.
2. Open chrome://extensions and turn on "Developer mode" (top right).
3. Click "Load unpacked" and choose this folder (the one with manifest.json in it).
4. The settings page opens. Connect Gmail or Outlook.

Full instructions: ${new URL('install', readConfigUrl()).href}
`;

function readConfigUrl() {
  try { return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).mobileAppUrl || 'https://example.invalid/'; } catch { return 'https://example.invalid/'; }
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/* Minimal zip writer (deflate), so packaging needs no extra tools on Windows or Mac. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const time = new Date();
  const dosTime = (time.getHours() << 11) | (time.getMinutes() << 5) | (time.getSeconds() >> 1);
  const dosDate = ((time.getFullYear() - 1980) << 9) | ((time.getMonth() + 1) << 5) | time.getDate();
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// Files sit at the top of the zip, so "Extract All" (Windows) or double-click (Mac) gives one folder with manifest.json in it.
const entries = walk(ext).map((path) => ({ name: relative(ext, path).split('\\').join('/'), data: readFileSync(path) }));
entries.push({ name: 'README.txt', data: Buffer.from(readme.replace(/\n/g, '\r\n'), 'utf8') });
const archive = zip(entries);
mkdirSync(join(out, 'download'), { recursive: true });
writeFileSync(join(out, 'download/priority-assistant.zip'), archive);

const kb = Math.max(1, Math.round(archive.length / 1024));
const page = readFileSync(join(root, 'src/site/install.html'), 'utf8').replaceAll('{{VERSION}}', version).replaceAll('{{SIZE}}', `${kb} KB`);
writeFileSync(join(out, 'install.html'), page);
console.log(`Packaged extension ${version}: dist/mobile/download/priority-assistant.zip (${kb} KB, ${entries.length} files) and dist/mobile/install.html`);
