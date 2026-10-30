import { describe, expect, it } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';
import {
  type AltavozInbound,
  altavozVoiceReplyEnabled,
  routeReplyToAltavoz,
} from '../src/audio/altavoz-inbound.js';

/** PA_ALTAVOZ_VOZ=1: la respuesta a una nota del altavoz se dice en el mismo sitio. */
const OWNER = 424242;
const note = (over: Partial<AltavozInbound> = {}): AltavozInbound => ({
  channel: 'telegram',
  chatId: String(OWNER),
  userId: String(OWNER),
  text: '',
  audioFileId: 'voz',
  ...over,
});

function rig(
  opts: { tele?: boolean; speak?: () => Promise<{ data: Buffer; mimeType: string } | null> } = {},
) {
  const pc: string[] = [];
  const tv: string[] = [];
  const replies: string[] = [];
  const errors: unknown[] = [];
  let spoke = 0;
  const player = createAltavozPlayer({
    toPlayable: async (bytes) => `/tmp/${bytes.toString()}.mp3`,
    playOnPc: async (f) => {
      pc.push(f);
    },
    castToTv: opts.tele
      ? async (f) => {
          tv.push(f);
          return { ok: true, message: 'ok', hits: () => 1 };
        }
      : undefined,
    remove: () => {},
  });
  const route = (
    inbound: AltavozInbound,
    over: {
      enabled?: boolean;
      mode?: 'off' | 'pc' | 'tele';
      desktop?: boolean;
      text?: string;
    } = {},
  ) =>
    routeReplyToAltavoz(inbound, over.text ?? 'Hecho, mañana a las 9.', {
      enabled: over.enabled ?? true,
      mode: over.mode ?? (opts.tele ? 'tele' : 'pc'),
      desktop: over.desktop ?? true,
      ownerUserId: OWNER,
      player,
      speak:
        opts.speak ??
        (async () => {
          spoke++;
          return { data: Buffer.from('respuesta'), mimeType: 'audio/ogg' };
        }),
      reply: (t) => replies.push(t),
      key: `telegram:dm:${inbound.chatId}`,
      onError: (e) => errors.push(e),
    });
  return { player, pc, tv, replies, errors, route, spoke: () => spoke };
}

describe('PA_ALTAVOZ_VOZ', () => {
  it('apagado por defecto; solo «1» lo enciende', () => {
    expect(altavozVoiceReplyEnabled({})).toBe(false);
    expect(altavozVoiceReplyEnabled({ PA_ALTAVOZ_VOZ: '0' })).toBe(false);
    expect(altavozVoiceReplyEnabled({ PA_ALTAVOZ_VOZ: 'si' })).toBe(false);
    expect(altavozVoiceReplyEnabled({ PA_ALTAVOZ_VOZ: '1' })).toBe(true);
  });

  it('sin el flag no se genera ni suena nada', async () => {
    const r = rig();
    expect(r.route(note(), { enabled: false })).toBe('skipped');
    await r.player.idle();
    expect(r.pc).toEqual([]);
    expect(r.spoke()).toBe(0);
  });

  it('con el flag la respuesta suena en el PC', async () => {
    const r = rig();
    expect(r.route(note())).toBe('queued');
    await r.player.idle();
    expect(r.pc).toEqual(['/tmp/respuesta.mp3']);
    expect(r.replies).toEqual([]);
  });

  it('con /altavoz tele suena en la tele, no en el PC', async () => {
    const r = rig({ tele: true });
    expect(r.route(note())).toBe('queued');
    await r.player.idle();
    expect(r.tv).toEqual(['/tmp/respuesta.mp3']);
    expect(r.pc).toEqual([]);
  });

  it('otro chat, otro usuario, altavoz apagado, sin escritorio, texto o respuesta vacía: nada', async () => {
    const r = rig();
    expect(r.route(note({ chatId: '-100777' }))).toBe('skipped');
    expect(r.route(note({ chatId: '555', userId: '555' }))).toBe('skipped');
    expect(r.route(note(), { mode: 'off' })).toBe('skipped');
    expect(r.route(note(), { desktop: false })).toBe('skipped');
    expect(r.route(note({ audioFileId: undefined, text: 'hola' }))).toBe('skipped');
    expect(r.route(note(), { text: '   ' })).toBe('skipped');
    await r.player.idle();
    expect(r.pc).toEqual([]);
    expect(r.spoke()).toBe(0);
  });

  it('la voz se genera dentro de la cola: la llamada vuelve al instante aunque el TTS tarde', async () => {
    let finish: () => void = () => {};
    const slow = new Promise<void>((res) => {
      finish = res;
    });
    const r = rig({
      speak: async () => {
        await slow;
        return { data: Buffer.from('lenta'), mimeType: 'audio/ogg' };
      },
    });
    expect(r.route(note())).toBe('queued');
    expect(r.pc).toEqual([]);
    finish();
    await r.player.idle();
    expect(r.pc).toEqual(['/tmp/lenta.mp3']);
  });

  it('si el TTS falla no avisa en el chat (el texto ya llegó)', async () => {
    const r = rig({ speak: async () => null });
    r.route(note());
    await r.player.idle();
    expect(r.pc).toEqual([]);
    expect(r.replies).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });
});
