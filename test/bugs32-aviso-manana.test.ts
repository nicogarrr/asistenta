import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureAndAck } from '../src/bandeja/comando.js';
import type { BandejaQueue } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-32 (11 nov 2026): a las 23:00, ya mandado el resumen de la noche, el aviso seguía
// diciendo «Te digo a las 21:30 si merece la pena»: esa hora ya había pasado y no llegaba nada
// hasta la noche siguiente.

let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs32-aviso-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const queue = { enqueue: async () => undefined } as unknown as BandejaQueue;
const deps = (iso: string) => ({ store, queue, chatId: '111', now: () => new Date(iso), env: {} });

describe('bandeja: el aviso al guardar dice cuándo de verdad', () => {
  it('antes del resumen: «a las 21:30»', () => {
    const r = captureAndAck(deps('2026-11-11T17:00:00Z'), [
      { kind: 'enlace', url: 'https://a.com/1' },
    ]);
    expect(r.text).toContain('Te digo a las 21:30 si merece la pena');
  });

  it('con el resumen de hoy ya mandado: «mañana a las 21:30»', () => {
    store.setMeta('last_digest_day', '2026-11-11');
    const r = captureAndAck(deps('2026-11-11T22:00:00Z'), [
      { kind: 'enlace', url: 'https://a.com/1' },
    ]);
    expect(r.text).toContain('Te digo mañana a las 21:30 si merece la pena');
    const again = captureAndAck(deps('2026-11-11T22:01:00Z'), [
      { kind: 'enlace', url: 'https://a.com/1' },
    ]);
    expect(again.text).toContain('Te lo cuento mañana a las 21:30');
  });

  it('pasada la medianoche vuelve a ser «a las 21:30» (es otro día)', () => {
    store.setMeta('last_digest_day', '2026-11-11');
    const r = captureAndAck(deps('2026-11-12T00:30:00Z'), [
      { kind: 'enlace', url: 'https://a.com/2' },
    ]);
    expect(r.text).toContain('Te digo a las 21:30');
  });
});
