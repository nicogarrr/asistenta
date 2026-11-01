import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { FollowupTracker } from '../src/alerts/followups.js';

const DAY = 86_400_000;
const T0 = 1_760_000_000_000;

function tracker(): FollowupTracker {
  return new FollowupTracker({ db: new DatabaseSync(':memory:'), now: () => T0 });
}

describe('pendientes: una promesa con fecha futura no sale como «sin tocar»', () => {
  it('«pagar el seguro» para dentro de un mes no se reprocha a los 5 días', () => {
    const t = tracker();
    t.track('chat#main', 'date', 'pagar el seguro', T0 + 30 * DAY);
    // Antes: «Llevas 5 d sin tocar: pagar el seguro», 25 días antes de la fecha.
    expect(t.summarize(T0 + 5 * DAY)).toBe('Todo al día.');
  });

  it('cuando llega la fecha, vence; las notas sin fecha siguen avisando por silencio', () => {
    const t = tracker();
    t.track('chat#main', 'date', 'pagar el seguro', T0 + 3 * DAY);
    t.track('chat#main', 'contact', 'responder a Juan', 0);
    expect(t.summarize(T0 + 5 * DAY).split('\n')).toEqual([
      'Vence: pagar el seguro',
      'Llevas 5 d sin tocar: responder a Juan',
    ]);
  });
});
