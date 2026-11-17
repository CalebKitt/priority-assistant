// Gives the unpacked extension a fixed ID, so the OAuth redirect URL (https://<id>.chromiumapp.org/) never changes.
// Usage: npm run keygen   -> writes extensionKey into config.json and prints the extension ID.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Chrome's extension ID: first 32 hex chars of SHA-256(public key DER), mapped 0-f -> a-p. */
export function extensionIdFromKey(base64Key) {
  const hex = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const configPath = join(root, 'config.json');
  const config = JSON.parse(readFileSync(existsSync(configPath) ? configPath : join(root, 'config.example.json'), 'utf8'));
  if (config.extensionKey && !process.argv.includes('--force')) {
    console.log(`config.json already has an extensionKey. Extension ID: ${extensionIdFromKey(config.extensionKey)}`);
    console.log('Run with --force to replace it (this changes the ID and the OAuth redirect URL).');
    process.exit(0);
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  config.extensionKey = key;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(root, 'extension-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const id = extensionIdFromKey(key);
  console.log(`Extension ID: ${id}`);
  console.log(`OAuth redirect URL for the extension: https://${id}.chromiumapp.org/`);
}
