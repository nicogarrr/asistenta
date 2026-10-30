// La lista de disparadores enseña la hora del último disparo en la hora de Nico,
// no la del instante UTC guardado.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoutineTrigger } from '../src/db.js';
import { formatTriggerList } from '../src/triggers.js';

const original = process.env.TZ;
beforeEach(() => {
  process.env.TZ = 'Europe/Madrid';
});
afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

function trigger(lastFiredAt: string | null): RoutineTrigger {
  return {
    id: 't1',
    scope: 'chat:telegram:1#main',
    event: 'archivo',
    match: '.pdf',
    routine: 'archiva',
    args: null,
    cooldownSeconds: 60,
    enabled: true,
    lastFiredAt,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('formatTriggerList: hora local', () => {
  it('invierno (CET): 22:30 UTC se muestra 23:30', () => {
    expect(formatTriggerList([trigger('2026-10-30T22:30:00.000Z')])).toContain(
      'último: 2026-10-30 23:30',
    );
  });

  it('verano (CEST) y cambio de día: 22:30 UTC del 14-jul es 00:30 del 15-jul', () => {
    expect(formatTriggerList([trigger('2026-07-14T22:30:00.000Z')])).toContain(
      'último: 2026-07-15 00:30',
    );
  });

  it('sin disparos o con una fecha corrupta no inventa una hora', () => {
    expect(formatTriggerList([trigger(null)])).not.toContain('último');
    expect(formatTriggerList([trigger('no-es-fecha')])).not.toContain('último');
  });
});
