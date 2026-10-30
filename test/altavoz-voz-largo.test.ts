import { describe, expect, it } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';
import {
  ALTAVOZ_VOZ_TELE_MAX_CHARS,
  type AltavozInbound,
  routeReplyToAltavoz,
} from '../src/audio/altavoz-inbound.js';

/**
 * PA_ALTAVOZ_VOZ=1: una respuesta muy larga no se dice en la tele (el texto ya está en el
 * chat), y /stop tira también la respuesta hablada que espera en la cola.
 */
const OWNER = 424242;
const KEY = 'telegram:personal:424242';
const inbound: AltavozInbound = {
  channel: 'telegram',
  chatId: String(OWNER),
  userId: String(OWNER),
  text: '',
  audioFileId: 'voz',
};

function rig(mode: 'pc' | 'tele', opts: { holdPc?: Promise<void> } = {}) {
  let spoke = 0;
  const pc: string[] = [];
  const tv: string[] = [];
  const player = createAltavozPlayer({
    toPlayable: async (bytes) => `/tmp/${bytes.toString()}.mp3`,
    playOnPc: async (f, signal) => {
      pc.push(f);
      if (opts.holdPc) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
          void opts.holdPc?.then(resolve);
        });
      }
    },
    castToTv: async (f) => {
      tv.push(f);
      return { ok: true, message: 'ok', hits: () => 1 };
    },
    remove: () => {},
  });
  const route = (text: string) =>
    routeReplyToAltavoz(inbound, text, {
      enabled: true,
      mode,
      desktop: true,
      ownerUserId: OWNER,
      player,
      key: KEY,
      reply: () => {},
      speak: async () => {
        spoke++;
        return { data: Buffer.from('respuesta'), mimeType: 'audio/ogg' };
      },
    });
  return { player, route, pc, tv, spoken: () => spoke };
}

// 1600 caracteres: más de un minuto de voz.
const long = 'palabra '.repeat(200);

describe('PA_ALTAVOZ_VOZ: respuestas largas en la tele', () => {
  it('el límite es de 700 caracteres', () => {
    expect(ALTAVOZ_VOZ_TELE_MAX_CHARS).toBe(700);
  });

  it('una respuesta muy larga no se dice en la tele', async () => {
    const r = rig('tele');
    expect(r.route(long)).toBe('skipped');
    await r.player.idle();
    expect(r.spoken()).toBe(0);
    expect(r.tv).toEqual([]);
  });

  it('justo en el límite sí se dice', async () => {
    const r = rig('tele');
    expect(r.route('a'.repeat(700))).toBe('queued');
    await r.player.idle();
    expect(r.tv).toHaveLength(1);
  });

  it('en el PC la respuesta larga se sigue diciendo', async () => {
    const r = rig('pc');
    expect(r.route(long)).toBe('queued');
    await r.player.idle();
    expect(r.pc).toHaveLength(1);
  });
});

describe('PA_ALTAVOZ_VOZ: /stop', () => {
  it('/stop tira la respuesta hablada que espera detrás de la nota: no se genera ni suena', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig('pc', { holdPc: hold });
    r.player.enqueue(
      'pc',
      async () => ({ bytes: Buffer.from('nota'), mimeType: 'audio/ogg' }),
      undefined,
      KEY,
    );
    expect(r.route('Hecho, mañana a las 9.')).toBe('queued');
    await new Promise((res) => setTimeout(res, 0));
    expect(r.pc).toEqual(['/tmp/nota.mp3']);
    expect(r.player.clear(KEY)).toBe(2);
    release();
    await r.player.idle();
    expect(r.spoken()).toBe(0);
    expect(r.pc).toEqual(['/tmp/nota.mp3']);
    expect(r.player.pending()).toBe(0);
  });
});
