/**
 * kilo/models.ts — build the chat model picker's provider group for the
 * Kilo runtime from `GET /provider` on the managed `kilo serve` instance.
 *
 * Kilo owns its provider configuration (env vars, auth, model catalog),
 * so this group is generated live rather than read from CodePilot's DB.
 * Model values use kilo's canonical `<providerID>/<modelID>` form; the
 * runtime adapter splits them back out when firing prompt_async.
 *
 * Failure (server not up / no providers) returns null → the route
 * degrades to "no Kilo group", same contract as buildCodexProviderModelGroup.
 */

import os from 'os';
import type { ProviderModelGroup } from '@/types';
import { getKiloServer, kiloFetch } from './kilo-process';

interface KiloModelInfo {
  id: string;
  name: string;
  tool_call?: boolean;
  attachment?: boolean;
  reasoning?: boolean;
  limit?: { context?: number; output?: number };
}

interface KiloProviderInfo {
  id: string;
  name: string;
  models: Record<string, KiloModelInfo>;
}

interface KiloProviderList {
  all: KiloProviderInfo[];
  connected: string[];
  default?: Record<string, string>;
}

export async function buildKiloProviderModelGroup(timeoutMs = 6000): Promise<ProviderModelGroup | null> {
  let list: KiloProviderList;
  try {
    // Same degrade contract as Codex model discovery: a cold kilo serve
    // spawn must never hang the model feed. On timeout we return null
    // (no Kilo group this round); the spawn continues in the background
    // and the next picker open hits a warm instance.
    list = await Promise.race([
      (async () => {
        const server = await getKiloServer(os.homedir());
        const res = await kiloFetch(server, '/provider', { directory: os.homedir() });
        if (!res.ok) throw new Error(`provider list ${res.status}`);
        return await res.json() as KiloProviderList;
      })(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('kilo model discovery timeout')), timeoutMs)),
    ]);
  } catch {
    return null; // spawn / auth / network — picker shows no Kilo group
  }

  const connected = new Set(list.connected ?? []);
  const models = (list.all ?? [])
    .filter((p) => connected.size === 0 || connected.has(p.id))
    .flatMap((p) => Object.values(p.models ?? {}).map((m) => ({ provider: p, model: m })));

  if (models.length === 0) return null;

  return {
    provider_id: 'kilo',
    provider_name: 'Kilo',
    provider_type: 'kilo',
    preset_key: 'kilo',
    protocol: 'kilo',
    compat: 'kilo_account',
    total_count: models.length,
    models: models.map(({ provider, model }) => ({
      value: `${provider.id}/${model.id}`,
      label: model.name || `${provider.name} ${model.id}`,
      upstreamModelId: model.id,
      contextWindow: model.limit?.context,
      capabilities: {
        toolUse: model.tool_call !== false,
        vision: model.attachment === true,
        reasoning: model.reasoning === true,
      },
    })),
  } as ProviderModelGroup;
}
