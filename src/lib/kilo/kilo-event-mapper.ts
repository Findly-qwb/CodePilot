/**
 * kilo/kilo-event-mapper.ts — translate `kilo serve` SSE events into
 * CodePilot's SDK-shaped SSE lines.
 *
 * kilo's event model (from @kilocode/sdk codegen types):
 *   - `message.part.updated` { part, delta? } — streaming part deltas.
 *     Parts: text / reasoning / tool / step-start / step-finish / patch …
 *   - `permission.updated` { Permission } — tool permission request.
 *   - `session.idle` / `session.status` — turn lifecycle.
 *   - `session.error` — provider / runtime errors.
 *   - `file.edited` — file mutation.
 *   - `todo.updated` — task list.
 *
 * Output: CodePilot chat SSE lines `data: {"type":...,"data":...}\n\n`
 * (same set useSSEStream already renders for SDK / Codex runtimes):
 *   text / reasoning / tool_use / tool_result / file_changed /
 *   context_usage / permission_request / permission_resolved /
 *   result / error / status / todo / done
 *
 * Pure functions — the unit-test surface for the whole adapter.
 */

// ── Minimal structural types mirrored from @kilocode/sdk codegen ──
// Kept local + defensive: kilo's schema evolves, unknown parts must
// pass through as `status` events, never crash the stream.

export interface KiloTextPart { type: 'text'; id: string; text: string }
export interface KiloReasoningPart { type: 'reasoning'; id: string; text: string }
export interface KiloToolStatePending { status: 'pending'; input: Record<string, unknown>; raw: string }
export interface KiloToolStateRunning { status: 'running'; input: Record<string, unknown>; title?: string }
export interface KiloToolStateCompleted {
  status: 'completed';
  input: Record<string, unknown>;
  output: string;
  title: string;
  attachments?: Array<{ url: string; mime: string; filename?: string }>;
}
export interface KiloToolStateError { status: 'error'; input: Record<string, unknown>; error: string }
export type KiloToolState = KiloToolStatePending | KiloToolStateRunning | KiloToolStateCompleted | KiloToolStateError;
export interface KiloToolPart {
  type: 'tool';
  id: string;
  callID: string;
  tool: string;
  state: KiloToolState;
}
export interface KiloStepFinishPart {
  type: 'step-finish';
  id: string;
  reason: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
}
export type KiloPart = KiloTextPart | KiloReasoningPart | KiloToolPart | KiloStepFinishPart | { type: string; id?: string; [k: string]: unknown };

export interface KiloEvent {
  type: string;
  properties?: unknown;
}

export interface KiloPermission {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
}

export function sseLine(obj: { type: string; data: unknown }): string {
  return `data: ${JSON.stringify({ type: obj.type, data: typeof obj.data === 'string' ? obj.data : JSON.stringify(obj.data) })}\n\n`;
}

/**
 * Map one `message.part.updated` into SSE lines.
 * Returns empty array for parts that produce no chat-visible output
 * (step-start etc.), and a `status` line for unknown part types so
 * nothing is silently dropped (contract: unknown_item equivalent).
 */
export function mapPartUpdated(part: KiloPart, delta?: string): string[] {
  switch (part.type) {
    case 'text': {
      // kilo streams the full accumulated `text` on each update plus an
      // optional `delta`. Prefer the delta; fall back to nothing (the
      // next update will carry more text) — never re-emit the full
      // accumulation as a delta.
      if (delta && delta.length > 0) return [sseLine({ type: 'text', data: delta })];
      return [];
    }
    case 'reasoning': {
      if (delta && delta.length > 0) return [sseLine({ type: 'reasoning', data: delta })];
      return [];
    }
    case 'tool':
      return mapToolPart(part as KiloToolPart);
    case 'step-finish': {
      const p = part as KiloStepFinishPart;
      return [
        sseLine({
          type: 'context_usage',
          data: {
            input_tokens: p.tokens.input,
            output_tokens: p.tokens.output,
            cached_input_tokens: p.tokens.cache.read,
            cost: p.cost,
          },
        }),
      ];
    }
    case 'step-start':
    case 'subtask':
    case 'snapshot':
    case 'patch':
    case 'retry':
    case 'compaction':
    case 'file':
    case 'agent':
      return [];
    default:
      return [sseLine({ type: 'status', data: { kind: `kilo:${part.type}` } })];
  }
}

function mapToolPart(part: KiloToolPart): string[] {
  const state = part.state;
  switch (state.status) {
    case 'pending':
    case 'running':
      // tool_started — dedupe by emitting only on first sight. The runtime
      // tracks seen callIDs; here we emit for both pending and running
      // (harmless: UI treats a repeated tool_use id as update).
      return [
        sseLine({
          type: 'tool_use',
          data: { id: part.callID, name: part.tool, input: state.input ?? {} },
        }),
      ];
    case 'completed': {
      const media = (state.attachments ?? []).map((a) => ({
        type: a.mime.startsWith('image/') ? 'image' : 'file',
        url: a.url,
        mime_type: a.mime,
        name: a.filename ?? a.url.split('/').pop() ?? 'attachment',
      }));
      return [
        sseLine({
          type: 'tool_result',
          data: {
            tool_use_id: part.callID,
            content: state.output,
            ...(media.length > 0 ? { media } : {}),
          },
        }),
      ];
    }
    case 'error':
      return [
        sseLine({
          type: 'tool_result',
          data: {
            tool_use_id: part.callID,
            content: state.error,
            is_error: true,
          },
        }),
      ];
    default:
      return [sseLine({ type: 'status', data: { kind: 'kilo:tool', state: (state as { status?: string }).status } })];
  }
}

/**
 * Map a `permission.updated` event into CodePilot's SDK-shaped
 * `permission_request` SSE payload. The `data` field shape matches what
 * approval-bridge.ts emits (PermissionRequestEvent) so PermissionPrompt
 * renders without a new code path.
 */
export function mapPermissionRequest(
  permission: KiloPermission,
  toolInput: Record<string, unknown>,
): { type: 'permission_request'; data: string } {
  return {
    type: 'permission_request',
    data: JSON.stringify({
      id: permission.id,
      toolName: permission.type,
      toolInput,
      // kilo's title is a human summary; use it as subject.
      subject: permission.title,
      suggestions: [
        { type: 'allow', label: 'Allow once' },
        { type: 'reject', label: 'Reject' },
      ],
    }),
  };
}

/**
 * Map `session.error` into an SSE error line. kilo error payloads are
 * structured ({ name, message, data? }); degrade gracefully for raw
 * strings.
 */
export function mapSessionError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const e = error as { name?: string; message?: string; data?: { message?: string } };
    return sseLine({
      type: 'error',
      data: e.data?.message ?? e.message ?? 'kilo session error',
    });
  }
  return sseLine({ type: 'error', data: String(error ?? 'kilo session error') });
}

/** Map `todo.updated` into the SSE todo event the chat already renders. */
export function mapTodoUpdated(todos: Array<{ id: string; content: string; status: string; priority: string }>): string {
  return sseLine({
    type: 'todo',
    data: todos.map((t) => ({
      id: t.id,
      content: t.content,
      status: t.status,
      priority: t.priority,
    })),
  });
}

/** Map `file.edited` into the SSE file_changed event (PreviewPanel refresh). */
export function mapFileEdited(file: string): string {
  return sseLine({ type: 'file_changed', data: { paths: [file] } });
}
