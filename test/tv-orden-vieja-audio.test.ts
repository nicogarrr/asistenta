import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { staleGuardedCaster } from '../src/tv/stale-order.js';

// «Reprodúcelo en la tele» de un mensaje que llegó tarde no abre el audio en la tele.
describe('audio a la tele desde un mensaje viejo', () => {
  it('no manda nada a la tele, lo dice y borra la copia', async () => {
    const cast: string[] = [];
    const removed: string[] = [];
    const guarded = staleGuardedCaster(
      async (f) => {
        cast.push(f);
        return { ok: true, message: 'sonando' };
      },
      () => 'No he tocado la tele: llegó tarde.',
      (f) => void removed.push(f),
    );
    const res = await guarded('/tmp/nota.mp3');
    expect(cast).toEqual([]);
    expect(removed).toEqual(['/tmp/nota.mp3']);
    expect(res).toEqual({ ok: false, message: 'No he tocado la tele: llegó tarde.' });
  });

  it('mensaje a tiempo: el audio va a la tele como siempre', async () => {
    const cast: string[] = [];
    const guarded = staleGuardedCaster(
      async (f) => {
        cast.push(f);
        return { ok: true, message: 'sonando' };
      },
      () => null,
      () => {},
    );
    expect(await guarded('/tmp/nota.mp3')).toEqual({ ok: true, message: 'sonando' });
    expect(cast).toEqual(['/tmp/nota.mp3']);
  });

  it('el daemon envuelve el cast de la tool de audio', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/staleGuardedCaster\(\s*tvCasterFromVault\(/);
  });
});
