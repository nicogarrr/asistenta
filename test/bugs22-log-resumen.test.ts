import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * El resumen «líneas repetidas omitidas» solo salía si el mismo mensaje volvía tras la ventana
 * de 10 s. Si el bucle paraba (lo normal: se arregla solo o el daemon se cierra), lo omitido
 * no se contaba nunca y el log daba a entender 20 errores donde hubo miles.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-log-ddf-'));
process.env.PA_STATE_DIR = stateDir;
delete process.env.PA_LOG_LEVEL;
const { log, resetLogDedupe, flushLogDedupe } = await import('../src/log.js');
const { localDay } = await import('../src/datecontext.js');
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetLogDedupe();
});

const lines = (): Array<Record<string, unknown>> =>
  readFileSync(join(stateDir, 'log', `${localDay()}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const summaries = (mensaje: string) =>
  lines().filter((l) => l.msg === 'líneas repetidas omitidas' && l.mensaje === mensaje);

describe('resumen de líneas repetidas', () => {
  it('sale al cerrar la ventana aunque el mensaje no vuelva', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (let i = 0; i < 25; i++) log.warn('bucle que para');
    expect(summaries('bucle que para')).toHaveLength(0);
    vi.advanceTimersByTime(10_500);
    const s = summaries('bucle que para');
    expect(s).toHaveLength(1);
    expect(s[0]?.omitidas).toBe(5);
  });

  it('no lo cuenta dos veces si el mensaje vuelve después', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T13:00:00Z') });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (let i = 0; i < 23; i++) log.error('vuelve luego');
    vi.advanceTimersByTime(10_500);
    log.error('vuelve luego');
    vi.advanceTimersByTime(20_000);
    const s = summaries('vuelve luego');
    expect(s).toHaveLength(1);
    expect(s[0]?.omitidas).toBe(3);
  });

  it('flushLogDedupe (al cerrar) escribe lo pendiente', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T14:00:00Z') });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (let i = 0; i < 30; i++) log.error('se cierra el daemon');
    flushLogDedupe();
    const s = summaries('se cierra el daemon');
    expect(s).toHaveLength(1);
    expect(s[0]?.omitidas).toBe(10);
    vi.advanceTimersByTime(20_000);
    expect(summaries('se cierra el daemon')).toHaveLength(1);
  });

  it('sin omitidas no escribe resumen', () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T15:00:00Z') });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (let i = 0; i < 20; i++) log.warn('justo veinte');
    vi.advanceTimersByTime(20_000);
    flushLogDedupe();
    expect(summaries('justo veinte')).toHaveLength(0);
  });
});
