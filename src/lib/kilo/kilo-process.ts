/**
 * kilo/kilo-process.ts — `kilo serve` child-process lifecycle manager.
 *
 * One shared singleton per CodePilot server process. Spawns `kilo serve`
 * on a random loopback port with a random Basic-auth password (never the
 * user's own daemon / config — we pass KILO_SERVER_PASSWORD explicitly so
 * this instance is isolated), resolves the bound URL from stdout, and
 * exposes a tiny fetch wrapper with auth + directory routing.
 *
 * Restart budget: mirror of electron/server-supervisor.ts — a healthy run
 * of HEALTHY_RESET_MS earns a fresh budget; crashes exhaust it and the
 * next start() rejects with a clear error.
 *
 * This module is node-only (child_process). Don't import from client
 * components.
 */

import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import pathMod from 'path';

const START_TIMEOUT_MS = 20_000;
const HEALTHY_RESET_MS = 60_000;
const MAX_RESTARTS = 3;
/** Port 0 = OS-assigned. We are the only consumer. */
const PORT_RANGE: [number, number] = [49152, 65535];

export interface KiloServer {
  readonly url: string;
  readonly password: string;
  readonly pid: number | undefined;
}

interface Managed {
  server: KiloServer;
  child: ChildProcess;
  healthySince: number;
  restarts: number;
  startPromise: Promise<KiloServer> | null;
  /** Directory the session was created under (kilo is directory-scoped). */
  directory: string;
}

/**
 * Use globalThis so dev-mode (Turbopack) module duplication can't split
 * the singleton across route handlers. Same trick as permission-registry.
 */
const globalKey = '__kiloServeManager__' as const;

interface ManagerState {
  managed: Managed | null;
  starting: Promise<KiloServer> | null;
  restarts: number;
  lastCrashAt: number;
}

function state(): ManagerState {
  const g = globalThis as Record<string, unknown>;
  if (!g[globalKey]) {
    g[globalKey] = {
      managed: null,
      starting: null,
      restarts: 0,
      lastCrashAt: 0,
    } satisfies ManagerState;
  }
  return g[globalKey] as ManagerState;
}

/**
 * Candidate locations for a kilo binary, in priority order:
 *
 *   1. `KILO_BIN` env — explicit override (tests, CI, custom installs).
 *   2. `KILO_BUNDLED_BIN` env — set by the Electron main process in the
 *      packaged app to point at the binary shipped inside
 *      `Contents/Resources/kilo/bin/kilo` (extraResources). Same pattern
 *      the Kilo VS Code extension uses: `extensionPath/bin/kilo`, never PATH.
 *   3. dev-mode repo checkout — `<repo>/node_modules/.bin/kilo` or a
 *      sibling `kilocode/packages/opencode` build, so `next dev` finds a
 *      locally built binary without a global install.
 *   4. PATH walk — global `npm i -g @kilocode/cli` install.
 */
function kiloBinaryCandidates(): string[] {
  const binName = process.platform === 'win32' ? 'kilo.exe' : 'kilo';
  const candidates: string[] = [];

  const override = process.env.KILO_BIN?.trim();
  if (override) candidates.push(override);

  const bundled = process.env.KILO_BUNDLED_BIN?.trim();
  if (bundled) candidates.push(bundled);

  // Packaged Electron app: resourcesPath/kilo/bin/<kilo>. The Next server
  // can't read process.resourcesPath (that's main-process only), but the
  // main process exports CODEPILOT_RESOURCES_PATH when it spawns us.
  const resourcesDir = process.env.CODEPILOT_RESOURCES_PATH?.trim();
  if (resourcesDir) {
    candidates.push(pathMod.join(resourcesDir, 'kilo', 'bin', binName));
  }

  // Dev checkout: this file lives at src/lib/kilo/, so the repo root is
  // three levels up. Covers a monorepo checkout with a local opencode
  // build (packages/opencode/dist/*/bin/kilo) or a vendored binary.
  try {
    const repoRoot = pathMod.resolve(__dirname, '..', '..', '..', '..');
    candidates.push(pathMod.join(repoRoot, 'vendor', 'kilo', binName));
    candidates.push(pathMod.join(repoRoot, 'node_modules', '.bin', binName));
    candidates.push(pathMod.join(repoRoot, '..', 'kilocode', 'packages', 'opencode', 'dist', `${process.platform}-${process.arch}`, 'bin', binName));
    candidates.push(pathMod.join(repoRoot, 'packages', 'opencode', 'dist', `${process.platform}-${process.arch}`, 'bin', binName));
  } catch {
    // __dirname unavailable in some bundler contexts — skip dev probing.
  }

  const dirs = (process.env.PATH ?? '').split(pathMod.delimiter).filter(Boolean);
  for (const dir of dirs) {
    candidates.push(pathMod.join(dir, binName));
    // Windows npm shims: kilo.cmd / kilo.ps1.
    if (process.platform === 'win32') {
      candidates.push(pathMod.join(dir, 'kilo.cmd'));
    }
  }
  return candidates;
}

/** Locate the kilo binary (bundled > local > PATH). */
export function findKiloBinary(): string | null {
  for (const candidate of kiloBinaryCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // unreadable candidate — keep walking
    }
  }
  return null;
}

function randomPort(): number {
  const [lo, hi] = PORT_RANGE;
  return lo + Math.floor(Math.random() * (hi - lo));
}

/**
 * Spawn `kilo serve` and wait for the `kilo server listening on <url>`
 * stdout line. Rejects on timeout / early exit.
 */
async function spawnKiloServe(directory: string): Promise<{ server: KiloServer; child: ChildProcess }> {
  const bin = findKiloBinary();
  if (!bin) {
    throw new Error(
      'kilo binary not found. Install Kilo CLI (`npm i -g @kilocode/cli`), '
      + 'set KILO_BIN, or use a CodePilot build that bundles the kilo backend.',
    );
  }

  const password = randomUUID();
  const port = randomPort();
  const args = ['serve', `--port=${port}`, '--hostname=127.0.0.1'];

  const child = spawn(bin, args, {
    cwd: directory,
    env: {
      ...process.env,
      KILO_SERVER_USERNAME: 'kilo',
      KILO_SERVER_PASSWORD: password,
      // Never inherit an outer watchdog target: our parent is CodePilot's
      // Next server, and if kilo inherits KILO_PARENT_PID from a nested env
      // it would self-kill when that pid goes away.
      KILO_PARENT_PID: '',
      // Feature gates can distort the child; strip ours.
      KILOCODE_FEATURE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  return await new Promise<{ server: KiloServer; child: ChildProcess }>((resolve, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      finish();
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      reject(new Error(`kilo serve did not start within ${START_TIMEOUT_MS / 1000}s. Output: ${output.slice(-500)}`));
    }, START_TIMEOUT_MS);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    };

    const onLine = (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('kilo server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) continue;
          finish();
          resolve({ server: { url: match[1]!, password, pid: child.pid }, child });
          return;
        }
      }
    };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.once('error', (err) => {
      finish();
      reject(err);
    });
    child.once('exit', (code) => {
      if (settled) return;
      finish();
      reject(new Error(`kilo serve exited before listening (code ${code}). Output: ${output.slice(-500)}`));
    });
  });
}

/**
 * Liveness probe against the running server. Exported for the runtime
 * adapter's isAvailable diagnostics; not used on the hot path because
 * spawnKiloServe already gates on the listening line.
 */
export async function healthCheck(server: KiloServer): Promise<boolean> {
  return fetch(new URL('/config', server.url), {
    headers: authHeaders(server),
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => r.ok)
    .catch(() => false);
}

function authHeaders(server: KiloServer): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`kilo:${server.password}`).toString('base64')}`,
  };
}

/**
 * Get (or start) the shared `kilo serve` instance. ONE instance serves
 * every workspace — kilo routes per-request via x-kilo-directory /
 * ?directory= (same sharing model the Kilo VS Code extension uses for
 * worktree sessions). `directory` only seeds the child's cwd on first
 * spawn; it never triggers a restart. Crash restarts are budgeted; a
 * healthy 60s run resets the budget.
 */
export async function getKiloServer(directory: string): Promise<KiloServer> {
  const s = state();

  if (s.managed) {
    const alive = s.managed.child.exitCode === null && !s.managed.child.killed;
    if (alive) return s.managed.server;
    // Crash path — budget check.
    const now = Date.now();
    if (now - s.lastCrashAt > HEALTHY_RESET_MS) s.restarts = 0;
    s.restarts += 1;
    s.lastCrashAt = now;
    s.managed = null;
    if (s.restarts > MAX_RESTARTS) {
      throw new Error(
        `kilo serve crashed ${s.restarts - 1} times within the restart window. ` +
        'Stopping automatic restarts — check `kilo --version` / KILO_BIN and retry.',
      );
    }
  }

  if (!s.starting) {
    s.starting = (async () => {
      const { server, child } = await spawnKiloServe(directory);
      s.managed = {
        server,
        child,
        healthySince: Date.now(),
        restarts: 0,
        startPromise: null,
        directory,
      };
      return server;
    })().finally(() => {
      s.starting = null;
    });
  }
  return s.starting;
}

/** Test/dispose hook. Aborts active sessions implicitly via SIGTERM. */
export async function stopKiloServer(): Promise<void> {
  const s = state();
  const m = s.managed;
  s.managed = null;
  if (m) {
    try { m.child.kill('SIGTERM'); } catch { /* already dead */ }
  }
}

/** fetch wrapper with auth + the x-kilo-directory routing header. */
export async function kiloFetch(
  server: KiloServer,
  path: string,
  init?: RequestInit & { directory?: string },
): Promise<Response> {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(authHeaders(server))) headers.set(k, v);
  let url = `${server.url}${path}`;
  const dir = init?.directory;
  if (dir) {
    // GET routes accept ?directory=; the SDK rewrites x-kilo-directory the
    // same way. POST carries it as a header (kilo server reads both).
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
      url += `&directory=${encodeURIComponent(dir)}`.replace(/^&/, url.includes('?') ? '' : '?');
    } else {
      headers.set('x-kilo-directory', encodeURIComponent(dir));
    }
  }
  return fetch(url, { ...init, headers });
}
