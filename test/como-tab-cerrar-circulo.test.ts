import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { FollowupTracker } from '../src/alerts/followups.js';
import {
  CHECKIN_GRACE_MS,
  CHECKIN_MIN_GAP_MS,
  CloseLoop,
  checkInLine,
  pickCheckIn,
} from '../src/daemon/close-loop.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/**
 * Como Tab: algo con fecha que contaste ya pasó y Asistenta pregunta una vez qué tal
 * fue, sin que se lo pidas. Seguimientos reales (sqlite en memoria) y Telegram falso.
 */
const HOUR = 3_600_000;
const T0 = 1_760_000_000_000;
const DM = 'telegram:dm:42';
/** Los seguimientos van por hilo del chat: `<chat>#<hilo>`. */
const THREAD = `${DM}#main`;

function setup(opts: { quiet?: boolean; sendOk?: boolean } = {}) {
  let now = T0;
  const tracker = new FollowupTracker({ db: new DatabaseSync(':memory:'), now: () => now });
  const sent: string[] = [];
  const loop = new CloseLoop({
    followups: () => tracker.forChat(DM, 200),
    markAsked: (id, at) => tracker.markPushed(id, at),
    resolve: (id) => tracker.resolve(id),
    send: async (text) => {
      sent.push(text);
      return opts.sendOk ?? true;
    },
    now: () => now,
    quiet: () => opts.quiet ?? false,
    enabled: () => true,
  });
  return {
    tracker,
    sent,
    loop,
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe('cerrar el círculo con lo que tenía fecha', () => {
  it('antes de la hora (y justo después) no pregunta nada', async () => {
    const c = setup();
    c.tracker.track(THREAD, 'date', 'dentista el martes a las 10', T0 + HOUR);
    expect(await c.loop.tick()).toBeNull();
    c.at(T0 + HOUR + 30 * 60_000);
    expect(await c.loop.tick()).toBeNull();
    expect(c.sent).toEqual([]);
  });

  it('pasada la hora pregunta una vez qué tal fue, y no insiste', async () => {
    const c = setup();
    c.tracker.track(THREAD, 'date', 'dentista el martes a las 10', T0);
    c.at(T0 + CHECKIN_GRACE_MS + 60_000);
    const text = await c.loop.tick();
    expect(text).toMatch(/«dentista el martes a las 10»\?/);
    expect(text).toMatch(/ya está/);
    c.at(T0 + CHECKIN_GRACE_MS + CHECKIN_MIN_GAP_MS + 60_000);
    expect(await c.loop.tick()).toBeNull();
    expect(c.sent).toHaveLength(1);
  });

  it('respeta las horas de silencio', async () => {
    const c = setup({ quiet: true });
    c.tracker.track(THREAD, 'date', 'recoger el paquete', T0);
    c.at(T0 + 3 * HOUR);
    expect(await c.loop.tick()).toBeNull();
    expect(c.sent).toEqual([]);
  });

  it('una pregunta cada vez, con hueco entre ellas', async () => {
    const c = setup();
    c.tracker.track(THREAD, 'date', 'cita del banco', T0);
    c.tracker.track(THREAD, 'date', 'llega el paquete', T0 + 10 * 60_000);
    c.at(T0 + 3 * HOUR);
    await c.loop.tick();
    await c.loop.tick();
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatch(/cita del banco/);
    c.at(T0 + 3 * HOUR + CHECKIN_MIN_GAP_MS);
    await c.loop.tick();
    expect(c.sent[1]).toMatch(/llega el paquete/);
  });

  it('lo de hace días ya no se saca', () => {
    const c = setup();
    c.tracker.track(THREAD, 'date', 'viejo', T0);
    expect(pickCheckIn(c.tracker.forChat(DM), T0 + 5 * 24 * HOUR)).toBeNull();
  });

  it('«ya está» poco después cierra el pendiente; otra frase no', async () => {
    const c = setup();
    c.tracker.track(THREAD, 'date', 'dentista', T0);
    c.at(T0 + 3 * HOUR);
    await c.loop.tick();
    expect(c.loop.answered('mañana te cuento qué tal')).toBeNull();
    expect(c.loop.answered('Ya está, gracias')).not.toBeNull();
    expect(c.tracker.forChat(DM)[0]?.status).toBe('done');
    expect(c.loop.answered('hecho')).toBeNull();
  });

  it('sin pregunta reciente, «hecho» no cierra nada', () => {
    const c = setup();
    c.tracker.track(THREAD, 'date', 'dentista', T0);
    expect(c.loop.answered('hecho')).toBeNull();
    expect(c.tracker.forChat(DM)[0]?.status).toBe('pending');
  });

  it('un aviso antes de la fecha no cuenta como la pregunta de después', async () => {
    const c = setup();
    c.tracker.track(THREAD, 'date', 'pagar el seguro', T0);
    c.tracker.markPushed(c.tracker.forChat(DM)[0]?.id ?? '', T0 - 10 * HOUR);
    c.at(T0 + 3 * HOUR);
    expect(await c.loop.tick()).toMatch(/pagar el seguro/);
  });

  it('la pregunta es corta y en llano', () => {
    const line = checkInLine(`${'muy largo '.repeat(30)}.`, () => 0);
    expect(line.length).toBeLessThanOrEqual(170);
    expect(line).toMatch(/^¿Qué tal fue lo de «/);
  });

  it('el daemon la cablea: tic periódico y «ya está» antes de gastar un turno', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('void closeLoop.tick()');
    expect(cli).toContain('closeLoop.answered(inbound.text)');
  });
});
