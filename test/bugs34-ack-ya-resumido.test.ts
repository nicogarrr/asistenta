import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ackText } from '../src/bandeja/formato.js';
import type { BandejaItem } from '../src/bandeja/store.js';

// bugs-34: mandar otra vez algo que ya se juzgó y ya salió en un resumen contestaba
// «📥 Eso ya estaba en la bandeja… Te lo cuento a las 21:30». Pero ya no vuelve a salir
// (digestItems solo repite lo 🔴): la promesa era falsa y Nico esperaba en balde.
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
});

const item = (over: Partial<BandejaItem>): BandejaItem =>
  ({
    id: 12,
    chatId: '1',
    kind: 'enlace',
    url: 'https://example.com/a',
    title: 'Por qué suben los tipos',
    status: 'listo',
    verdict: 'ideas',
    score: 7,
    state: 'pendiente',
    extra: {},
    day: '2026-11-10',
    digestedAt: '2026-11-10T20:30:05.000Z',
    ...over,
  }) as BandejaItem;

describe('aviso al guardar algo que ya salió en un resumen', () => {
  it('dice lo que ya se sabe, no «te lo cuento a las 21:30»', () => {
    const text = ackText([{ item: item({}), dup: true }], 0, '21:30');
    expect(text).not.toContain('Te lo cuento');
    expect(text).toContain('ya lo miré');
    expect(text).toContain('🟡 7/10 «Por qué suben los tipos»');
    expect(text).toContain('resumen del 10/11');
    expect(text).toContain('/bandeja ficha 12');
  });

  it('lo pendiente de juzgar o lo 🔴 (que se arrastra) sigue con su hora', () => {
    expect(
      ackText(
        [{ item: item({ status: 'nuevo', verdict: null, digestedAt: null }), dup: true }],
        1,
        '21:30',
      ),
    ).toContain('Te lo cuento a las 21:30');
    expect(
      ackText([{ item: item({ verdict: 'imprescindible', score: 9 }), dup: true }], 1, '21:30'),
    ).toContain('Te lo cuento a las 21:30');
    expect(ackText([{ item: item({ digestedAt: null }), dup: true }], 1, '21:30')).toContain(
      'Te lo cuento a las 21:30',
    );
  });
});
