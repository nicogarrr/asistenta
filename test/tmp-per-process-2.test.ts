import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NudgeTracker } from '../src/memory/usermodel.js';
import { RoutineDeliveryStore } from '../src/routine-delivery.js';

// Segunda tanda de #455: `${f}.tmp` fijo compartido entre daemon y CLI. Un tmp
// ocupado por otro proceso ya no bloquea la escritura.
const fresh = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('tmp por proceso (2)', () => {
  it('la entrega de rutinas se guarda aunque routine-delivery.json.tmp esté ocupado', () => {
    const dir = fresh('pa-tmp-deliv-');
    const file = join(dir, 'routine-delivery.json');
    mkdirSync(`${file}.tmp`);
    const store = new RoutineDeliveryStore(file);
    expect(() =>
      store.set('tg:1#main', 'resumen', { target: 'fichero', mode: 'siempre' } as never),
    ).not.toThrow();
    expect(new RoutineDeliveryStore(file).get('tg:1#main', 'resumen')).toMatchObject({
      target: 'fichero',
    });
  });

  it('el registro de sugerencias se guarda aunque su .tmp esté ocupado', () => {
    const dir = fresh('pa-tmp-nudge-');
    const tracker = new NudgeTracker(dir);
    tracker.record('beber agua', '2026-10-29');
    const [file] = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((n) => n.endsWith('.json'));
    mkdirSync(join(dir, `${file}.tmp`));
    expect(() => tracker.record('beber agua', '2026-10-30')).not.toThrow();
    expect(new NudgeTracker(dir).daysFor('beber agua')).toBe(2);
  });
});
