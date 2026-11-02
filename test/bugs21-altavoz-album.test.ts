/**
 * Altavoz (modo megáfono, #1907) con varios audios enviados juntos (álbum, #1842): solo
 * sonaba el primero; el resto ni sonaba ni se transcribía, porque el mensaje acaba ahí.
 * Ahora suenan todos, en orden, detrás del primero. Reproductor y descarga falsos.
 */
import { describe, expect, it } from 'vitest';
import type { AltavozPlayer } from '../src/audio/altavoz.js';
import { routeInboundToAltavoz } from '../src/audio/altavoz-inbound.js';

function fakePlayer(max = 10) {
  const loads: Array<() => Promise<{ bytes: Buffer; mimeType: string } | null>> = [];
  const player = {
    enqueue: (_mode: unknown, load: (typeof loads)[number]) => {
      if (loads.length >= max) return false;
      loads.push(load);
      return true;
    },
  } as unknown as AltavozPlayer;
  return { player, loads };
}

const inbound = {
  channel: 'telegram',
  chatId: '7',
  userId: '7',
  text: '',
  audioFileId: 'a',
  audioMimeType: 'audio/ogg',
  albumAudios: [{ fileId: 'b', mimeType: 'audio/mpeg' }, { fileId: 'c' }],
};

const deps = (player: AltavozPlayer, replies: string[] = []) => ({
  mode: 'pc' as const,
  desktop: true,
  ownerUserId: 7,
  player,
  download: async (id: string) => Buffer.from(id),
  reply: (t: string) => void replies.push(t),
  key: 'telegram:7',
});

describe('altavoz con varios audios a la vez', () => {
  it('suenan todos los audios del álbum, en orden', async () => {
    const { player, loads } = fakePlayer();
    expect(routeInboundToAltavoz(inbound, deps(player))).toBe('queued');
    const got = await Promise.all(loads.map((l) => l()));
    expect(got.map((g) => g?.bytes.toString())).toEqual(['a', 'b', 'c']);
    expect(got.map((g) => g?.mimeType)).toEqual(['audio/ogg', 'audio/mpeg', 'audio/ogg']);
  });

  it('si la cola se llena a mitad, se dice una vez y lo que entró suena', async () => {
    const { player, loads } = fakePlayer(2);
    const replies: string[] = [];
    expect(routeInboundToAltavoz(inbound, deps(player, replies))).toBe('queued');
    expect(loads).toHaveLength(2);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/cola/);
  });

  it('un audio suelto sigue igual', () => {
    const { player, loads } = fakePlayer();
    const { albumAudios: _, ...solo } = inbound;
    expect(routeInboundToAltavoz(solo, deps(player))).toBe('queued');
    expect(loads).toHaveLength(1);
  });
});
