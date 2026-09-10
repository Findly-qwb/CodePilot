#!/usr/bin/env node
/**
 * stage-standalone-natives.mjs — copy rebuilt native .node binaries into
 * the Next standalone tree after `next build`.
 *
 * Next's require hook resolves serverExternalPackages through hashed alias
 * directories under `.next/node_modules/<pkg>-<hash>/`, and `bindings`-style
 * native lookups resolve relative to THAT copy. NFT tracing only carries the
 * package's JS files, so build/Release/*.node never reaches standalone and
 * the packaged server dies with "Could not locate the bindings file" (which
 * CodePilot's DB bootstrap classifies as database_unavailable).
 *
 * Copy the top-level (already Electron-ABI-rebuilt) binaries into every
 * alias copy in the standalone tree. Idempotent; no-op when sources absent.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STANDALONE = path.join(root, '.next', 'standalone');

const NATIVES = [
  {
    pkg: 'better-sqlite3',
    rel: path.join('build', 'Release', 'better_sqlite3.node'),
  },
  {
    pkg: 'zlib-sync',
    rel: path.join('build', 'Release', 'zlib_sync.node'),
    optional: true,
  },
];

if (!fs.existsSync(STANDALONE)) {
  console.log('[stage-natives] no .next/standalone — run after next build');
  process.exit(0);
}

let stagedTotal = 0;
for (const native of NATIVES) {
  let staged = 0;
  const source = path.join(root, 'node_modules', native.pkg, native.rel);
  if (!fs.existsSync(source)) {
    if (native.optional) {
      console.log(`[stage-natives] optional ${native.pkg} not built — skipping`);
      continue;
    }
    console.error(`[stage-natives] missing ${source} — rebuild first (npm rebuild ${native.pkg})`);
    process.exit(1);
  }

  // Every copy of the package inside standalone (canonical + hashed aliases,
  // under both node_modules/ and .next/node_modules/).
  const queue = [STANDALONE];
  while (queue.length) {
    const dir = queue.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'node_modules' || entry.name === '.next') {
        queue.push(full);
        continue;
      }
      if (entry.name !== native.pkg && !entry.name.startsWith(`${native.pkg}-`)) continue;
      const target = path.join(full, native.rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      staged++;
    }
  }
  stagedTotal += staged;
  console.log(`[stage-natives] staged ${native.pkg} into ${staged} copy/copies`);
}
console.log(`[stage-natives] done (${stagedTotal} copies)`);
