import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { staleTvOrderNotice } from '../src/tv/stale-order.js';

// Lo que cuenta es lo que tardó el mensaje en llegar, no lo que esperó en la cola
// del chat: un «pausa» recibido al momento detrás de un turno largo es una orden en vivo.
describe('orden a la tele que espera en la cola', () => {
  const sent = '2026-10-30T23:30:00.000Z';

  it('llegó a los 5 s: se hace aunque el turno empiece 10 min después', () => {
    expect(staleTvOrderNotice(sent, '2026-10-30T23:30:05.000Z')).toBeNull();
  });

  it('llegó 25 min tarde (Asistenta apagada): no se hace', () => {
    expect(staleTvOrderNotice(sent, '2026-10-30T23:55:00.000Z')).toMatch(
      /No he tocado la tele.*hace 25 min/,
    );
  });

  it('fecha de llegada ilegible: no se adivina', () => {
    expect(staleTvOrderNotice(sent, 'x')).toBeNull();
  });

  it('el daemon pasa la hora de llegada del mensaje', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/staleTvOrderNotice\(inbound\.sentAt, inbound\.receivedAt\)/);
    expect(cli).toMatch(
      /staleTvOrderNotice\(inboundFor\(thread\)\.sentAt, inboundFor\(thread\)\.receivedAt\)/,
    );
  });
});
