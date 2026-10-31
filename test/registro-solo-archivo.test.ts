import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logFile } from '../src/log.js';
import { paths } from '../src/paths.js';

afterEach(() => vi.restoreAllMocks());

const registro = (): string =>
  existsSync(paths.log)
    ? readdirSync(paths.log)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => readFileSync(join(paths.log, f), 'utf8'))
        .join('')
    : '';

describe('logFile: el detalle va al registro, no a la consola', () => {
  it('no escribe en la consola y sí en el archivo del día', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const marca = `marca-${Date.now()}-${Math.random()}`;
    logFile.warn('prueba solo archivo', { err: `ENOSPC: no space left ${marca}` });
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(registro()).toContain(marca);
  });

  it('tapa secretos igual que log', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const marca = `m-${Date.now()}`;
    logFile.error(`fallo ${marca}`, { token: 'abc123secreto' });
    const texto = registro();
    expect(texto).toContain(marca);
    expect(texto).not.toContain('abc123secreto');
  });

  it('pa autostart guarda en el registro el error de la carpeta temporal', () => {
    const src = readFileSync(new URL('../src/autostart.ts', import.meta.url), 'utf8');
    expect(src).toMatch(
      /catch \(err\) \{\s*logFile\.warn\('autostart: watchdog temp XML write failed'/,
    );
  });
});
