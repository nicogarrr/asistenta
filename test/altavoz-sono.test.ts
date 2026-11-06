import { describe, expect, it } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';
import { altavozDoneText, routeInboundToAltavoz } from '../src/audio/altavoz-inbound.js';

// Nico (5 nov): «se queda como sonando, y desconozco si ha sonado o no». Al acabar,
// el «🔊 Sonando…» pasa a decir si sonó (y cuánto) o por qué no.
const inbound = {
  channel: 'telegram',
  chatId: '7',
  userId: '7',
  text: '',
  audioFileId: 'f1',
  audioMimeType: 'audio/ogg',
  audioDurationSeconds: 17,
};

function setup(over: { failPc?: boolean } = {}) {
  const done: string[] = [];
  const replies: string[] = [];
  const player = createAltavozPlayer({
    toPlayable: async () => 'f.mp3',
    playOnPc: async () => {
      if (over.failPc) throw new Error('el reproductor salió con 3');
    },
    castToTv: async () => ({ ok: true, message: '' }),
    remove: () => {},
  });
  const deps = {
    desktop: true,
    ownerUserId: 7,
    player,
    download: async () => Buffer.from('x'),
    reply: (t: string) => replies.push(t),
    done: (t: string) => done.push(t),
    key: 'telegram:7',
  };
  return { done, replies, player, deps };
}

describe('altavoz: confirma si sonó', () => {
  it('textos', () => {
    expect(altavozDoneText('pc', 17)).toBe('✅ Sonó en el PC (0:17)');
    expect(altavozDoneText('tele', 75)).toBe('✅ Sonando en la tele (1:15)');
    expect(altavozDoneText('pc')).toBe('✅ Sonó en el PC');
  });

  it('PC: al acabar dice «✅ Sonó en el PC (0:17)»', async () => {
    const s = setup();
    expect(routeInboundToAltavoz(inbound, { ...s.deps, mode: 'pc' })).toBe('queued');
    await s.player.idle();
    expect(s.done).toEqual(['✅ Sonó en el PC (0:17)']);
    expect(s.replies).toEqual([]);
  });

  it('tele aceptada: «✅ Sonando en la tele (0:17)»', async () => {
    const s = setup();
    routeInboundToAltavoz(inbound, { ...s.deps, mode: 'tele' });
    await s.player.idle();
    expect(s.done).toEqual(['✅ Sonando en la tele (0:17)']);
  });

  it('fallo: «⚠️ En el PC no sonó: <motivo>» en el mismo mensaje', async () => {
    const s = setup({ failPc: true });
    routeInboundToAltavoz(inbound, { ...s.deps, mode: 'pc' });
    await s.player.idle();
    expect(s.done).toEqual(['⚠️ En el PC no sonó: el reproductor salió con 3']);
    expect(s.replies).toEqual([]);
  });
});
