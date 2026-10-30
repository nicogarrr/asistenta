/**
 * /funciones: lo que sabe hacer Asistenta por áreas, generado del catálogo único
 * de /help (que a su vez está atado al menú de Telegram y a la tabla de comandos
 * del daemon). gramY de mentira, sin red.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelRegistry } from '../src/channels/registry.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import { helpCommands } from '../src/channels/telegram-help.js';
import type { ChannelAdapter, ChannelHandlers } from '../src/channels/types.js';
import {
  FUNCION_AREAS,
  FUNCIONES_CALLBACK_PREFIX,
  findArea,
  funcionCommands,
  funcionesButtons,
  funcionesButtonText,
  funcionesText,
  OWNER_ONLY_COMMANDS,
  visibleAreas,
} from '../src/funciones.js';

const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

/** Nombres canónicos (el primero de cada entrada) de la tabla de comandos del daemon. */
function tableCommands(): string[] {
  const start = cli.indexOf('const commandTable');
  const end = cli.indexOf('registry.startAll', start);
  const table = cli.slice(start, end);
  return [...table.matchAll(/names: \[\s*'([^']+)'/g)].map((m) => m[1] as string);
}

/** Texto de todas las áreas juntas, tal y como las ve `view`. */
function allAreasText(owner: boolean): string {
  return visibleAreas({ owner })
    .map((a) => funcionesText({ owner }, a.id))
    .join('\n');
}

const OWNER = { owner: true };
const OTHER = { owner: false };

describe('/funciones sale del registro, no de una lista a mano', () => {
  it('cada comando de la tabla del daemon aparece en alguna área (salvo start/help)', () => {
    const text = allAreasText(true);
    const commands = tableCommands();
    expect(commands.length).toBeGreaterThan(40);
    const missing = commands
      .filter((c) => c !== 'start' && c !== 'help')
      .filter((c) => !new RegExp(`(^|\\n)/${c}( |\\b)`).test(text));
    expect(missing).toEqual([]);
  });

  it('cada comando del menú de Telegram y de /help aparece (salvo start/help)', () => {
    const text = allAreasText(true);
    const all = new Set([...helpCommands(), ...TELEGRAM_COMMANDS.map((c) => c.command)]);
    for (const c of all) {
      if (c === 'start' || c === 'help') continue;
      expect(text, `/${c} no sale en /funciones`).toContain(`/${c}`);
    }
  });

  it('cada comando va a exactamente un área conocida, y no hay áreas vacías para el dueño', () => {
    const ids = new Set(FUNCION_AREAS.map((a) => a.id));
    const cmds = funcionCommands();
    expect(new Set(cmds.map((c) => c.command)).size).toBe(cmds.length);
    for (const c of cmds) expect(ids.has(c.area), c.command).toBe(true);
    expect(visibleAreas(OWNER).map((a) => a.id)).toEqual(FUNCION_AREAS.map((a) => a.id));
  });

  it('las áreas que pidió Nico están, cada una con un ejemplo en una línea', () => {
    for (const id of [
      'tele',
      'pc',
      'audio',
      'agenda',
      'correo',
      'investigar',
      'compras',
      'memoria',
      'modelo',
      'sistema',
    ]) {
      const area = FUNCION_AREAS.find((a) => a.id === id);
      expect(area, id).toBeDefined();
      expect(area?.example.length).toBeGreaterThan(5);
      expect(area?.example).not.toContain('\n');
    }
  });

  it('los comandos caen donde se espera', () => {
    const areaOf = (c: string) => funcionCommands().find((x) => x.command === c)?.area;
    expect(areaOf('tv')).toBe('tele');
    expect(areaOf('ordenador')).toBe('pc');
    expect(areaOf('altavoz')).toBe('audio');
    expect(areaOf('recordatorios')).toBe('agenda');
    expect(areaOf('correo')).toBe('correo');
    expect(areaOf('investiga')).toBe('investigar');
    expect(areaOf('vigila')).toBe('compras');
    expect(areaOf('proyecto')).toBe('memoria');
    expect(areaOf('modelo')).toBe('modelo');
    expect(areaOf('estado')).toBe('sistema');
    expect(areaOf('funciones')).toBe('sistema');
  });
});

describe('quién ve qué', () => {
  it('todo comando que en cli.ts empieza rechazando a quien no es el dueño está marcado como solo del dueño', () => {
    const guarded = [
      ...cli.matchAll(/const (cmd\w+) = async \([^)]*\)[^{]*\{\s*if \(!isOwnerDm\(/g),
    ].map((m) => m[1] as string);
    expect(guarded.length).toBeGreaterThan(5);
    const start = cli.indexOf('const commandTable');
    const table = cli.slice(start, cli.indexOf('registry.startAll', start));
    for (const fn of guarded) {
      const entry = new RegExp(`names: \\[\\s*'([^']+)'[^\\]]*\\],\\s*run:[^\\n]*\\b${fn}\\(`).exec(
        table,
      );
      if (!entry) continue;
      expect(OWNER_ONLY_COMMANDS.has(entry[1] as string), `/${entry[1]} (${fn})`).toBe(true);
    }
    // Los que delegan con isOwner en un módulo aparte.
    expect(OWNER_ONLY_COMMANDS.has('tv')).toBe(true);
    expect(OWNER_ONLY_COMMANDS.has('ordenador')).toBe(true);
  });

  it('fuera del chat privado del dueño no salen sus comandos ni el área de la tele', () => {
    const text = `${funcionesText(OTHER)}\n${allAreasText(false)}`;
    for (const c of OWNER_ONLY_COMMANDS) expect(text).not.toMatch(new RegExp(`/${c}\\b`));
    expect(visibleAreas(OTHER).some((a) => a.id === 'tele')).toBe(false);
    expect(funcionesText(OTHER, 'tele')).toMatch(/No conozco el área/);
    expect(
      funcionesButtons(OTHER).some((b) => b.action === `${FUNCIONES_CALLBACK_PREFIX}tele`),
    ).toBe(false);
    expect(funcionesText(OTHER)).toMatch(/solo las usa el dueño/);
  });

  it('el dueño ve el área de la tele con /tv', () => {
    expect(funcionesText(OWNER, 'tele')).toContain('/tv');
    expect(funcionesButtons(OWNER)).toHaveLength(FUNCION_AREAS.length);
  });
});

describe('texto y botones', () => {
  it('todo cabe en un mensaje de Telegram', () => {
    expect(Array.from(funcionesText(OWNER)).length).toBeLessThan(4000);
    for (const a of FUNCION_AREAS)
      expect(Array.from(funcionesText(OWNER, a.id)).length).toBeLessThan(4000);
  });

  it('busca áreas por id, alias o palabra del título', () => {
    expect(findArea('tele')?.id).toBe('tele');
    expect(findArea('TV')?.id).toBe('tele');
    expect(findArea('ordenador')?.id).toBe('pc');
    expect(findArea('Recordatorios')?.id).toBe('agenda');
    expect(findArea('vigilantes')?.id).toBe('compras');
    expect(findArea('')).toBeUndefined();
    expect(findArea('xyz')).toBeUndefined();
  });

  it('botones: callback_data corto, «Todas» dentro de un área y sin el área actual', () => {
    for (const b of funcionesButtons(OWNER))
      expect(Buffer.byteLength(b.action)).toBeLessThanOrEqual(64);
    const inside = funcionesButtons(OWNER, 'correo');
    expect(inside[0]).toEqual({ label: '◀ Todas', action: FUNCIONES_CALLBACK_PREFIX });
    expect(inside.some((b) => b.action === `${FUNCIONES_CALLBACK_PREFIX}correo`)).toBe(false);
    expect(funcionesButtonText('fn:correo', OWNER)).toBe(funcionesText(OWNER, 'correo'));
    expect(funcionesButtonText('fn:', OWNER)).toBe(funcionesText(OWNER));
  });
});

const harness = vi.hoisted(() => {
  const sent: Array<{
    chatId: number;
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }> = [];
  const edits: Array<{
    chatId: number;
    messageId: number;
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }> = [];
  const answers: string[] = [];
  const markups: Array<{ chatId: number; messageId: number; rows: number }> = [];
  const handlers = new Map<string, (ctx: unknown) => unknown>();

  /** Mirrors gramY's InlineKeyboard: one row by default, text() fills the last row. */
  class FakeInlineKeyboard {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [[]];
    row(): FakeInlineKeyboard {
      this.inline_keyboard.push([]);
      return this;
    }
    text(label: string, callbackData: string): FakeInlineKeyboard {
      this.inline_keyboard[this.inline_keyboard.length - 1]?.push({
        text: label,
        callback_data: callbackData,
      });
      return this;
    }
  }

  class FakeInputFile {
    readonly data: unknown;
    constructor(data: unknown) {
      this.data = data;
    }
  }

  class FakeGrammyError extends Error {
    readonly error_code: number;
    readonly description: string;
    constructor(errorCode: number, description: string) {
      super(description);
      this.error_code = errorCode;
      this.description = description;
    }
  }

  class FakeHttpError extends Error {}

  class FakeBot {
    readonly api = {
      // The channel installs its polling-health transformer here (grammy API).
      config: {
        use: () => ({}),
      },
      sendMessage: async (
        chatId: number,
        text: string,
        other?: { reply_markup?: FakeInlineKeyboard },
      ) => {
        sent.push({
          chatId,
          text,
          keyboard: other?.reply_markup ? other.reply_markup.inline_keyboard : [],
        });
        return { message_id: sent.length };
      },
      editMessageText: async (
        chatId: number,
        messageId: number,
        text: string,
        other?: {
          reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
        },
      ) => {
        edits.push({
          chatId,
          messageId,
          text,
          keyboard: other?.reply_markup?.inline_keyboard ?? [],
        });
        return true;
      },
      editMessageReplyMarkup: async (
        chatId: number,
        messageId: number,
        other?: { reply_markup?: { inline_keyboard: unknown[] } },
      ) => {
        markups.push({
          chatId,
          messageId,
          rows: other?.reply_markup?.inline_keyboard.length ?? -1,
        });
        return true;
      },
      setMyCommands: async () => true,
    };

    on(event: string, fn: (ctx: unknown) => unknown): void {
      handlers.set(event, fn);
    }

    catch(_handler: (err: unknown) => void): void {}

    async start(opts?: {
      onStart?: (me: { id: number; username: string }) => void;
    }): Promise<void> {
      opts?.onStart?.({ id: 1, username: 'asistenta_test_bot' });
    }

    async stop(): Promise<void> {}
  }

  return {
    sent,
    edits,
    answers,
    markups,
    handlers,
    FakeBot,
    FakeInlineKeyboard,
    FakeInputFile,
    FakeGrammyError,
    FakeHttpError,
  };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.FakeGrammyError,
  HttpError: harness.FakeHttpError,
  InlineKeyboard: harness.FakeInlineKeyboard,
  InputFile: harness.FakeInputFile,
}));

beforeEach(() => {
  harness.sent.length = 0;
  harness.edits.length = 0;
  harness.answers.length = 0;
});

type Press = { channel: string; chatId: string; userId: string; data: string };
type View = { text: string; buttons: Array<{ label: string; action: string }> };

async function makeChannel(
  onFuncionesButton?: (p: Press) => Promise<View>,
): Promise<TelegramChannel> {
  const channel = new TelegramChannel({
    token: 'test-token',
    allowedUserIds: [7, 8],
    approvalTtlMs: 60_000,
  });
  await channel.start({
    onMessage: () => {},
    log: () => {},
    ...(onFuncionesButton ? { onFuncionesButton } : {}),
  });
  return channel;
}

async function press(data: string, chat = 7, userId = 7): Promise<void> {
  const handler = harness.handlers.get('callback_query:data');
  if (!handler) throw new Error('no callback handler');
  await handler({
    callbackQuery: { data, message: { chat: { id: chat }, message_id: 5 } },
    from: { id: userId },
    answerCallbackQuery: async (args?: { text?: string }) => {
      harness.answers.push(args?.text ?? '');
      return true;
    },
  });
}

describe('canal Telegram: botones fn:', () => {
  it('una pulsación edita el mensaje con el área y sus botones', async () => {
    const calls: Press[] = [];
    await makeChannel(async (p) => {
      calls.push(p);
      return {
        text: funcionesButtonText(p.data, OWNER),
        buttons: funcionesButtons(OWNER, 'correo'),
      };
    });
    await press('fn:correo');
    expect(calls).toEqual([{ channel: 'telegram', chatId: '7', userId: '7', data: 'fn:correo' }]);
    expect(harness.answers).toEqual(['']);
    expect(harness.edits).toHaveLength(1);
    expect(harness.edits[0]?.messageId).toBe(5);
    expect(harness.edits[0]?.text).toContain('/correo');
    expect(harness.edits[0]?.keyboard.flat()[0]?.callback_data).toBe('fn:');
    expect(harness.sent).toHaveLength(0);
  });

  it('sin el handler del daemon solo contesta el aviso del botón; nunca va a aprobaciones', async () => {
    await makeChannel();
    await press('fn:tele');
    expect(harness.answers).toEqual(['']);
    expect(harness.edits).toHaveLength(0);
    expect(harness.sent).toHaveLength(0);
  });

  it('un usuario no autorizado no llega al handler', async () => {
    const run = vi.fn(async () => ({ text: 'x', buttons: [] }));
    await makeChannel(run);
    await press('fn:tele', 99, 99);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('registro de canales', () => {
  it('pasa onFuncionesButton del daemon al adaptador', async () => {
    let got: ChannelHandlers | undefined;
    const registry = new ChannelRegistry();
    registry.register({
      name: 'fake',
      account: 'a',
      start: async (h: ChannelHandlers) => {
        got = h;
      },
      stop: async () => {},
    } as unknown as ChannelAdapter);
    await registry.startAll({
      onMessage: () => {},
      onFuncionesButton: async (p: { data: string }) => ({ text: p.data, buttons: [] }),
    } as unknown as ChannelHandlers);
    const view = await got?.onFuncionesButton?.({
      channel: 'telegram',
      chatId: '7',
      userId: '7',
      data: 'fn:pc',
    });
    expect(view).toEqual({ text: 'fn:pc', buttons: [] });
  });
});
