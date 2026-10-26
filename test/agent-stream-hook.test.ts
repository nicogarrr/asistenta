import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { afterAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { PersonalAgent } from '../src/core/agent.js';

/**
 * Hooks de texto del agente.
 *
 * El proveedor falso se instala despues de `create()` sobre el `Agent` de pi, asi
 * que estos tests no abren red ni necesitan un serve local: el flujo completo
 * (suscripcion a eventos, acumulacion y cierre) es el real.
 *
 * El entorno se prepara antes de importar el agente porque `paths.ts` fija
 * `PA_STATE_DIR` al cargarse. La clave no se usa: nada aqui envia una peticion.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-stream-hook-'));
process.env.PA_STATE_DIR = stateDir;
process.env.PA_VAULT_BACKEND = 'portable';
process.env.PA_SECRET_PROVIDER_APIKEY = 'test-key-never-used';
process.env.PA_API_KEY = 'test-key-never-used';

const { PersonalAgent: AgentClass } = await import('../src/core/agent.js');
const { Gate } = await import('../src/permissions.js');

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const CONFIG: Config = {
  webMaxCostEur: 0,
  voiceWake: { engine: 'whisper', owwModel: '', owwThreshold: 0.5 },
  provider: 'test-provider',
  model: 'test-model',
  baseUrl: 'http://127.0.0.1:1/v1',
  contextWindowTokens: 1_048_576,
  maxOutputTokens: 32_000,
  dailyBudgetEur: 0,
  toolTimeoutMs: 1_000,
  runTimeoutMs: 1_000,
  idleTimeoutMs: 1_000,
  screenshotMaxEdge: 800,
  screenshotQuality: 75,
  verifyActions: false,
  verifySettleMs: 100,
  cron: [],
  retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  maxToolCalls: 20,
  browserChannel: 'chromium',
  downloadCookiesBrowser: '',
  curlImpersonatePath: '',
};

const USAGE: Usage = {
  input: 3,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 8,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Proveedor falso: emite `start`, un `text_start`, los deltas recibidos en orden,
 * un `text_end` con el texto completo y `done`. No usa temporizadores: el stream
 * queda lleno antes de que el bucle lo consuma, igual que un proveedor que
 * responde de golpe.
 */
function fakeStream(chunks: readonly string[]): StreamFn {
  return (model) => {
    const events = createAssistantMessageEventStream();
    const base: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: USAGE,
      stopReason: 'pending',
      timestamp: Date.now(),
    };
    events.push({ type: 'start', partial: base });
    events.push({ type: 'text_start', contentIndex: 0, partial: base });
    let full = '';
    for (const delta of chunks) {
      full += delta;
      events.push({
        type: 'text_delta',
        contentIndex: 0,
        delta,
        partial: { ...base, content: [{ type: 'text', text: full }] },
      });
    }
    const final: AssistantMessage = {
      ...base,
      content: full ? [{ type: 'text', text: full }] : [],
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    events.push({ type: 'text_end', contentIndex: 0, content: full, partial: final });
    events.push({ type: 'done', reason: 'stop', message: final });
    events.end(final);
    return events;
  };
}

async function makeAgent(chunks: readonly string[]): Promise<PersonalAgent> {
  const agent = await AgentClass.create(
    CONFIG,
    [],
    new Gate({
      dbPath: join(stateDir, `gate-${Math.random().toString(36).slice(2)}.db`),
      grantWindowMs: 0,
      approver: () => true,
    }),
    'local',
  );
  agent.agent.streamFunction = fakeStream(chunks);
  return agent;
}

describe('RunHooks de texto', () => {
  it('emite los deltas en orden y cierra con la concatenacion final', async () => {
    const deltas: string[] = [];
    const ends: string[] = [];
    const agent = await makeAgent(['Hola', ', ', 'mundo']);

    const result = await agent.run('saluda', undefined, {
      onTextDelta: (delta) => deltas.push(delta),
      onTextEnd: (full) => ends.push(full),
    });

    expect(result.error).toBeNull();
    expect(result.text).toBe('Hola, mundo');
    expect(deltas).toEqual(['Hola', ', ', 'mundo']);
    expect(ends).toEqual(['Hola, mundo']);
    expect(ends[0]).toBe(deltas.join(''));
  });

  it('un hook que lanza no rompe el turno ni se salta los deltas siguientes', async () => {
    const seen: string[] = [];
    let ends = 0;
    const agent = await makeAgent(['uno', 'dos', 'tres']);

    const result = await agent.run('cuenta', undefined, {
      onTextDelta: (delta) => {
        seen.push(delta);
        throw new Error('fallo simulado del canal');
      },
      onTextEnd: () => {
        ends++;
        throw new Error('fallo simulado del canal');
      },
    });

    expect(result.error).toBeNull();
    expect(result.text).toBe('unodostres');
    expect(seen).toEqual(['uno', 'dos', 'tres']);
    expect(ends).toBe(1);
  });

  it('sin hooks el turno devuelve exactamente el mismo texto y estado normal', async () => {
    const withHooks = await makeAgent(['sin', ' cambios']);
    const a = await withHooks.run('prueba', undefined, { onTextDelta: () => {} });
    const withoutHooks = await makeAgent(['sin', ' cambios']);
    const b = await withoutHooks.run('prueba');

    expect(b.text).toBe(a.text);
    expect(b.text).toBe('sin cambios');
    expect(b.error).toBeNull();
    expect(b.stopReason).toBe('stop');
    expect(b.attempts).toBe(1);
    expect(b.toolCalls).toBe(0);
  });
});
