import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(scriptDir, '..', 'dist');
const assetsDir = join(distDir, 'assets');
const maxRawBytes = 500 * 1024;

if (!statSync(assetsDir, { throwIfNoEntry: false })) {
  console.error(`Bundle gate: missing ${assetsDir}. Run the production build first.`);
  process.exit(1);
}

const chunks = readdirSync(assetsDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => {
    const content = readFileSync(join(assetsDir, name));
    return { name, rawBytes: content.length, gzipBytes: gzipSync(content, { level: 9 }).length, content };
  })
  .sort((a, b) => b.rawBytes - a.rawBytes);

if (!chunks.length) {
  console.error('Bundle gate: no JavaScript chunks found in dist/assets.');
  process.exit(1);
}

console.log('Production JavaScript chunks (manifest-independent scan):');
for (const chunk of chunks) {
  console.log(`- ${chunk.name}: raw ${(chunk.rawBytes / 1024).toFixed(2)} KB; gzip ${(chunk.gzipBytes / 1024).toFixed(2)} KB`);
}

const oversized = chunks.filter((chunk) => chunk.rawBytes > maxRawBytes);
const productionAxeLeak = chunks.find((chunk) => chunk.content.includes('@axe-core/playwright'));
if (oversized.length) {
  console.error(`Bundle gate failed: ${oversized.map((chunk) => chunk.name).join(', ')} exceed the 500 KB raw-chunk engineering baseline.`);
}
if (productionAxeLeak) {
  console.error(`Bundle gate failed: ${productionAxeLeak.name} contains the dev-only @axe-core/playwright package.`);
}
if (oversized.length || productionAxeLeak) process.exit(1);

console.log(`Bundle gate passed: ${chunks.length} JavaScript chunks; largest raw chunk ${(chunks[0].rawBytes / 1024).toFixed(2)} KB.`);
