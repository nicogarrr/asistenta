import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Los resúmenes «líneas repetidas omitidas» pasaban por la misma deduplicación que las líneas
 * que resumen, todos con la misma clave: con más de 20 bucles distintos cerrando en la misma
 * ventana, del 21.º en adelante se perdían y el log daba a entender que esos bucles no
 * existieron. Además, dos errores distintos con el mismo mensaje daban dos resúmenes iguales.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-log-sum-'));
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

describe('resúmenes de muchos bucles a la vez', () => {
  it('escribe un resumen por cada bucle aunque sean más de 20', () => {
    vi.useFakeTimers({ now: new Date('2026-11-03T10:00:00Z') });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (let b = 0; b < 30; b++) for (let i = 0; i < 25; i++) log.warn(`bucle ${b}`);
    vi.advanceTimersByTime(10_500);
    for (let b = 0; b < 30; b++) {
      const s = summaries(`bucle ${b}`);
      expect(s, `bucle ${b}`).toHaveLength(1);
      expect(s[0]?.omitidas).toBe(5);
    }
    // Y ningún «resumen de resúmenes» sin mensaje.
    expect(lines().filter((l) => l.msg === 'líneas repetidas omitidas' && !l.mensaje)).toHaveLength(
      0,
    );
  });

  it('flushLogDedupe vuelca todos los pendientes al cerrar', () => {
    vi.useFakeTimers({ now: new Date('2026-11-03T11:00:00Z') });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (let b = 0; b < 25; b++) for (let i = 0; i < 22; i++) log.error(`cierre ${b}`);
    flushLogDedupe();
    for (let b = 0; b < 25; b++) expect(summaries(`cierre ${b}`), `cierre ${b}`).toHaveLength(1);
  });

  it('el resumen dice de qué error es cuando el mensaje se repite con errores distintos', () => {
    vi.useFakeTimers({ now: new Date('2026-11-03T12:00:00Z') });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (let i = 0; i < 23; i++) log.error('herramienta falló', { err: new Error('ECONNRESET') });
    for (let i = 0; i < 24; i++) log.error('herramienta falló', { err: new Error('ETIMEDOUT') });
    vi.advanceTimersByTime(10_500);
    const s = summaries('herramienta falló');
    expect(s).toHaveLength(2);
    expect(s.map((l) => [l.error, l.omitidas]).sort()).toEqual([
      ['ECONNRESET', 3],
      ['ETIMEDOUT', 4],
    ]);
  });
});
