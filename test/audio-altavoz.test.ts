import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALTAVOZ_MAX_QUEUE,
  AltavozStore,
  altavozStatusText,
  createAltavozPlayer,
  parseAltavozArgs,
} from '../src/audio/altavoz.js';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-altavoz-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseAltavozArgs', () => {
  it.each([
    ['', 'show'],
    ['estado', 'show'],
    ['on', 'pc'],
    ['PC', 'pc'],
    ['ordenador', 'pc'],
    ['tele', 'tele'],
    ['televisión', 'tele'],
    ['off', 'off'],
    ['apaga', 'off'],
  ])('«%s» → %s', (arg, want) => {
    const p = parseAltavozArgs(arg);
    if (want === 'show') expect(p).toEqual({ kind: 'show' });
    else expect(p).toEqual({ kind: 'set', mode: want });
  });
  it('lo desconocido es un error, no un «on» por defecto', () => {
    expect(parseAltavozArgs('quizás')).toEqual({ kind: 'error' });
  });
});

describe('AltavozStore', () => {
  it('apagado por defecto, persiste por chat y off borra la entrada', () => {
    const file = join(dir, 'altavoz.json');
    const s = new AltavozStore(file);
    expect(s.get('a')).toBe('off');
    s.set('a', 'pc');
    s.set('b', 'tele');
    expect(new AltavozStore(file).get('a')).toBe('pc');
    expect(new AltavozStore(file).get('b')).toBe('tele');
    s.set('a', 'off');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ b: 'tele' });
  });
  it('un fichero corrupto o con valores raros deja todo apagado', () => {
    const file = join(dir, 'altavoz.json');
    writeFileSync(file, '{"a":"siempre","b":');
    expect(new AltavozStore(file).get('a')).toBe('off');
    writeFileSync(file, '{"a":"siempre"}');
    expect(new AltavozStore(file).get('a')).toBe('off');
  });
  it('textos en español', () => {
    expect(altavozStatusText('pc')).toContain('PC');
    expect(altavozStatusText('off')).toContain('apagado');
  });
});

describe('createAltavozPlayer', () => {
  const load = (tag: string) => async () => ({ bytes: Buffer.from(tag), mimeType: 'audio/ogg' });

  it('suena en serie, en orden, y borra cada copia', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const removed: string[] = [];
    const p = createAltavozPlayer({
      toPlayable: async (b) => `${b.toString()}.mp3`,
      playOnPc: async (f) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        order.push(f);
        active--;
      },
      remove: (f) => removed.push(f),
    });
    p.enqueue('pc', load('1'));
    p.enqueue('pc', load('2'));
    p.enqueue('pc', load('3'));
    await p.idle();
    expect(order).toEqual(['1.mp3', '2.mp3', '3.mp3']);
    expect(maxActive).toBe(1);
    expect(removed).toEqual(order);
  });

  it('un fallo no para las siguientes y se informa', async () => {
    const onError = vi.fn();
    const played: string[] = [];
    const p = createAltavozPlayer({
      toPlayable: async (b) => `${b.toString()}.mp3`,
      playOnPc: async (f) => {
        if (f === 'mala.mp3') throw new Error('sin dispositivo');
        played.push(f);
      },
      remove: () => {},
      onError,
    });
    p.enqueue('pc', load('mala'));
    p.enqueue('pc', async () => null);
    p.enqueue('pc', load('buena'));
    await p.idle();
    expect(played).toEqual(['buena.mp3']);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('tele: entrega al caster; sin caster lo dice y borra la copia', async () => {
    const castToTv = vi.fn(async () => ({ ok: true, message: 'ok' }));
    const playOnPc = vi.fn();
    const p = createAltavozPlayer({
      toPlayable: async () => 'x.mp3',
      playOnPc,
      castToTv,
      remove: () => {},
    });
    p.enqueue('tele', load('x'));
    await p.idle();
    expect(castToTv).toHaveBeenCalledWith('x.mp3');
    expect(playOnPc).not.toHaveBeenCalled();

    const file = join(dir, 'y.mp3');
    writeFileSync(file, 'y');
    const onError = vi.fn();
    const q = createAltavozPlayer({
      toPlayable: async () => file,
      playOnPc,
      remove: (f) => rmSync(f, { force: true }),
      onError,
    });
    q.enqueue('tele', load('y'));
    await q.idle();
    expect(String(onError.mock.calls[0]?.[0])).toContain('PA_AUDIO_TELE');
    expect(existsSync(file)).toBe(false);
  });

  it('la cola tiene tope', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const p = createAltavozPlayer({
      toPlayable: async () => 'f',
      playOnPc: () => gate,
      remove: () => {},
    });
    for (let i = 0; i < ALTAVOZ_MAX_QUEUE; i++) expect(p.enqueue('pc', load(String(i)))).toBe(true);
    expect(p.enqueue('pc', load('extra'))).toBe(false);
    release();
    await p.idle();
    expect(p.pending()).toBe(0);
  });
});

describe('aviso por nota fallida', () => {
  it('quien mandó la nota se entera de por qué no sonó; las demás siguen', async () => {
    const onFail = vi.fn();
    const played: string[] = [];
    const p = createAltavozPlayer({
      toPlayable: async (b) => b.toString(),
      playOnPc: async (f) => {
        if (f === 'mala') throw new Error('sin dispositivo de audio');
        played.push(f);
      },
      remove: () => {},
    });
    p.enqueue('pc', async () => ({ bytes: Buffer.from('mala'), mimeType: 'audio/ogg' }), onFail);
    p.enqueue(
      'pc',
      async () => ({ bytes: Buffer.from('buena'), mimeType: 'audio/ogg' }),
      () => {
        throw new Error('el aviso también falla');
      },
    );
    p.enqueue('pc', async () => ({ bytes: Buffer.from('otra'), mimeType: 'audio/ogg' }));
    await p.idle();
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(String(onFail.mock.calls[0]?.[0])).toContain('sin dispositivo');
    expect(played).toEqual(['buena', 'otra']);
  });
});

describe('menú de Telegram', () => {
  it('incluye /altavoz', () => {
    expect(TELEGRAM_COMMANDS.some((c) => c.command === 'altavoz')).toBe(true);
  });
});
