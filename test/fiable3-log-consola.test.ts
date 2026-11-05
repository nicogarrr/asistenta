import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// En Windows el lanzador oculto (run-hidden.ps1) manda el stdout de Asistenta a
// log/launcher.stdout.log, que solo se rota al arrancar. Cada línea del registro
// iba también ahí: con días o semanas sin reiniciar era una copia entera de log/
// sin tope, y con el tope del día lleno «el resto va a la consola» seguía llenando
// el disco por ese fichero.
const dirs: string[] = [];
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
  vi.resetModules();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function freshLog(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-log-consola-'));
  dirs.push(dir);
  Object.assign(process.env, { PA_STATE_DIR: dir, ...env });
  vi.resetModules();
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  const mod = await import('../src/log.js');
  return { ...mod, lines, dir };
}

describe('consola del registro', () => {
  it('PA_LOG_CONSOLE=warn: a la consola solo avisos y errores; el fichero lo guarda todo', async () => {
    const { log, lines } = await freshLog({ PA_LOG_CONSOLE: 'warn', PA_LOG_LEVEL: 'info' });
    log.info('routine fired', { routine: 'informe' });
    log.warn('routine send failed', {});
    expect(lines.join('')).not.toContain('routine fired');
    expect(lines.join('')).toContain('routine send failed');
  });

  it('sin PA_LOG_CONSOLE, igual que antes (lo mismo que PA_LOG_LEVEL)', async () => {
    const { consoleThreshold } = await freshLog({});
    expect(consoleThreshold(undefined, 20)).toBe(20);
    expect(consoleThreshold('WARN ', 20)).toBe(30);
    expect(consoleThreshold('debug', 20)).toBe(20);
    expect(consoleThreshold('off', 20)).toBe(Number.POSITIVE_INFINITY);
    expect(consoleThreshold('cualquiera', 20)).toBe(20);
  });

  it('con el día lleno, una consola redirigida a fichero tampoco recibe más', async () => {
    const tty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      const { log, lines, dir } = await freshLog({ PA_LOG_DAY_MAX_MB: '0.001' });
      for (let i = 0; i < 50; i++) log.warn(`bucle de errores ${i}`, { x: 'y'.repeat(40) });
      const day = readFileSync(
        join(dir, 'log', `${(await import('../src/datecontext.js')).localDay()}.jsonl`),
        'utf8',
      );
      const enFichero = day.split('\n').filter((l) => l.includes('bucle de errores')).length;
      const enConsola = lines.filter((l) => l.includes('bucle de errores')).length;
      expect(enFichero).toBeLessThan(50);
      // La que llena el día aún sale por la consola; después, ninguna (antes salían las 50).
      expect(enConsola).toBeLessThanOrEqual(enFichero + 1);
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
    }
  });

  it('el lanzador oculto de Windows pone PA_LOG_CONSOLE=warn si no está puesto', () => {
    const ps1 = readFileSync(new URL('../deploy/windows/run-hidden.ps1', import.meta.url), 'utf8');
    expect(ps1).toMatch(/if \(-not \$env:PA_LOG_CONSOLE\) \{ \$env:PA_LOG_CONSOLE = 'warn' \}/);
    expect(ps1.indexOf('PA_LOG_CONSOLE')).toBeLessThan(ps1.indexOf("'\"' + $cli + '\" serve'"));
  });
});
