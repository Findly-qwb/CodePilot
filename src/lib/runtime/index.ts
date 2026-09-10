/**
 * runtime/index.ts — Initialize and register all agent runtimes.
 *
 * Import this module once at app startup to make runtimes available
 * via resolveRuntime().
 */

export type { AgentRuntime, RuntimeStreamOptions } from './types';
export { registerRuntime, getRuntime, getAllRuntimes, getAvailableRuntimes, resolveRuntime, predictNativeRuntime } from './registry';

import { getRuntime, registerRuntime } from './registry';
import { assertPackagedRuntimeDrivers } from './runtime-catalog';
import { nativeRuntime } from './native-runtime';
import { sdkRuntime } from './sdk-runtime';
import { codexRuntime } from '@/lib/codex/runtime';
import { kiloRuntime } from '@/lib/kilo/runtime';

// Register built-in runtimes
registerRuntime(nativeRuntime);
registerRuntime(sdkRuntime);
// Phase 5 Phase 3 (2026-05-13) — Codex Runtime. `isAvailable()` gates
// the runtime registry resolver, so chat sends only route here when
// `codex` binary is on PATH (or CODEX_BIN env override is set).
registerRuntime(codexRuntime);
// Kilo Runtime — same gating pattern: only selectable when `kilo`
// binary is on PATH (or KILO_BIN env override is set). Routes through
// a managed `kilo serve` child process over its public HTTP+SSE API.
registerRuntime(kiloRuntime);

// Harness Home A4: the descriptor catalog and packaged implementations must
// stay atomic. A missing driver fails startup instead of leaving a selectable
// Runtime that would silently execute through another engine.
assertPackagedRuntimeDrivers((driverId) => !!getRuntime(driverId));
