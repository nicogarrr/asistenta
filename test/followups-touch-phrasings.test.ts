import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { FollowupTracker } from '../src/alerts/followups.js';

const CHAT = 'telegram:bot:42';
const DAY = 86_400_000;

function tracker(subject: string) {
  let now = 0;
  const t = new FollowupTracker({ db: new DatabaseSync(':memory:'), now: () => now });
  t.track(`${CHAT}#principal`, 'promesa', subject, 10 * DAY);
  now = 5 * DAY;
  return t;
}

// Frases reales: el verbo genérico no basta para dar por tocada una nota, y una
// palabra corta con contenido («luz», «Ana») sí cuenta.
describe('touchMentioned con frases reales', () => {
  it('«tengo que llamar al banco» no toca «llamar a Juan»', () => {
    expect(tracker('llamar a Juan').touchMentioned(CHAT, 'tengo que llamar al banco')).toBe(0);
  });
  it('«llama a mi madre» no toca «llamar al dentista»', () => {
    expect(tracker('llamar al dentista').touchMentioned(CHAT, 'llama a mi madre')).toBe(0);
  });
  it('«he pagado el alquiler» no toca «pagar la luz», «ya pagué la luz» sí', () => {
    const t = tracker('pagar la luz');
    expect(t.touchMentioned(CHAT, 'he pagado el alquiler')).toBe(0);
    expect(t.touchMentioned(CHAT, 'ya pagué la luz')).toBe(1);
  });
  it('sigue reconociendo «hablé con Juan» y «lo del seguro del coche»', () => {
    expect(tracker('llamar a Juan').touchMentioned(CHAT, 'ya hablé con Juan')).toBe(1);
    expect(
      tracker('pagar el seguro del coche').touchMentioned(CHAT, 'lo del seguro del coche ya está'),
    ).toBe(1);
  });
});
