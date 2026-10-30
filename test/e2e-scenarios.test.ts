import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Escenarios de punta a punta: Asistenta como UN asistente, sin cuentas reales.
 * Modelo guionizado, Telegram y tele falsos, SQLite temporal; el agente, el Gate,
 * los stores, el planificador y los objetivos son los de producción.
 */
const root = mkdtempSync(join(tmpdir(), 'pa-e2e-scen-'));
process.env.PA_STATE_DIR = join(root, 'state');
process.env.PA_VAULT_BACKEND = 'portable';
process.env.PA_SECRET_PROVIDER_APIKEY = 'test-key-never-used';
process.env.PA_API_KEY = 'test-key-never-used';

vi.mock('../src/core/provider.js', () => ({
  createProviderHandle: async () =>
    (globalThis as unknown as { __e2eProvider?: { handle: unknown } }).__e2eProvider?.handle,
}));
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const h = await import('./helpers/e2e-core.js');
const { Core, ScriptedModel, call, say, CHAT_ID, threadKey } = h;
const { replyOnOwnerRequest } = await import('../src/mail/reply.js');

let dirSeq = 0;
const freshDir = (): string => join(root, `s${++dirSeq}`);
const cores: InstanceType<typeof Core>[] = [];
function boot(dir: string, opts?: ConstructorParameters<typeof Core>[1]) {
  const core = new Core(dir, opts).start();
  cores.push(core);
  return core;
}
async function bootLikeDaemon(dir: string, opts?: ConstructorParameters<typeof Core>[1]) {
  const core = new Core(dir, opts);
  cores.push(core);
  return core.startLikeDaemon();
}

afterEach(() => {
  vi.useRealTimers();
  for (const c of cores.splice(0)) {
    try {
      c.stop();
    } catch {
      /* ya parado */
    }
  }
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const pad = (n: number): string => String(n).padStart(2, '0');
const localStamp = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

describe('escenarios de punta a punta', () => {
  it('«recuérdame X mañana a las 9»: se programa, sobrevive a un reinicio y avisa una sola vez a las 9', async () => {
    // Sábado 24-oct-2026 20:00 en Madrid: «mañana» es el domingo del cambio de hora.
    const now = new Date(2026, 9, 24, 20, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now });
    const dir = freshDir();
    const core = boot(dir);
    const model = new ScriptedModel();
    const tomorrow9 = new Date(2026, 9, 25, 9, 0, 0);
    model.script(
      call('reminder', { action: 'create', text: 'llamar a mamá', at: localStamp(tomorrow9) }),
      say('Hecho: mañana a las 9 te recuerdo llamar a mamá.'),
    );
    const t = await core.thread();
    const r = await t.user('recuérdame llamar a mamá mañana a las 9');
    expect(r.error).toBeNull();
    expect(r.blocked).toBe(0);
    // Un recordatorio no pide permiso: ningún botón.
    expect(core.telegram.approvals).toHaveLength(0);
    expect(model.lastRequest()).toContain('Recordatorio programado para 2026-10-25 09:00');
    const job = core.routines.status().find((j) => j.name.startsWith('recordatorio-1:'));
    expect(job?.next && new Date(job.next).getTime()).toBe(tomorrow9.getTime());

    // Reinicio del daemon antes de la hora, ya con relojes falsos para avanzar.
    core.stop();
    vi.useRealTimers();
    vi.useFakeTimers({ now });
    const telegram = new h.FakeTelegram();
    const core2 = boot(dir, { telegram });
    await vi.advanceTimersByTimeAsync(tomorrow9.getTime() - now.getTime() - 60_000);
    expect(telegram.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(telegram.sent).toEqual([{ chatId: CHAT_ID, text: '⏰ Recordatorio: llamar a mamá' }]);
    // Entregado: se borra y no vuelve (ni a la hora siguiente ni el año que viene).
    expect(core2.store.listRoutines().filter((x) => x.name.startsWith('recordatorio'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(telegram.sent).toHaveLength(1);
  });

  it('«apaga la tele»: pide permiso con un botón y solo apaga si Nico dice sí', async () => {
    const core = boot(freshDir());
    const model = new ScriptedModel();
    const t = await core.thread();

    core.telegram.answers.push(false);
    model.script(call('tv', { action: 'power', on: false }), say('Vale, no la apago.'));
    await t.user('apaga la tele');
    expect(core.tv.calls).toEqual([]);
    expect(core.telegram.approvals).toHaveLength(1);
    expect(core.telegram.approvals[0]?.question).toMatch(/tv/i);

    core.telegram.answers.push(true);
    model.script(call('tv', { action: 'power', on: false }), say('Tele apagada.'));
    const r = await t.user('apaga la tele, sí');
    expect(core.tv.calls).toEqual(['power:false']);
    expect(core.tv.powered).toBe(false);
    expect(r.text).toBe('Tele apagada.');

    // Política actual: incluso mirar el estado de la tele pasa por botón (tv no está
    // en la lista de acciones libres del hilo, a diferencia de computer:screenshot).
    model.script(call('tv', { action: 'state' }), say('Está en Netflix.'));
    await t.user('¿qué hay en la tele?');
    expect(core.telegram.approvals).toHaveLength(3);
  });

  it('objetivo con aprobación: propuesto → activo solo con el «sí» del botón; el tick avisa del hito', async () => {
    const core = boot(freshDir());
    const model = new ScriptedModel();
    const t = await core.thread();
    model.script(
      call('objetivo', {
        action: 'proponer',
        titulo: 'Ordenar facturas',
        objetivo: 'ordena mis facturas de 2026 por mes',
        pasos: ['Listar facturas', 'Agrupar por mes', 'Resumen final'],
        cadencia: '0 * * * *',
      }),
      say('Te propongo este plan. ¿Lo activo?'),
    );
    await t.user('quiero que ordenes mis facturas de 2026 por mes');
    const [goal] = core.goals.list(threadKey());
    expect(goal?.status).toBe('proposed');
    expect(core.routines.status().some((j) => j.name.startsWith('objetivo:'))).toBe(false);

    // El modelo intenta activar; Nico pulsa «no» → sigue propuesto, sin ticks.
    core.telegram.answers.push(false);
    model.script(call('objetivo', { action: 'activar', id: goal?.id ?? '' }), say('No lo activo.'));
    await t.user('espera');
    expect(core.goals.read(goal?.id ?? '')?.status).toBe('proposed');
    expect(core.routines.status().some((j) => j.name.startsWith('objetivo:'))).toBe(false);

    core.telegram.answers.push(true);
    model.script(call('objetivo', { action: 'activar', id: goal?.id ?? '' }), say('Activado.'));
    await t.user('sí, actívalo');
    expect(core.telegram.approvals.at(-1)?.question).toMatch(/objetivo/i);
    expect(core.goals.read(goal?.id ?? '')?.status).toBe('active');
    expect(core.routines.status().some((j) => j.name === `objetivo:${goal?.id}`)).toBe(true);

    // Un tick: avanza el paso 1 y cuenta el hito; Nico recibe UN aviso en su chat.
    const before = core.telegram.sent.length;
    model.script(
      call('objetivo', { action: 'avance', id: goal?.id ?? '', paso: 1, nota: '12 facturas' }),
      say('[hito] Listadas 12 facturas de 2026.'),
    );
    await core.routines.fire(threadKey(), `objetivo:${goal?.id}`);
    await vi.waitFor(() => expect(core.telegram.sent.length).toBe(before + 1));
    expect(core.telegram.sent.at(-1)?.chatId).toBe(CHAT_ID);
    expect(core.telegram.sent.at(-1)?.text).toContain('12 facturas');
    console.log('DBG2', JSON.stringify(core.telegram.approvals));
    expect(core.goals.read(goal?.id ?? '')?.plan[0]?.done).toBe(true);
  });

  it('«busca el precio de Y y avísame si baja»: lee el precio, vigila con un objetivo y avisa al bajar', async () => {
    const core = boot(freshDir());
    const model = new ScriptedModel();
    let price = '499,00 €';
    const fetched: string[] = [];
    core.extraTools = [
      {
        name: 'fetch',
        label: 'fetch',
        description: 'fetch falso',
        parameters: { type: 'object', properties: { url: { type: 'string' } } },
        execute: async (_id: string, args: unknown) => {
          fetched.push(String((args as { url: string }).url));
          return { content: [{ type: 'text', text: `Precio: ${price}` }], details: {} };
        },
      } as never,
    ];
    const t = await core.thread();
    model.script(
      call('fetch', { url: 'https://www.pccomponentes.com/monitor-x' }),
      call('objetivo', {
        action: 'proponer',
        titulo: 'Vigilar precio monitor X',
        objetivo: 'busca el precio del monitor X y avísame si baja de 499 €',
        pasos: ['Comprobar el precio cada hora y avisar si baja de 499 €'],
        cadencia: '0 * * * *',
      }),
      say('Ahora está a 499 €. ¿Activo la vigilancia?'),
    );
    const r = await t.user('busca el precio del monitor X y avísame si baja');
    expect(r.text).toContain('499');
    expect(fetched).toHaveLength(1);
    const [goal] = core.goals.list(threadKey());
    core.telegram.answers.push(true);
    model.script(call('objetivo', { action: 'activar', id: goal?.id ?? '' }), say('Vigilando.'));
    await t.user('sí');
    expect(core.goals.read(goal?.id ?? '')?.status).toBe('active');

    // Tick sin cambios: silencio.
    model.script(
      call('fetch', { url: 'https://www.pccomponentes.com/monitor-x' }),
      say('[progreso] Sigue a 499 €.'),
    );
    const sentBefore = core.telegram.sent.length;
    await core.routines.fire(threadKey(), `objetivo:${goal?.id}`);
    await vi.waitFor(() => expect(fetched).toHaveLength(2));
    expect(core.telegram.sent.length).toBe(sentBefore);

    // Baja: aviso.
    price = '429,00 €';
    model.script(
      call('fetch', { url: 'https://www.pccomponentes.com/monitor-x' }),
      say('[hito] El monitor X ha bajado a 429 €.'),
    );
    await core.routines.fire(threadKey(), `objetivo:${goal?.id}`);
    await vi.waitFor(() => expect(core.telegram.sent.length).toBe(sentBefore + 1));
    expect(core.telegram.sent.at(-1)?.text).toContain('429');
  });

  it('borrador de correo: nada sale sin el «sí» de Nico, y sale una vez con el hilo correcto', async () => {
    const telegram = new h.FakeTelegram();
    const account = { address: 'nico@example.com' } as never;
    const original = {
      from: 'ana@example.com',
      subject: 'Cena del viernes',
      messageId: '<m1@example.com>',
      references: [],
      replyTo: [],
      threadDigest: 'd1',
      threadCount: 1,
      authenticationResults: '',
    };
    const sends: unknown[] = [];
    const deps = {
      readAccount: async () => account,
      sendAccount: async () => account,
      read: async () => original as never,
      send: (async (_acc: unknown, msg: unknown) => {
        sends.push(msg);
        return { ok: true };
      }) as never,
      review: async (preview: string) => (await telegram.offerApproval(CHAT_ID, preview)).approved,
    };
    telegram.answers.push(false);
    const denied = await replyOnOwnerRequest('7:42', 'Me apunto, llevo el postre.', deps);
    expect(denied.ok).toBe(false);
    expect(sends).toHaveLength(0);
    expect(telegram.approvals[0]?.question).toContain('Para: ana@example.com');
    expect(telegram.approvals[0]?.question).toContain('Me apunto, llevo el postre.');

    telegram.answers.push(true);
    const ok = await replyOnOwnerRequest('7:42', 'Me apunto, llevo el postre.', deps);
    expect(ok.ok).toBe(true);
    expect(sends).toEqual([
      expect.objectContaining({
        to: ['ana@example.com'],
        subject: 'Re: Cena del viernes',
        inReplyTo: '<m1@example.com>',
      }),
    ]);
  });

  it('memoria entre sesiones: lo que Nico contó ayer está en el contexto tras reiniciar, y solo en su chat', async () => {
    const dir = freshDir();
    const core = boot(dir);
    const model = new ScriptedModel();
    const t = await core.thread();
    model.script(
      call('memory', { action: 'remember', text: 'Nico toma el café sin azúcar.' }),
      say('Apuntado.'),
    );
    await t.user('tomo el café sin azúcar, acuérdate');
    core.stop();

    const core2 = boot(dir);
    const model2 = new ScriptedModel();
    model2.script(say('Sin azúcar.'));
    await (await core2.thread()).user('¿cómo tomo el café?');
    expect(model2.lastRequest()).toContain('sin azúcar');

    model2.script(say('No lo sé.'));
    await (await core2.thread('777')).user('¿cómo tomo el café?');
    expect(model2.lastRequest()).not.toContain('sin azúcar');
  });

  it('reinicio a mitad de objetivo: sigue por el paso pendiente, respeta el cupo diario y entrega el aviso pendiente', async () => {
    const dir = freshDir();
    const core = boot(dir);
    const model = new ScriptedModel();
    const scope = threadKey();
    const goal = core.goals.propose({
      scope,
      title: 'Plan de viaje',
      verbatim: 'organiza el viaje a Lisboa',
      plan: [
        { text: 'Vuelos', done: false },
        { text: 'Hotel', done: false },
        { text: 'Resumen', done: false },
      ],
      cadence: '0 * * * *',
    });
    core.telegram.answers.push(true);
    model.script(call('objetivo', { action: 'activar', id: goal.id }), say('Activado.'));
    await (await core.thread()).user('sí, actívalo');
    expect(core.goals.read(goal.id)?.status).toBe('active');

    // Tick 1 con Telegram caído: el hito queda pendiente en SQLite.
    core.telegram.failSends = 5;
    model.script(
      call('objetivo', { action: 'avance', id: goal.id, paso: 1, nota: 'TAP 7:40' }),
      say('[hito] Vuelos encontrados: TAP 7:40.'),
    );
    await core.routines.fire(scope, `objetivo:${goal.id}`);
    await vi.waitFor(() => expect(core.goals.read(goal.id)?.ticksToday).toBe(1));
    expect(core.telegram.sent).toHaveLength(0);
    core.stop();

    // Reinicio: el objetivo vuelve a tener su rutina, el aviso pendiente sale.
    const core2 = boot(dir);
    expect(core2.routines.status().some((j) => j.name === `objetivo:${goal.id}`)).toBe(true);
    await core2.notifier.flushAll();
    expect(core2.telegram.sent.map((m) => m.text).join('\n')).toContain('TAP 7:40');

    const model2 = new ScriptedModel();
    model2.script(
      call('objetivo', { action: 'avance', id: goal.id, paso: 2 }),
      say('[progreso] Hotel reservado provisionalmente.'),
    );
    await core2.routines.fire(scope, `objetivo:${goal.id}`);
    await vi.waitFor(() => expect(core2.goals.read(goal.id)?.ticksToday).toBe(2));
    const prompt = JSON.stringify(model2.contexts[0]);
    expect(prompt).toContain('1. [x] Vuelos');
    expect(prompt).toContain('quedan 2');
    expect(core2.goals.read(goal.id)?.plan.map((s) => s.done)).toEqual([true, true, false]);
  });
});

describe('aprobaciones: un «sí» cubre una acción, no otra', () => {
  it('aprobar «apaga la tele» no autoriza abrir una URL ni lanzar una app en la tele', async () => {
    const core = boot(freshDir());
    const model = new ScriptedModel();
    const t = await core.thread();
    core.telegram.answers.push(true); // sí a apagar; lo siguiente queda en «no»
    model.script(
      call('tv', { action: 'power', on: false }),
      call('tv', { action: 'url', url: 'https://example.com/' }),
      say('ok'),
    );
    await t.user('apaga la tele');
    model.script(call('tv', { action: 'launch', appId: 'netflix' }), say('ok'));
    await t.user('otra cosa');
    expect(core.tv.calls).toEqual(['power:false']);
    expect(core.telegram.approvals.map((a) => a.approved)).toEqual([true, false, false]);
  });

  it('aprobar activar el objetivo A no activa el objetivo B en el mismo turno', async () => {
    const core = boot(freshDir());
    const model = new ScriptedModel();
    const scope = threadKey();
    const mk = (title: string) =>
      core.goals.propose({
        scope,
        title,
        verbatim: title,
        plan: [{ text: 'x', done: false }],
        cadence: '0 * * * *',
      });
    const a = mk('A');
    const b = mk('B');
    core.telegram.answers.push(true);
    model.script(
      call('objetivo', { action: 'activar', id: a.id }),
      call('objetivo', { action: 'activar', id: b.id }),
      say('ok'),
    );
    await (await core.thread()).user('activa A');
    expect(core.goals.read(a.id)?.status).toBe('active');
    expect(core.goals.read(b.id)?.status).toBe('proposed');
    expect(core.telegram.approvals).toHaveLength(2);
  });
});

describe('recordatorios cuando algo falla', () => {
  async function remindAt(dir: string, now: Date, at: Date, text: string): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'], now });
    const core = boot(dir);
    const model = new ScriptedModel();
    model.script(call('reminder', { action: 'create', text, at: localStamp(at) }), say('Hecho.'));
    await (await core.thread()).user(`recuérdame ${text}`);
    core.stop();
    vi.useRealTimers();
  }

  it('Telegram caído a las 9: reintenta a las 9:05 y avisa una sola vez', async () => {
    const dir = freshDir();
    const now = new Date(2026, 10, 3, 8, 0, 0);
    const at = new Date(2026, 10, 3, 9, 0, 0);
    await remindAt(dir, now, at, 'sacar la basura');
    vi.useFakeTimers({ now });
    const telegram = new h.FakeTelegram();
    telegram.failSends = 1;
    const core = boot(dir, { telegram });
    await vi.advanceTimersByTimeAsync(at.getTime() - now.getTime() + 30_000);
    expect(telegram.sent).toHaveLength(0);
    expect(core.store.listRoutines().some((r) => r.name.startsWith('recordatorio-1:'))).toBe(true);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(telegram.sent.map((m) => m.text)).toEqual(['⏰ Recordatorio: sacar la basura']);
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(telegram.sent).toHaveLength(1);
    expect(core.store.listRoutines().some((r) => r.name.startsWith('recordatorio-1:'))).toBe(false);
  });

  it('daemon apagado a las 9: al arrancar a las 9:30 avisa con retraso, una vez', async () => {
    const dir = freshDir();
    const at = new Date(2026, 10, 3, 9, 0, 0);
    await remindAt(dir, new Date(2026, 10, 3, 8, 0, 0), at, 'tomar la pastilla');
    const late = new Date(2026, 10, 3, 9, 30, 0);
    vi.useFakeTimers({ now: late });
    const telegram = new h.FakeTelegram();
    await bootLikeDaemon(dir, { telegram });
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toContain('era para el 03/11 09:00');
    expect(telegram.sent[0]?.text).toContain('tomar la pastilla');
    // Ni vuelve a la hora siguiente ni «al año que viene» (el cron no tiene año).
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(telegram.sent).toHaveLength(1);
  });
});

describe('objetivos: final y cupo diario', () => {
  function activeGoal(core: InstanceType<typeof Core>, steps = 1) {
    const goal = core.goals.propose({
      scope: threadKey(),
      title: 'Meta',
      verbatim: 'meta',
      plan: Array.from({ length: steps }, (_, i) => ({ text: `paso ${i + 1}`, done: false })),
      cadence: '0 * * * *',
    });
    core.goals.activate(goal.id, null);
    core.store.saveRoutine({
      scope: goal.scope,
      name: `objetivo:${goal.id}`,
      kind: 'schedule',
      prompt: 'objetivo: Meta',
      schedule: goal.cadence,
      enabled: true,
    });
    core.routines.sync();
    return goal;
  }

  it('[hecho]: nota de cierre a Nico, la rutina desaparece y no hay más ticks', async () => {
    const core = boot(freshDir());
    const model = new ScriptedModel();
    const goal = activeGoal(core);
    model.script(say('[hecho] Todo listo.'));
    await core.routines.fire(threadKey(), `objetivo:${goal.id}`);
    await vi.waitFor(() => expect(core.goals.read(goal.id)?.status).toBe('done'));
    expect(core.telegram.sent.at(-1)?.text).toContain('Todo listo');
    expect(core.routines.status().some((j) => j.name === `objetivo:${goal.id}`)).toBe(false);
    const asked = model.contexts.length;
    await core.routines.fire(threadKey(), `objetivo:${goal.id}`);
    expect(model.contexts.length).toBe(asked);
  });

  it('cupo diario: el tick 13 del día no llega al modelo', async () => {
    const core = boot(freshDir());
    const model = new ScriptedModel();
    const goal = activeGoal(core, 3);
    for (let i = 0; i < 12; i++) {
      model.script(say('[progreso] nada nuevo'));
      await core.goalRunner.tickByRoutineName(`objetivo:${goal.id}`);
    }
    expect(core.goals.read(goal.id)?.ticksToday).toBe(12);
    const asked = model.contexts.length;
    model.script(say('[progreso] no debería correr'));
    await core.goalRunner.tickByRoutineName(`objetivo:${goal.id}`);
    expect(model.contexts.length).toBe(asked);
    expect(core.telegram.sent).toHaveLength(0);
  });
});

describe('«Siempre» sobrevive a un reinicio, salvo donde nunca vale', () => {
  it('«Siempre» para la tele no vuelve a preguntar tras reiniciar; «Siempre» al activar un objetivo no cubre el siguiente', async () => {
    const dir = freshDir();
    const core = boot(dir);
    const model = new ScriptedModel();
    const scope = threadKey();
    const mk = (title: string) =>
      core.goals.propose({
        scope,
        title,
        verbatim: title,
        plan: [{ text: 'x', done: false }],
        cadence: '0 * * * *',
      });
    const a = mk('A');
    const b = mk('B');
    core.telegram.answers.push({ approved: true, scope: 'always' });
    model.script(call('tv', { action: 'power', on: false }), say('ok'));
    await (await core.thread()).user('apaga la tele');
    core.telegram.answers.push({ approved: true, scope: 'always' });
    model.script(call('objetivo', { action: 'activar', id: a.id }), say('ok'));
    await (await core.thread()).user('activa A');
    expect(core.goals.read(a.id)?.status).toBe('active');
    core.stop();

    const core2 = boot(dir);
    const model2 = new ScriptedModel();
    model2.script(call('tv', { action: 'power', on: true }), say('ok'));
    await (await core2.thread()).user('enciende la tele');
    expect(core2.tv.calls).toEqual(['power:true']);
    expect(core2.telegram.approvals).toHaveLength(0);

    // Activar un objetivo es «siempre pregunta»: el «Siempre» anterior no vale.
    model2.script(call('objetivo', { action: 'activar', id: b.id }), say('ok'));
    await (await core2.thread()).user('activa B');
    expect(core2.telegram.approvals).toHaveLength(1);
    expect(core2.goals.read(b.id)?.status).toBe('proposed');
  });
});
