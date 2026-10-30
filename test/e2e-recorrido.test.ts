import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Recorrido de humo de punta a punta, como lo viviría Nico en un día normal:
 * /start, /funciones, /estado, un recordatorio, «sube a tope» en la tele (falsa)
 * y /stop. Sin cuentas reales, sin daemon real, sin navegador ni tele de verdad:
 * modelo guionizado, grammY falso (la Bot API apunta lo que se envía), tele falsa
 * y SQLite temporal. Los textos salen de las MISMAS funciones que usa el daemon
 * (startText, funcionesText, formatStatus, stopReplyText) y los turnos van por el
 * núcleo de producción (agente, Gate, cola por hilo, planificador).
 */
const root = mkdtempSync(join(tmpdir(), 'pa-e2e-recorrido-'));
process.env.PA_STATE_DIR = join(root, 'state');
process.env.PA_VAULT_BACKEND = 'portable';
process.env.PA_SECRET_PROVIDER_APIKEY = 'test-key-never-used';
process.env.PA_API_KEY = 'test-key-never-used';

const bot = vi.hoisted(() => {
  const sent: Array<{ chatId: number | string; text: string }> = [];
  class FakeGrammyError extends Error {
    readonly error_code = 400;
    readonly description = 'x';
  }
  class FakeBot {
    readonly api = {
      config: { use: () => ({}) },
      sendMessage: async (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return { message_id: sent.length };
      },
      setMyCommands: async () => true,
    };
    on(): void {}
    catch(): void {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  class FakeInlineKeyboard {
    row(): this {
      return this;
    }
    text(): this {
      return this;
    }
  }
  return { sent, FakeBot, FakeGrammyError, FakeInlineKeyboard };
});

vi.mock('grammy', () => ({
  Bot: bot.FakeBot,
  GrammyError: bot.FakeGrammyError,
  HttpError: class extends Error {},
  InlineKeyboard: bot.FakeInlineKeyboard,
  InputFile: class {},
}));
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
const { Core, ScriptedModel, FakeTelegram, FakeTv, call, say, CHAT_ID, E2E_CONFIG, chatKey } = h;
const { TelegramChannel } = await import('../src/channels/telegram.js');
const { startText } = await import('../src/channels/telegram-help.js');
const { funcionesText } = await import('../src/funciones.js');
const { formatStatus, conversationStatus } = await import('../src/status.js');
const { isOwnerDm } = await import('../src/vigilante.js');
const { stopReplyText } = await import('../src/audio/altavoz.js');
const { buildCommandTable, dispatchCommand } = await import('../src/daemon/commands.js');
const { parseCommand } = await import('../src/cli.js');
const { startDailyBriefingTimer, scheduledForToday, _resetDailyBriefingForTests } = await import(
  '../src/briefing-daily.js'
);
type Inbound = import('../src/channels/types.js').Inbound;

const OWNER = Number(CHAT_ID);

/** Tele falsa con Glasshouse: el volumen absoluto («a tope») va por ghControl. */
class GlasshouseTv extends FakeTv {
  override deps() {
    return {
      ...super.deps(),
      ghControl: async (action: string, value?: string | number | boolean) => {
        this.calls.push(`gh:${action}:${String(value)}`);
      },
    };
  }
}

/** Telegram falso cuyos botones de aprobación pueden quedarse esperando a Nico. */
class HoldingTelegram extends FakeTelegram {
  hold: Promise<void> | null = null;
  waiting = 0;
  override async offerApproval(chatId: string, question: string) {
    if (this.hold) {
      this.waiting++;
      await this.hold;
      this.waiting--;
    }
    return super.offerApproval(chatId, question);
  }
}

let seq = 0;
const inbound = (text: string, over: Partial<Inbound> = {}): Inbound =>
  ({
    channel: 'telegram',
    account: 'fake',
    chatId: CHAT_ID,
    userId: CHAT_ID,
    displayName: 'Nico García',
    text,
    authorised: true,
    messageId: String(++seq),
    ...over,
  }) as Inbound;

const cores: InstanceType<typeof Core>[] = [];
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

/**
 * El enrutado del daemon en pequeño: un comando va por la tabla de comandos REAL
 * (buildCommandTable/dispatchCommand + parseCommand de cli.ts) y su respuesta por
 * TelegramChannel.send contra el grammY falso; el resto es un turno del núcleo.
 */
function daemon(core: InstanceType<typeof Core>) {
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [OWNER] });
  const reply = (m: Inbound, text: string) =>
    channel.send({ channel: 'telegram', account: 'fake', chatId: m.chatId, text });
  const table = buildCommandTable<Inbound>([
    { names: ['start'], run: (m) => reply(m, startText(m.displayName)) },
    {
      names: ['funciones'],
      run: (m, args) => reply(m, funcionesText({ owner: isOwnerDm(m, OWNER) }, args)),
    },
    {
      names: ['estado'],
      run: async (m) => {
        const t = await core.thread(m.chatId);
        const conversation = isOwnerDm(m, OWNER)
          ? conversationStatus({ model: t.agent.modelId, primaryModel: E2E_CONFIG.model })
          : undefined;
        return reply(
          m,
          formatStatus({
            conversation,
            version: 'e2e',
            node: process.version,
            uptimeMs: 5 * 60_000,
            tools: [{ name: 'ffmpeg (/watch)', ok: true }],
            log: null,
            pageWatches: 0,
            droppedReminders: [],
          }),
        );
      },
    },
    {
      // Lo mismo que cmdStop en cli.ts: sube la generación (descarta lo encolado),
      // aborta el turno en curso y olvida las aprobaciones de la sesión.
      names: ['stop'],
      run: (m) => {
        const mine = [...core.threads.values()].filter((t) =>
          t.key.startsWith(`${chatKey(m.chatId)}#`),
        );
        let wasActive = 0;
        for (const t of mine) {
          if (t.active) wasActive++;
          t.generation++;
          t.agent.abort('external');
          t.tail = Promise.resolve();
          t.gate.clearSession(t.key);
        }
        return reply(m, stopReplyText(wasActive, 0));
      },
    },
  ]);
  const unknown: string[] = [];
  return {
    async handle(m: Inbound) {
      const command = parseCommand(m.text);
      if (command) {
        await dispatchCommand(table, m, command, async (name) => {
          unknown.push(name);
        });
        return undefined;
      }
      return core.deliver(m);
    },
    unknown,
  };
}

const lastText = (): string => bot.sent.at(-1)?.text ?? '';

/**
 * El canal espacia los envíos ~1,1 s con setTimeout (y con Date congelado la espera
 * es siempre entera): con reloj real el primer recorrido dormía ~4,4 s. Aquí el reloj
 * es falso y se avanza a pasos de 100 ms solo hasta que la promesa termina, sin
 * saltar a temporizadores lejanos (como la caducidad de una aprobación). Igual que #937.
 */
async function drive<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const done = p.finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  for (let step = 0; !settled && step < 300; step++) await vi.advanceTimersByTimeAsync(100);
  if (!settled) throw new Error('drive: no terminó tras 30 s de reloj falso');
  return done;
}

describe('recorrido de humo de punta a punta (núcleo con mocks)', () => {
  it('/start → /funciones → /estado → recordatorio → «sube a tope» → /stop, y el recordatorio llega a su hora', async () => {
    const now = new Date(2026, 9, 30, 17, 0, 0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now });
    const dir = join(root, 'recorrido');
    const telegram = new HoldingTelegram();
    const tv = new GlasshouseTv();
    const core = new Core(dir, { telegram, tv }).start();
    cores.push(core);
    const model = new ScriptedModel();
    const d = daemon(core);

    // /start: saludo por el nombre y la pista de /funciones.
    const t0 = performance.now();
    await drive(d.handle(inbound('/start')));
    expect(lastText()).toContain('¡Hola, Nico!');
    expect(lastText()).toContain('/funciones');

    // /funciones: la vista por áreas; el dueño en su chat privado ve el área de la tele.
    await drive(d.handle(inbound('/funciones')));
    expect(lastText()).toContain('Esto es lo que sé hacer');
    await drive(d.handle(inbound('/funciones tele')));
    expect(lastText()).toContain('/tv');

    // /estado: versión y, solo para el dueño, el modelo de esta conversación.
    await drive(d.handle(inbound('/estado')));
    // Cuatro respuestas seguidas no esperan en tiempo real el hueco de ~1,1 s del canal
    // (antes: ≥3,3 s solo aquí).
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(lastText()).toContain('Asistenta e2e');
    expect(lastText()).toContain('Modelo: test-model (principal)');
    expect(d.unknown).toEqual([]);
    // Ningún comando ha llamado al modelo ni a la tele.
    expect(model.contexts).toHaveLength(0);
    expect(tv.calls).toEqual([]);

    // Recordatorio: se programa sin botón de permiso.
    const at = new Date(2026, 9, 30, 19, 30, 0);
    model.script(
      call('reminder', { action: 'create', text: 'sacar la basura', at: localStamp(at) }),
      say('Hecho: a las 19:30 te recuerdo sacar la basura.'),
    );
    const r1 = await drive(d.handle(inbound('recuérdame sacar la basura a las 19:30')));
    expect(r1?.error).toBeNull();
    expect(telegram.approvals).toHaveLength(0);
    const job = core.routines.status().find((j) => j.name.startsWith('recordatorio-'));
    expect(job?.next && new Date(job.next).getTime()).toBe(at.getTime());

    // «sube a tope»: la orden en castellano llega a la tele falsa como volumen 100
    // (decisión de Nico: «a tope es a tope»), tras el botón de permiso.
    telegram.answers.push(true);
    model.script(call('tv', { action: 'command', text: 'sube a tope' }), say('Volumen a tope.'));
    const r2 = await drive(d.handle(inbound('sube a tope la tele')));
    expect(r2?.error).toBeNull();
    expect(telegram.approvals.at(-1)?.approved).toBe(true);
    expect(tv.calls).toContain('gh:volume:100');
    expect(tv.calls.filter((c) => c.startsWith('gh:volume'))).toEqual(['gh:volume:100']);

    // /stop con un turno esperando el botón y otro en cola: el de la cola se
    // descarta, el en curso se aborta y la tele no se apaga.
    let release = (): void => {};
    telegram.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    model.script(call('tv', { action: 'power', on: false }), say('Tele apagada.'));
    const running = d.handle(inbound('apaga la tele'));
    const queued = d.handle(inbound('y pon Netflix'));
    queued.catch(() => {});
    running.catch(() => {});
    await vi.waitFor(() => expect(telegram.waiting).toBe(1));
    // El daemon marca el hilo activo en runTurn; el arnés no, así que lo hacemos aquí.
    const thread = [...core.threads.values()][0];
    if (thread) thread.active = true;
    const sentBefore = bot.sent.length;
    await drive(d.handle(inbound('/stop')));
    expect(bot.sent.length).toBe(sentBefore + 1);
    expect(lastText()).toBe(stopReplyText(1, 0));
    telegram.hold = null;
    release();
    await expect(queued).rejects.toThrow(/descartado/);
    await running.catch(() => undefined);
    expect(tv.calls).not.toContain('power:false');
    expect(tv.powered).toBe(true);

    // El recordatorio sigue programado y llega UNA vez a su hora, tras un reinicio.
    core.stop();
    cores.splice(0);
    vi.useRealTimers();
    vi.useFakeTimers({ now });
    const telegram2 = new FakeTelegram();
    const core2 = new Core(dir, { telegram: telegram2, tv }).start();
    cores.push(core2);
    await vi.advanceTimersByTimeAsync(at.getTime() - now.getTime() - 60_000);
    expect(telegram2.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(telegram2.sent).toEqual([{ chatId: CHAT_ID, text: '⏰ Recordatorio: sacar la basura' }]);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(telegram2.sent).toHaveLength(1);
  });

  it('un comando desconocido no llega al modelo y no rompe el recorrido', async () => {
    const core = new Core(join(root, 'desconocido')).start();
    cores.push(core);
    const model = new ScriptedModel();
    const d = daemon(core);
    await d.handle(inbound('/noexiste'));
    expect(d.unknown).toEqual(['noexiste']);
    expect(model.contexts).toHaveLength(0);
  });

  it('resumen diario: con un recordatorio para hoy sale UNA vez a las 8, solo al chat del dueño', async () => {
    _resetDailyBriefingForTests();
    const dir = join(root, 'resumen');
    // El día antes por la noche, Nico pide un recordatorio para mañana a las 13:00.
    const evening = new Date(2026, 9, 30, 22, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: evening });
    const core = new Core(dir).start();
    cores.push(core);
    const model = new ScriptedModel();
    const at = new Date(2026, 9, 31, 13, 0, 0);
    model.script(
      call('reminder', { action: 'create', text: 'recoger el paquete', at: localStamp(at) }),
      say('Hecho.'),
    );
    expect(
      (await daemon(core).handle(inbound('recuérdame mañana a la 13 recoger el paquete')))?.error,
    ).toBeNull();
    core.stop();
    cores.splice(0);

    // Arranque del daemon a las 7:58 con el reloj de cada minuto (#661).
    vi.useRealTimers();
    const morning = new Date(2026, 9, 31, 7, 58, 0);
    vi.useFakeTimers({ now: morning });
    const core2 = new Core(dir).start();
    cores.push(core2);
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [OWNER] });
    let last = 0;
    const sentBefore = bot.sent.length;
    const stop = startDailyBriefingTimer({
      enabled: () => true,
      now: () => new Date(),
      hour: 8,
      lastSent: () => last,
      markSent: (t) => {
        last = t;
      },
      owner: () => CHAT_ID,
      send: async (chatId, text) =>
        (await channel.send({ channel: 'telegram', account: 'fake', chatId, text })) !== null,
      reminders: () => {
        const live = new Map(core2.routines.status().map((s) => [s.name, s.next]));
        return scheduledForToday(
          core2.store.listRoutines().map((r) => ({
            name: r.name,
            prompt: r.prompt,
            enabled: r.enabled,
            next: live.get(r.name) ?? null,
          })),
          new Date(),
        ).reminders;
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000); // 7:59: aún no toca
      expect(bot.sent.length).toBe(sentBefore);
      await vi.advanceTimersByTimeAsync(2 * 60_000); // 8:01: sale, a más tardar en un minuto
      const briefings = bot.sent.slice(sentBefore);
      expect(briefings).toHaveLength(1);
      expect(String(briefings[0]?.chatId)).toBe(CHAT_ID);
      expect(briefings[0]?.text).toContain('recoger el paquete');
      // Ni a las 9 ni a las 12 vuelve a salir el mismo día.
      await vi.advanceTimersByTimeAsync(4 * 3_600_000);
      expect(
        bot.sent.slice(sentBefore).filter((m) => m.text.includes('recoger el paquete')),
      ).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
