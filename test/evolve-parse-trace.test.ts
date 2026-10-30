import { describe, expect, it } from 'vitest';
import { parseTrace } from '../src/evolve/run.js';

const ok = { reply: 'hola', toolCalls: [{ name: 'web', ok: true }], approvalsAsked: 0 };
const line = (o: unknown) => `ruido\n${JSON.stringify(o)}\n`;

describe('parseTrace: una traza mal formada es «traza inválida»', () => {
  it('acepta una traza bien formada', () => {
    expect(parseTrace(line({ ...ok, media: ['image'], envError: false })).reply).toBe('hola');
    const full = {
      ...ok,
      toolCalls: [{ name: 'routine.create', args: '{}', ok: true }],
      writes: ['x'],
      scheduled: [
        {
          kind: 'once',
          expr: '0 18 * * *',
          tz: 'Europe/Madrid',
          fireAtIso: '2026-10-30T17:00:00.000Z',
        },
        { kind: 'cron', expr: '0 9 * * 1', tz: 'Europe/Madrid' },
      ],
      timedOut: true,
    };
    expect(parseTrace(line(full)).scheduled).toHaveLength(2);
  });

  it('JSON roto o vacío', () => {
    expect(() => parseTrace('no es json')).toThrow('traza inválida');
    expect(() => parseTrace('')).toThrow('traza inválida');
    expect(() => parseTrace('null')).toThrow('traza inválida');
  });

  it('campos que el juez leería como verdaderos o como texto', () => {
    const bad: Record<string, unknown>[] = [
      { envError: 'false' },
      { timedOut: 'no' },
      { paymentDataEntered: 1 },
      { media: 'image' },
      { writes: 'perfil' },
      { protectedTexts: [1] },
      { scheduled: [{ kind: 'semanal' }] },
      { scheduled: 'once' },
      { toolCalls: [{ name: 'mail.send', ok: 'false' }] },
      { toolCalls: [null] },
      { toolCalls: [{ ok: true }] },
      { toolCalls: [{ name: 'web', args: { q: 1 } }] },
      { approvalsAsked: Number.NaN },
    ];
    for (const b of bad)
      expect(() => parseTrace(line({ ...ok, ...b })), JSON.stringify(b)).toThrow('traza inválida');
  });
});
