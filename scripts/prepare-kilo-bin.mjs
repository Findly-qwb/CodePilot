#!/usr/bin/env node
/**
 * prepare-kilo-bin.mjs — stage the kilo backend binary for packaging.
 *
 * Populates `resources/kilo/` with the single-binary kilo CLI + its
 * tree-sitter wasm dir, so the packaged app runs the Kilo Runtime with
 * zero user install (same distribution model as the Kilo VS Code
 * extension: `extensionPath/bin/kilo`, never PATH-dependent).
 *
 * Resolution order (first hit wins):
 *   1. KILO_BIN points at a binary → copy it (tree-sitter dir optional
 *      via KILO_TREE_SITTER_DIR).
 *   2. A sibling kilocode repo checkout with a built
 *      `packages/opencode/dist/@kilocode/cli-<os>-<arch>/bin/` → copy
 *      binary + tree-sitter + workers. Build it with:
 *        cd packages/opencode && bun run build --single
 *   3. Nothing found → leave `resources/kilo/` absent. electron-builder
 *      skips the optional FileSet and packaged builds fall back to PATH
 *      lookup (documented behavior, not an error).
 *
 * Wired into electron:build by package.json. Idempotent; pass --force to
 * restage even when the target looks current.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'resources', 'kilo');
const force = process.argv.includes('--force');

const binName = process.platform === 'win32' ? 'kilo.exe' : 'kilo';
const osTag = process.platform === 'win32' ? 'windows' : process.platform;
const arch = process.arch;

function log(msg) {
  console.log(`[prepare-kilo-bin] ${msg}`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function stage(fromBin, treeSitterDir) {
  const binOut = path.join(outDir, 'bin');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(binOut, { recursive: true });
  fs.copyFileSync(fromBin, path.join(binOut, binName));
  fs.chmodSync(path.join(binOut, binName), 0o755);

  // Companion resources from the same bin/ directory the binary lives in:
  // tree-sitter wasms, sandbox worker bundles, console assets. Copy what
  // exists; the CLI degrades gracefully when optional pieces are absent.
  const siblings = ['tree-sitter', 'kilo-console', 'kilo-sandbox-worker.js', 'kilo-sandbox-network.js'];
  const binDir = path.dirname(fromBin);
  for (const name of siblings) {
    const src = path.join(binDir, name);
    if (fs.existsSync(src)) {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) copyDir(src, path.join(binOut, name));
      else fs.copyFileSync(src, path.join(binOut, name));
    }
  }
  const explicitTreeSitter = treeSitterDir && fs.existsSync(treeSitterDir) ? treeSitterDir : null;
  if (explicitTreeSitter) copyDir(explicitTreeSitter, path.join(binOut, 'tree-sitter'));

  fs.writeFileSync(path.join(outDir, '.staged-from'), `${fromBin}\n`, 'utf8');
  log(`staged ${binName} from ${fromBin}`);
  log(`resources/kilo/ ready (${Math.round(fs.statSync(path.join(binOut, binName)).size / 1e6)} MB binary)`);
}

function alreadyStaged() {
  const marker = path.join(outDir, '.staged-from');
  const binOut = path.join(outDir, 'bin', binName);
  return fs.existsSync(marker) && fs.existsSync(binOut);
}

if (alreadyStaged() && !force) {
  log('resources/kilo/ already staged — skipping (pass --force to restage)');
  process.exit(0);
}

// 1. Explicit KILO_BIN override.
if (process.env.KILO_BIN) {
  const bin = process.env.KILO_BIN.trim();
  if (fs.existsSync(bin)) {
    stage(bin, process.env.KILO_TREE_SITTER_DIR);
    process.exit(0);
  }
  log(`KILO_BIN=${bin} does not exist — continuing discovery`);
}

// 2. Sibling kilocode checkout with a built single-binary CLI.
const candidates = [
  path.join(root, '..', 'kilocode', 'packages', 'opencode'),
  path.join(root, 'kilocode', 'packages', 'opencode'),
  path.join(root, 'vendor', 'kilocode', 'packages', 'opencode'),
];
const distName = `@kilocode/cli-${osTag}-${arch}`;
for (const repo of candidates) {
  const bin = path.join(repo, 'dist', distName, 'bin', binName);
  if (fs.existsSync(bin)) {
    stage(bin, null);
    process.exit(0);
  }
}

// 3. Nothing found — leave a placeholder dir so electron-builder's
// extraResources FileSet (resources/kilo/ → kilo/) always has a source.
// The README is filtered out of the package; main.ts's existsSync probe
// decides runtime availability, never the packaging config.
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'README-no-binary.md'),
  'No kilo binary was staged. Run scripts/prepare-kilo-bin.mjs with a '
    + 'kilocode checkout (packages/opencode built via `bun run build --single`) '
    + 'or KILO_BIN set to stage the Kilo Runtime backend.\n',
  'utf8',
);
log(
  'no kilo binary found (looked for KILO_BIN and a kilocode checkout with '
  + `packages/opencode/dist/${distName}/bin/${binName}). `
  + 'resources/kilo/ left as placeholder — packaged builds will use PATH-installed kilo.',
);
process.exit(0);
