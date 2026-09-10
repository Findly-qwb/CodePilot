/**
 * kilo-event-mapper.test.ts — unit tests for the kilo → CodePilot
 * SSE translation layer. Pure functions; no DB, no child process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sseLine,
  mapPartUpdated,
  mapPermissionRequest,
  mapSessionError,
  mapTodoUpdated,
  mapFileEdited,
} from '@/lib/kilo/kilo-event-mapper';

function parseSse(line: string): { type: string; data: unknown } {
  assert.ok(line.startsWith('data: '));
  assert.ok(line.endsWith('\n\n'));
  return JSON.parse(line.slice(6, -2));
}

function parseInner(line: string): Record<string, unknown> {
  const outer = parseSse(line);
  return JSON.parse(outer.data as string);
}

test('sseLine wraps string payloads without double-encoding', () => {
  const line = sseLine({ type: 'text', data: 'hello' });
  const parsed = parseSse(line);
  assert.equal(parsed.type, 'text');
  assert.equal(parsed.data, 'hello');
});

test('text part with delta emits a text SSE line (raw string payload, matches SDK text event)', () => {
  const lines = mapPartUpdated({ type: 'text', id: 'p1', text: 'wor' }, 'wor');
  assert.equal(lines.length, 1);
  const outer = parseSse(lines[0]!);
  assert.equal(outer.type, 'text');
  // text events carry the delta as the raw data string (single-layer) —
  // useSSEStream's text branch appends event.data directly.
  assert.equal(outer.data, 'wor');
});

test('text part without delta emits nothing (no re-emit of accumulation)', () => {
  assert.deepEqual(mapPartUpdated({ type: 'text', id: 'p1', text: 'world' }, undefined), []);
});

test('reasoning part with delta emits a reasoning SSE line (raw string payload)', () => {
  const lines = mapPartUpdated({ type: 'reasoning', id: 'p2', text: 'think' }, 'think');
  assert.equal(lines.length, 1);
  const outer = parseSse(lines[0]!);
  assert.equal(outer.type, 'reasoning');
  assert.equal(outer.data, 'think');
});

test('tool part pending emits tool_use', () => {
  const lines = mapPartUpdated({
    type: 'tool',
    id: 't1',
    callID: 'call_1',
    tool: 'bash',
    state: { status: 'pending', input: { command: 'ls' }, raw: '' },
  });
  assert.equal(lines.length, 1);
  const inner = parseInner(lines[0]!);
  assert.equal(inner.id, 'call_1');
  assert.equal(inner.name, 'bash');
  assert.deepEqual(inner.input, { command: 'ls' });
});

test('tool part completed emits tool_result with output', () => {
  const lines = mapPartUpdated({
    type: 'tool',
    id: 't1',
    callID: 'call_1',
    tool: 'bash',
    state: { status: 'completed', input: {}, output: 'file.txt', title: 'ls', metadata: {}, time: { start: 1, end: 2 } },
  });
  assert.equal(lines.length, 1);
  const outer = parseSse(lines[0]!);
  assert.equal(outer.type, 'tool_result');
  const inner = JSON.parse(outer.data as string);
  assert.equal(inner.tool_use_id, 'call_1');
  assert.equal(inner.content, 'file.txt');
  assert.equal(inner.is_error, undefined);
});

test('tool part error emits tool_result with is_error', () => {
  const lines = mapPartUpdated({
    type: 'tool',
    id: 't1',
    callID: 'call_1',
    tool: 'bash',
    state: { status: 'error', input: {}, error: 'boom', time: { start: 1, end: 2 } },
  });
  const outer = parseSse(lines[0]!);
  const inner = JSON.parse(outer.data as string);
  assert.equal(inner.is_error, true);
  assert.equal(inner.content, 'boom');
});

test('tool attachments map to media blocks', () => {
  const lines = mapPartUpdated({
    type: 'tool',
    id: 't1',
    callID: 'call_1',
    tool: 'screenshot',
    state: {
      status: 'completed',
      input: {},
      output: 'done',
      title: 'shot',
      metadata: {},
      time: { start: 1, end: 2 },
      attachments: [{ url: 'file:///tmp/a.png', mime: 'image/png', filename: 'a.png' }],
    },
  });
  const outer = parseSse(lines[0]!);
  const inner = JSON.parse(outer.data as string);
  assert.ok(Array.isArray(inner.media));
  assert.equal(inner.media[0].type, 'image');
});

test('step-finish emits context_usage with tokens', () => {
  const lines = mapPartUpdated({
    type: 'step-finish',
    id: 's1',
    reason: 'stop',
    cost: 0.01,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 5, write: 0 } },
  });
  assert.equal(lines.length, 1);
  const outer = parseSse(lines[0]!);
  assert.equal(outer.type, 'context_usage');
  const inner = JSON.parse(outer.data as string);
  assert.equal(inner.input_tokens, 10);
  assert.equal(inner.output_tokens, 20);
  assert.equal(inner.cached_input_tokens, 5);
});

test('known non-visual parts emit nothing', () => {
  for (const type of ['step-start', 'subtask', 'snapshot', 'patch', 'retry', 'compaction', 'file', 'agent']) {
    assert.deepEqual(mapPartUpdated({ type, id: 'x' } as never), []);
  }
});

test('unknown part type surfaces as status, never dropped', () => {
  const lines = mapPartUpdated({ type: 'future_kind', id: 'x' } as never);
  assert.equal(lines.length, 1);
  const outer = parseSse(lines[0]!);
  assert.equal(outer.type, 'status');
  const inner = JSON.parse(outer.data as string);
  assert.equal(inner.kind, 'kilo:future_kind');
});

test('permission maps to permission_request shape', () => {
  const { type, data } = mapPermissionRequest(
    {
      id: 'perm_1',
      type: 'bash',
      sessionID: 's1',
      messageID: 'm1',
      callID: 'call_1',
      title: 'Run ls',
      metadata: { input: { command: 'ls' } },
    },
    { command: 'ls' },
  );
  assert.equal(type, 'permission_request');
  const parsed = JSON.parse(data);
  assert.equal(parsed.toolName, 'bash');
  assert.equal(parsed.subject, 'Run ls');
  assert.deepEqual(parsed.toolInput, { command: 'ls' });
});

test('session error maps message through', () => {
  const line = mapSessionError({ name: 'ApiError', message: 'rate limited' });
  const outer = parseSse(line);
  assert.equal(outer.type, 'error');
  assert.equal(outer.data, 'rate limited');
});

test('session error tolerates raw strings', () => {
  assert.equal(parseSse(mapSessionError('kaboom')).data, 'kaboom');
});

test('todo updated maps todo items', () => {
  const line = mapTodoUpdated([{ id: 't1', content: 'write tests', status: 'in_progress', priority: 'high' }]);
  const outer = parseSse(line);
  assert.equal(outer.type, 'todo');
  const inner = JSON.parse(outer.data as string);
  assert.equal(inner[0].content, 'write tests');
});

test('file edited maps to file_changed', () => {
  const line = mapFileEdited('/tmp/a.txt');
  const outer = parseSse(line);
  assert.equal(outer.type, 'file_changed');
  const inner = JSON.parse(outer.data as string);
  assert.deepEqual(inner.paths, ['/tmp/a.txt']);
});
