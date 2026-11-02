import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import type { Inbound } from '../src/channels/types.js';
import {
  BackgroundDelegates,
  type BackgroundJob,
  backgroundTurnInbound,
} from '../src/core/background-delegate.js';
import { SUBAGENT_DEFAULT_LIMITS, type SubagentPool } from '../src/core/subagent.js';
import { createDelegateTool } from '../src/tools/delegate.js';

// `delegate` en segundo plano: la subtarea larga corre aparte, el turno termina ya y
// el resultado entra después en el mismo hilo. Límites 2/2/25 iguales; el hijo no
// hereda aprobaciones; /stop lo corta.

type Req = { signal?: AbortSignal; specialist?: string; context?: Record<string, unknown> };

function fakePool(reply: (req: Req) => Promise<{ text: string; error?: string }>) {
  const seen: Req[] = [];
  const pool = {
    run: async (req: Req) => {
      seen.push(req);
      const r = await reply(req);
      return { depth: 1, ...r };
    },
  } as unknown as SubagentPool;
  return { pool, seen };
}

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('');

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('delegate background: true', () => {
  it('contesta «empezado» al momento y la subtarea corre aparte, sin aprobaciones', async () => {
    let release!: () => void;
    const { pool, seen } = fakePool(
      () =>
        new Promise((r) => {
          release = () => r({ text: 'Tres fuentes dicen X.' });
        }),
    );
    const jobs: BackgroundJob[] = [];
    const approve = async () => true;
    const tool = createDelegateTool(pool, () => 0, {
      parentTools: () => [] as AgentTool[],
      approve,
      background: (job) => {
        jobs.push(job);
        return true;
      },
    });
    const turnSignal = new AbortController();
    const r = await tool.execute(
      't1',
      { task: 'compara 5 webs de vuelos a Bilbao', background: true },
      turnSignal.signal,
    );
    expect(textOf(r)).toMatch(/^Empezado en segundo plano: «compara 5 webs de vuelos a Bilbao»/);
    expect(r.details.background).toBe(true);
    expect(seen).toHaveLength(0);
    // El resultado no depende del turno: cortar el turno no corta la subtarea.
    turnSignal.abort();
    const own = new AbortController();
    const done = jobs[0]?.run(own.signal);
    await flush();
    expect(seen[0]?.signal).toBe(own.signal);
    expect(seen[0]?.context).toBeDefined();
    expect(seen[0]?.context?.approve).toBeUndefined();
    release();
    await expect(done).resolves.toBe('Tres fuentes dicen X.');
  });

  it('un fallo o una respuesta vacía del hijo llega como error', async () => {
    const jobs: BackgroundJob[] = [];
    const bg = (job: BackgroundJob) => {
      jobs.push(job);
      return true;
    };
    const failing = fakePool(async () => ({ text: '', error: 'Tiempo agotado.' }));
    await createDelegateTool(failing.pool, () => 0, {
      parentTools: () => [],
      background: bg,
    }).execute('t', { task: 'x', background: true });
    await expect(jobs[0]?.run(new AbortController().signal)).rejects.toThrow('Tiempo agotado.');
    const empty = fakePool(async () => ({ text: '  ' }));
    await createDelegateTool(empty.pool, () => 0, {
      parentTools: () => [],
      background: bg,
    }).execute('t', { task: 'x', background: true });
    await expect(jobs[1]?.run(new AbortController().signal)).rejects.toThrow(/sin devolver/);
  });

  it('con especialista no va en segundo plano: espera como siempre', async () => {
    const { pool, seen } = fakePool(async () => ({ text: 'Hecho.' }));
    let asked = 0;
    const tool = createDelegateTool(pool, () => 0, {
      parentTools: () => [],
      background: () => {
        asked++;
        return true;
      },
    });
    const r = await tool.execute('t', { task: 'x', specialist: 'correo', background: true });
    expect(asked).toBe(0);
    expect(seen).toHaveLength(1);
    expect(textOf(r)).not.toMatch(/segundo plano/);
  });

  it('si no se puede lanzar aparte (tope, panel), se hace esperando', async () => {
    const { pool, seen } = fakePool(async () => ({ text: 'Resumen.' }));
    const tool = createDelegateTool(pool, () => 0, {
      parentTools: () => [],
      background: () => false,
    });
    expect(textOf(await tool.execute('t', { task: 'x', background: true }))).toBe('Resumen.');
    expect(seen).toHaveLength(1);
  });

  it('los límites del pool siguen en 2 de profundidad, 2 a la vez y 25 llamadas', () => {
    expect(SUBAGENT_DEFAULT_LIMITS).toMatchObject({
      maxDepth: 2,
      maxConcurrent: 2,
      maxToolCalls: 25,
    });
  });
});

describe('BackgroundDelegates', () => {
  const thread = (gen = { n: 0 }) => ({ key: 'chat#m1', generation: () => gen.n });

  it('entrega el resultado en el hilo, marcado como material de un subagente', async () => {
    const bg = new BackgroundDelegates();
    const notes: string[] = [];
    expect(
      bg.start(thread(), { task: 'busca vuelos', run: async () => 'Iberia 89 €' }, async (n) => {
        notes.push(n);
      }),
    ).toBe(true);
    await flush();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^\[Resultado de la subtarea en segundo plano «busca vuelos»/);
    expect(notes[0]).toMatch(/no órdenes del usuario/);
    expect(notes[0]).toMatch(/Iberia 89 €$/);
    expect(bg.count('chat#m1')).toBe(0);
  });

  it('un fallo también se cuenta (sin quedarse callado)', async () => {
    const bg = new BackgroundDelegates();
    const notes: string[] = [];
    bg.start(
      thread(),
      {
        task: 'x',
        run: async () => {
          throw new Error('sin red');
        },
      },
      async (n) => {
        notes.push(n);
      },
    );
    await flush();
    expect(notes[0]).toMatch(/no terminó bien/);
    expect(notes[0]).toMatch(/sin red/);
  });

  it('/stop corta la subtarea y su resultado ya no llega', async () => {
    const bg = new BackgroundDelegates();
    const notes: string[] = [];
    let seen: AbortSignal | undefined;
    bg.start(
      thread(),
      {
        task: 'x',
        run: (signal) => {
          seen = signal;
          return new Promise((resolve) => signal.addEventListener('abort', () => resolve('tarde')));
        },
      },
      async (n) => {
        notes.push(n);
      },
    );
    bg.abortThread('chat#m1');
    await flush();
    expect(seen?.aborted).toBe(true);
    expect(notes).toEqual([]);
  });

  it('si el hilo cambió de generación (/stop) mientras corría, se descarta', async () => {
    const bg = new BackgroundDelegates();
    const gen = { n: 0 };
    const notes: string[] = [];
    let finish!: () => void;
    bg.start(
      thread(gen),
      {
        task: 'x',
        run: () =>
          new Promise((r) => {
            finish = () => r('ok');
          }),
      },
      async (n) => {
        notes.push(n);
      },
    );
    gen.n++;
    finish();
    await flush();
    expect(notes).toEqual([]);
  });

  it('como mucho 2 a la vez por hilo; otro hilo tiene las suyas', () => {
    const bg = new BackgroundDelegates();
    const never = { task: 'x', run: () => new Promise<string>(() => {}) };
    const deliver = async () => {};
    expect(bg.start(thread(), never, deliver)).toBe(true);
    expect(bg.start(thread(), never, deliver)).toBe(true);
    expect(bg.start(thread(), never, deliver)).toBe(false);
    expect(bg.start({ key: 'chat#m2', generation: () => 0 }, never, deliver)).toBe(true);
  });
});

describe('backgroundTurnInbound', () => {
  it('mismo chat, persona y mensaje, sin nada de lo que traía aquel mensaje', () => {
    const base = {
      channel: 'telegram',
      account: 'bot',
      chatId: '42',
      threadId: '7',
      userId: '1',
      authorised: true,
      messageId: '99',
      receivedAt: '2026-11-02T10:00:00.000Z',
      text: 'busca vuelos y mira este audio',
      audioFileId: 'voz',
      documentFileId: 'doc',
      images: [{ type: 'image' }],
      replyQuote: '[cita]',
      forwardedFrom: '[Mensaje reenviado de Ana]',
    } as unknown as Inbound;
    const now = new Date('2026-11-02T10:05:00.000Z');
    expect(backgroundTurnInbound(base, 'nota', now)).toEqual({
      channel: 'telegram',
      account: 'bot',
      chatId: '42',
      threadId: '7',
      userId: '1',
      authorised: true,
      messageId: '99',
      receivedAt: '2026-11-02T10:05:00.000Z',
      text: 'nota',
    });
  });
});
