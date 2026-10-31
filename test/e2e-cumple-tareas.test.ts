import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AssistantMessage,
  FauxResponseFactory,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * «Organízame el cumple del sábado» de punta a punta con un modelo falso: el agente real,
 * la puerta de permisos de los hilos (con un aprobador que diría que no) y la
 * herramienta «tareas» real sobre un tablero temporal. El modelo apunta un paso por tarea;
 * nada de eso pide aprobación (escribe solo en local) y la respuesta final llega al dueño.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-e2e-cumple-'));
process.env.PA_STATE_DIR = stateDir;
process.env.PA_VAULT_BACKEND = 'portable';
process.env.PA_SECRET_PROVIDER_APIKEY = 'test-key-never-used';
process.env.PA_API_KEY = 'test-key-never-used';

const providerState = vi.hoisted(() => ({ handle: null as unknown }));
vi.mock('../src/core/provider.js', () => ({
  createProviderHandle: async () => providerState.handle,
}));
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { PersonalAgent } = await import('../src/core/agent.js');

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  runTimeoutMs: 5_000,
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

type FauxCore = ReturnType<typeof createFauxCore>;
type Agent = Awaited<ReturnType<typeof PersonalAgent.create>>;

let faux: FauxCore;
let contexts: TranscriptContext[];

/** One scripted model turn, recording the context the provider received. */
function scripted(build: () => AssistantMessage): FauxResponseFactory {
  return (context) => {
    contexts.push(context);
    return build();
  };
}

const { createDaemonGate } = await import('../src/daemon/gate.js');
const { TaskBoard } = await import('../src/tasks/board.js');
const { createTasksTool } = await import('../src/tools/tasks.js');

let seq = 0;
function apuntar(titulo: string): AssistantMessage {
  seq += 1;
  return fauxAssistantMessage(
    [fauxToolCall('tareas', { action: 'apuntar', titulo, dia: 'sábado' }, { id: `c${seq}` })],
    { stopReason: 'toolUse' },
  );
}

beforeEach(() => {
  contexts = [];
  faux = createFauxCore({
    provider: 'test-provider',
    models: [{ id: 'test-model' }],
    tokenSize: { min: 10_000, max: 10_000 },
  });
  const model = faux.getModel();
  providerState.handle = {
    model,
    streamFn: faux.streamSimple,
    modelFor: () => model,
    models: { completeSimple: async () => fauxAssistantMessage('') },
    fallbackFor: undefined,
  };
});

describe('e2e con modelo falso: organizar un evento en el tablero', () => {
  it('«organízame el cumple del sábado» deja un paso por tarea, sin pedir aprobación', async () => {
    const board = new TaskBoard(
      join(mkdtempSync(join(tmpdir(), 'pa-cumple-')), 'tareas.json'),
      () => new Date(2026, 9, 29, 9, 0), // jueves 29-10-2026
    );
    const tool = createTasksTool({ board, scopeOf: () => 'telegram:dm:7' });
    let asked = 0;
    // La puerta de los hilos de producción; si preguntara, la respuesta sería «no».
    const gate = createDaemonGate({
      threadKey: 'telegram:dm:7',
      dbPath: join(stateDir, 'approvals.db'),
      ask: async () => {
        asked += 1;
        return { approved: false, scope: 'once' };
      },
    });
    faux.setResponses([
      scripted(() => apuntar('reservar restaurante')),
      scripted(() => apuntar('avisar a los invitados')),
      scripted(() => apuntar('encargar la tarta')),
      scripted(() =>
        fauxAssistantMessage(
          'Hecho: te he apuntado para el sábado reservar restaurante, avisar a los invitados y encargar la tarta. ¿Cuántos sois?',
        ),
      ),
    ]);
    const agent: Agent = await PersonalAgent.create(CONFIG, [tool], gate, 'test', {
      sessionId: 'e2e-cumple',
      desktop: false,
      iterationBudget: { max: 8 },
    });
    const result = await agent.run('organízame el cumple del sábado');

    expect(result.error).toBeNull();
    expect(result.blocked).toBe(0);
    expect(result.toolErrors).toBe(0);
    expect(result.toolCalls).toBe(3);
    expect(asked).toBe(0);
    expect(result.text).toContain('¿Cuántos sois?');
    const tareas = board.all('telegram:dm:7');
    expect(tareas.map((t) => [t.title, t.day, t.status])).toEqual([
      ['reservar restaurante', '2026-10-31', 'pendiente'],
      ['avisar a los invitados', '2026-10-31', 'pendiente'],
      ['encargar la tarta', '2026-10-31', 'pendiente'],
    ]);
    // El modelo vio la pauta de planificar (un paso por tarea) en la descripción de la herramienta.
    expect(JSON.stringify(contexts[0])).toContain(
      'For planning an event, apuntar one task per step',
    );
    // Y cada resultado de la herramienta volvió al modelo antes del siguiente paso.
    expect(JSON.stringify(contexts[3]?.messages)).toContain('encargar la tarta');
  });
});
