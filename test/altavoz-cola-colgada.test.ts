import { describe, expect, it, vi } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';

// Nico (5 nov): con el altavoz encendido cada nota decía «🔊 Sonando…» y no sonaba
// nada, ni en el PC ni en la tele, ni avisaba. Una nota que se queda colgada (la tele
// no contesta al cast) bloqueaba para siempre la cola: las siguientes, también las
// del PC, esperaban detrás sin sonar ni fallar.
describe('altavoz: una nota colgada no bloquea la cola', () => {
  it('la tele que no contesta falla con aviso y la siguiente nota suena en el PC', async () => {
    vi.useFakeTimers();
    try {
      const played: string[] = [];
      const fails: string[] = [];
      const player = createAltavozPlayer({
        toPlayable: async () => 'f.mp3',
        playOnPc: async (file) => {
          played.push(file);
        },
        castToTv: () => new Promise(() => {}),
        remove: () => {},
        teleCastTimeoutMs: 30_000,
      });
      const load = async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' });
      player.enqueue('tele', load, (e) => fails.push(String((e as Error).message)));
      player.enqueue('pc', load, (e) => fails.push(String(e)));
      await vi.advanceTimersByTimeAsync(31_000);
      await player.idle();
      expect(fails).toHaveLength(1);
      expect(fails[0]).toMatch(/tele no contestó/);
      expect(played).toEqual(['f.mp3']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cualquier paso colgado (descarga, conversión) se corta con aviso', async () => {
    vi.useFakeTimers();
    try {
      const played: string[] = [];
      const fails: string[] = [];
      const player = createAltavozPlayer({
        toPlayable: async () => 'f.mp3',
        playOnPc: async (file) => {
          played.push(file);
        },
        remove: () => {},
        itemTimeoutMs: 60_000,
      });
      const ok = async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' });
      player.enqueue(
        'pc',
        () => new Promise(() => {}),
        (e) => fails.push(String((e as Error).message)),
      );
      player.enqueue('pc', ok);
      await vi.advanceTimersByTimeAsync(61_000);
      await player.idle();
      expect(fails).toHaveLength(1);
      expect(fails[0]).toMatch(/no ha terminado/);
      expect(played).toEqual(['f.mp3']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('altavoz: una cola por aparato', () => {
  it('con la tele colgada, una nota del PC suena ya, sin esperar al tope de la tele', async () => {
    vi.useFakeTimers();
    try {
      const played: string[] = [];
      const player = createAltavozPlayer({
        toPlayable: async () => 'f.mp3',
        playOnPc: async (file) => {
          played.push(file);
        },
        castToTv: () => new Promise(() => {}),
        remove: () => {},
        teleCastTimeoutMs: 30_000,
      });
      const load = async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' });
      player.enqueue('tele', load, () => {});
      player.enqueue('pc', load, () => {});
      await vi.advanceTimersByTimeAsync(1_000);
      expect(played).toEqual(['f.mp3']);
      await vi.advanceTimersByTimeAsync(30_000);
      await player.idle();
    } finally {
      vi.useRealTimers();
    }
  });
});
