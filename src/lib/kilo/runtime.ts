/**
 * kilo/runtime.ts — Kilo AgentRuntime implementation.
 *
 * Routes CodePilot's AgentRuntime contract (stream / interrupt /
 * isAvailable / dispose) into a managed `kilo serve` child process
 * (kilo-process.ts) over its public HTTP + SSE API:
 *
 *   POST /session                       → create / reuse kilo session
 *   POST /session/{id}/prompt_async     → fire the turn (204, stream via SSE)
 *   GET  /event                         → global SSE bus (filtered per session)
 *   POST /session/{id}/abort            → interrupt
 *   POST /session/{id}/permissions/{pid} → answer permission requests
 *
 * Lifecycle per stream() call:
 *   1. getKiloServer(workingDirectory) — boot / reuse the singleton.
 *   2. Resolve kilo session id from session-store (kilo_session_id
 *      column); POST /session when absent, persist on success.
 *   3. Subscribe to /event SSE, filter by sessionID.
 *   4. POST /session/{id}/prompt_async with the prompt as a text part.
 *   5. Map every event via kilo-event-mapper into CodePilot SSE lines.
 *   6. `session.idle` (or stream error) closes the stream with a
 *      `result` + `done` line.
 *
 * Permissions: kilo `permission.updated` → permission-registry (same
 * path the SDK / Codex use) → user answer via /api/chat/permission →
 * POST back to kilo with once / always / reject.
 *
 * NOTE: node-only (child_process via kilo-process). Don't import from
 * client components.
 */

import type { AgentRuntime, RuntimeStreamOptions } from '@/lib/runtime/types';
import {
  getKiloServer,
  kiloFetch,
  stopKiloServer,
  findKiloBinary,
} from './kilo-process';
import {
  sseLine,
  mapPartUpdated,
  mapPermissionRequest,
  mapSessionError,
  mapTodoUpdated,
  mapFileEdited,
  type KiloEvent,
  type KiloPermission,
} from './kilo-event-mapper';
import {
  getRuntimeSessionRef,
  setRuntimeSessionRef,
} from '@/lib/runtime/session-store';
import { registerPendingPermission, buildPermissionResolvedEvent } from '@/lib/permission-registry';
import { issueApprovalToken } from '@/lib/permission-approval-token';
import { createPermissionRequest } from '@/lib/db';

/**
 * In-flight kilo session per CodePilot chat session. Keyed by chat
 * sessionId so interrupt() can abort without touching the stream.
 */
const globalKey = '__kiloActiveSessions__' as const;

function activeSessions(): Map<string, { kiloSessionId: string; directory: string }> {
  const g = globalThis as Record<string, unknown>;
  if (!g[globalKey]) g[globalKey] = new Map();
  return g[globalKey] as Map<string, { kiloSessionId: string; directory: string }>;
}

/** Answer a kilo permission once the user decides (called from stream's registry waiter). */
async function replyKiloPermission(
  directory: string,
  kiloSessionId: string,
  permissionId: string,
  response: 'once' | 'always' | 'reject',
): Promise<void> {
  const server = await getKiloServer(directory);
  await kiloFetch(server, `/session/${encodeURIComponent(kiloSessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    directory,
    body: JSON.stringify({ response }),
  }).catch((err) => {
    // Best-effort: a failed reply leaves the permission pending in kilo;
    // its own timeout handles it. Never block the user's turn.
    console.warn('[kilo.runtime] permission reply failed:', err);
  });
}

/** Map the registry's PermissionResult to kilo's once/always/reject wire. */
function behaviorToKiloResponse(behavior: string): 'once' | 'always' | 'reject' {
  if (behavior === 'allow') return 'once';
  return 'reject';
}

export const kiloRuntime: AgentRuntime = {
  id: 'kilo_runtime',
  displayName: 'Kilo Runtime',
  description: 'Routes through a managed `kilo serve` instance (Kilo CLI models + built-in tools)',

  isAvailable(): boolean {
    return findKiloBinary() !== null;
  },

  dispose(): void {
    void stopKiloServer();
  },

  interrupt(sessionId: string): void {
    const entry = activeSessions().get(sessionId);
    if (!entry) return;
    void (async () => {
      try {
        const server = await getKiloServer(entry.directory);
        await kiloFetch(server, `/session/${encodeURIComponent(entry.kiloSessionId)}/abort`, {
          method: 'POST',
          directory: entry.directory,
        });
      } catch (err) {
        console.debug('[kilo.runtime] abort failed (best-effort):', err);
      }
    })();
  },

  stream(options: RuntimeStreamOptions): ReadableStream<string> {
    return new ReadableStream<string>({
      async start(controller) {
        const chatSessionId = options.sessionId;
        const directory = options.workingDirectory || process.cwd();
        let closed = false;

        const tryEnqueue = (line: string) => {
          if (closed) return;
          try {
            controller.enqueue(line);
          } catch {
            closed = true;
          }
        };

        const closeStream = (extra?: { error?: string }) => {
          activeSessions().delete(chatSessionId);
          if (closed) return;
          if (extra?.error) {
            tryEnqueue(sseLine({ type: 'error', data: extra.error }));
          }
          tryEnqueue(sseLine({ type: 'result', data: { finish_reason: 'end_turn' } }));
          tryEnqueue(sseLine({ type: 'done', data: '' }));
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        };

        // Abort handling: mirror codex — abortController from the chat
        // route fires interrupt() so the turn stops server-side, then the
        // SSE loop notices session.idle / error and closes cleanly.
        const onAbort = () => {
          kiloRuntime.interrupt(chatSessionId);
        };
        options.abortController?.signal.addEventListener('abort', onAbort, { once: true });

        try {
          if (!options.prompt || options.prompt.trim().length === 0) {
            throw new Error('Kilo Runtime received an empty prompt.');
          }

          const server = await getKiloServer(directory);

          // ── resolve / create kilo session ──────────────────────────
          const existing = getRuntimeSessionRef(chatSessionId, 'kilo_runtime');
          let kiloSessionId = existing?.token ?? '';
          if (!kiloSessionId) {
            const res = await kiloFetch(server, '/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              directory,
              body: JSON.stringify({}),
            });
            if (!res.ok) {
              throw new Error(`kilo POST /session failed: ${res.status} ${await res.text().catch(() => '')}`);
            }
            const created = (await res.json()) as { id?: string };
            if (!created.id) {
              throw new Error('kilo POST /session returned no session id.');
            }
            kiloSessionId = created.id;
            setRuntimeSessionRef(chatSessionId, {
              runtimeId: 'kilo_runtime',
              token: kiloSessionId,
            });
          }
          activeSessions().set(chatSessionId, { kiloSessionId, directory });

          // ── subscribe to the event bus BEFORE firing the turn ──────
          // Fetch with a ReadableStream body side-channel: kilo's /event
          // is a long-lived SSE response. We parse it incrementally.
          const eventsRes = await kiloFetch(server, '/event', { directory });
          if (!eventsRes.ok || !eventsRes.body) {
            throw new Error(`kilo GET /event failed: ${eventsRes.status}`);
          }
          const reader = eventsRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          // Turn termination: set when session.idle arrives for our
          // session, or an abort was requested. Drained then closed.
          let turnDone = false;
          const seenToolCalls = new Set<string>();

          const pump = (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                  const line = buffer.slice(0, idx).trim();
                  buffer = buffer.slice(idx + 1);
                  if (!line.startsWith('data:')) continue;
                  let event: KiloEvent;
                  try {
                    event = JSON.parse(line.slice(5).trim()) as KiloEvent;
                  } catch {
                    continue; // malformed frame — skip
                  }
                  handleKiloEvent(event);
                  if (turnDone) {
                    // Drain one final buffer pass then stop.
                    break;
                  }
                }
                if (turnDone) break;
              }
            } catch {
              // Network hiccup on the SSE bus — if the turn isn't done,
              // surface as error; otherwise the close already enqueued.
              if (!turnDone && !closed) {
                closeStream({ error: 'kilo event stream ended unexpectedly.' });
              }
            }
          })();

          function handleKiloEvent(event: KiloEvent) {
            const props = (event.properties ?? {}) as Record<string, unknown>;
            switch (event.type) {
              case 'message.part.updated': {
                const part = props.part as { type: string; id?: string; sessionID?: string; callID?: string } | undefined;
                if (!part) break;
                if (part.sessionID !== undefined && part.sessionID !== kiloSessionId) break;
                const delta = typeof props.delta === 'string' ? props.delta : undefined;
                // Track seen tool calls: pending → running → completed each
                // re-send the part; terminal states map to tool_result so no
                // dedupe needed there. For started-state repeats the UI
                // treats a repeated tool_use id as an update — harmless.
                if (part.type === 'tool' && typeof part.callID === 'string') {
                  seenToolCalls.add(part.callID);
                }
                for (const line of mapPartUpdated(part as never, delta)) tryEnqueue(line);
                break;
              }
              case 'permission.updated': {
                const permission = props as unknown as KiloPermission;
                if (permission.sessionID !== kiloSessionId) break;
                void handlePermission(permission);
                break;
              }
              case 'session.status': {
                const status = props.status as { type?: string } | undefined;
                if (status?.type === 'idle' && props.sessionID === kiloSessionId) {
                  turnDone = true;
                }
                break;
              }
              case 'session.idle': {
                if (props.sessionID === kiloSessionId) turnDone = true;
                break;
              }
              case 'session.error': {
                if (props.sessionID !== undefined && props.sessionID !== kiloSessionId) break;
                tryEnqueue(mapSessionError(props.error));
                turnDone = true;
                break;
              }
              case 'file.edited': {
                if (typeof props.file === 'string') tryEnqueue(mapFileEdited(props.file));
                break;
              }
              case 'todo.updated': {
                if (props.sessionID === kiloSessionId && Array.isArray(props.todos)) {
                  tryEnqueue(mapTodoUpdated(props.todos as never));
                }
                break;
              }
              case 'session.deleted':
              case 'server.connected':
              case 'installation.updated':
              case 'lsp.client.diagnostics':
              case 'lsp.updated':
              case 'vcs.branch.updated':
                // Bus chatter unrelated to the turn — ignore.
                break;
              default:
                // Unknown event types pass through as status; the
                // contract forbids silent drops.
                tryEnqueue(sseLine({ type: 'status', data: { kind: `kilo:${event.type}` } }));
                break;
            }
          }

          async function handlePermission(permission: KiloPermission) {
            const requestId = `kilo:${permission.id}`;
            const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
            const toolInput = (permission.metadata?.input as Record<string, unknown>) ?? {};

            // Same pipeline as codex approval-bridge: DB row + registry
            // waiter + SSE event; /api/chat/permission resolves it.
            try {
              createPermissionRequest({
                id: requestId,
                sessionId: chatSessionId,
                toolName: permission.type,
                toolInput: JSON.stringify(toolInput),
                expiresAt,
              });
            } catch (err) {
              console.warn('[kilo.runtime] createPermissionRequest failed:', err);
            }

            const { data } = mapPermissionRequest(permission, toolInput);
            const sdkPermission = JSON.parse(data) as {
              permissionRequestId: string;
              toolName: string;
              toolInput: Record<string, unknown>;
              subject: string;
              suggestions: Array<{ type: string; label: string }>;
            };
            // Complete the SDK shape (id / token) the mapper leaves thin.
            sdkPermission.permissionRequestId = requestId;
            tryEnqueue(`data: ${JSON.stringify({
              type: 'permission_request',
              data: JSON.stringify({
                ...sdkPermission,
                toolUseId: permission.callID ?? '',
                description: permission.title,
                approvalToken: issueApprovalToken(requestId, expiresAt),
              }),
            })}\n\n`);

            const result = await registerPendingPermission(
              requestId,
              toolInput,
              undefined,
              () => {
                try {
                  tryEnqueue(`data: ${JSON.stringify(buildPermissionResolvedEvent(requestId))}\n\n`);
                } catch { /* stream closing */ }
              },
            );

            const response = behaviorToKiloResponse(result.behavior);
            // "always" maps from allow + updatedPermissions carrying an
            // always-style suggestion; v1 keeps it simple: allow → once,
            // deny → reject. Session-scoped always can piggyback later
            // via updatedPermissions inspection.
            await replyKiloPermission(directory, kiloSessionId, permission.id, response);
          }

          // ── fire the turn ──────────────────────────────────────────
          // options.model is the picker's `<providerID>/<modelID>` value
          // (see kilo/models.ts). Absent / malformed → omit and let kilo
          // use its own configured default model.
          const model = options.model?.includes('/')
            ? { providerID: options.model.split('/')[0], modelID: options.model.slice(options.model.indexOf('/') + 1) }
            : undefined;
          const promptRes = await kiloFetch(
            server,
            `/session/${encodeURIComponent(kiloSessionId)}/prompt_async`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              directory,
              body: JSON.stringify({
                parts: [{ type: 'text', text: options.prompt }],
                ...(model ? { model } : {}),
                ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
              }),
            },
          );
          if (!promptRes.ok && promptRes.status !== 204) {
            const bodyText = await promptRes.text().catch(() => '');
            throw new Error(`kilo prompt_async failed: ${promptRes.status} ${bodyText.slice(0, 200)}`);
          }

          // ── wait for the turn to finish ────────────────────────────
          await pump;

          // last usage snapshot: kilo step-finish parts already emitted
          // context_usage lines; the final `result` line carries the
          // finish reason only.
          closeStream();
        } catch (err) {
          closeStream({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  },
};
