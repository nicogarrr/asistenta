// touch() existía pero nadie lo llamaba: «Llevas N d sin tocar» salía aunque
// Nico acabara de hablar de ello en ese mismo chat.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { FollowupTracker } from '../src/alerts/followups.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const DAY = 86_400_000;
const T0 = 1_760_000_000_000;
const CHAT = 'telegram:bot:12';

function setup() {
  let now = T0;
  const t = new FollowupTracker({ db: new DatabaseSync(':memory:'), now: () => now });
  t.track(`${CHAT}#principal`, 'promesa', 'pagar el seguro del coche', 0);
  t.track('telegram:bot:-500#principal', 'promesa', 'pagar el seguro del coche', 0);
  now = T0 + 5 * DAY;
  return { t };
}

describe('hablar de un pendiente reinicia su reloj', () => {
  it('mencionarlo en su chat lo saca de «sin tocar» solo en ese chat', () => {
    const { t } = setup();
    expect(t.summarize(T0 + 5 * DAY, { chatKey: CHAT })).toContain('sin tocar');
    expect(t.touchMentioned(CHAT, 'Ya he llamado por lo del seguro del coche')).toBe(1);
    expect(t.summarize(T0 + 5 * DAY, { chatKey: CHAT })).toBe('Todo al día.');
    expect(t.summarize(T0 + 5 * DAY, { chatKey: 'telegram:bot:-500' })).toContain('sin tocar');
  });

  it('un mensaje sin relación no toca nada', () => {
    const { t } = setup();
    expect(t.touchMentioned(CHAT, 'qué tiempo hace mañana en Madrid')).toBe(0);
    expect(t.touchMentioned(CHAT, 'ok')).toBe(0);
    expect(t.summarize(T0 + 5 * DAY, { chatKey: CHAT })).toContain('sin tocar');
  });

  it('el daemon lo llama con cada mensaje del chat', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('followups.touchMentioned(chatKey(inbound), inbound.text)');
  });
});
