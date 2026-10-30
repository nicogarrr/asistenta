import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';
import { TV_FIREWALL_HINT } from '../src/audio/tv-cast.js';

/**
 * La tele acepta la orden pero nunca descarga el fichero (firewall de Windows):
 * quien mandó la nota tiene que enterarse, una sola vez por sesión.
 */
const note = async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' });

function player(hits: () => number, noFetchMs = 15_000) {
  return createAltavozPlayer({
    toPlayable: async () => '/tmp/fake.mp3',
    playOnPc: async () => {},
    castToTv: async () => ({ ok: true, message: 'ok', hits }),
    remove: () => {},
    noFetchMs,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('altavoz tele: aviso de firewall', () => {
  it('avisa si la tele no descarga el fichero en el plazo', async () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const p = player(() => 0);
    p.enqueue('tele', note, undefined, 'chat', (t) => notices.push(t));
    await p.idle();
    expect(notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(TV_FIREWALL_HINT);
  });

  it('no avisa si la tele lo descargó', async () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const p = player(() => 1);
    p.enqueue('tele', note, undefined, 'chat', (t) => notices.push(t));
    await p.idle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(notices).toEqual([]);
  });

  it('solo avisa una vez por sesión', async () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const p = player(() => 0, 1_000);
    p.enqueue('tele', note, undefined, 'chat', (t) => notices.push(t));
    await p.idle();
    await vi.advanceTimersByTimeAsync(1_000);
    p.enqueue('tele', note, undefined, 'chat', (t) => notices.push(t));
    await p.idle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices).toHaveLength(1);
  });

  it('en el PC nunca avisa, y no bloquea la cola mientras espera', async () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const played: string[] = [];
    const p = createAltavozPlayer({
      toPlayable: async () => '/tmp/fake.mp3',
      playOnPc: async () => {
        played.push('pc');
      },
      castToTv: async () => ({ ok: true, message: 'ok', hits: () => 0 }),
      remove: () => {},
    });
    p.enqueue('tele', note, undefined, 'chat', (t) => notices.push(t));
    p.enqueue('pc', note, undefined, 'chat', (t) => notices.push(t));
    await p.idle();
    expect(played).toEqual(['pc']);
    expect(notices).toEqual([]);
  });

  it('un caster sin hits (versión antigua) no avisa', async () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const p = createAltavozPlayer({
      toPlayable: async () => '/tmp/fake.mp3',
      playOnPc: async () => {},
      castToTv: async () => ({ ok: true, message: 'ok' }),
      remove: () => {},
    });
    p.enqueue('tele', note, undefined, 'chat', (t) => notices.push(t));
    await p.idle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notices).toEqual([]);
  });
});
