import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { setDownloadsEnabled } from '../src/ojo-downloads.js';
import { setScreenEnabled } from '../src/ojo-screen.js';
import { setOjoEnabled } from '../src/vigilante.js';
import { formatOverview, fromOjo } from '../src/watch/overview.js';
import { collectWatches, readOjoState } from '../src/watch/overview-cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('pa vigilancias: ojo de águila (pantalla y descargas)', () => {
  it('pantalla/descargas solo cuentan como activas con el ojo general encendido', () => {
    const on = fromOjo({ attention: true, screen: true, downloads: false });
    expect(on.map((e) => [e.id, e.enabled])).toEqual([
      ['ojo', true],
      ['ojo:pantalla', true],
      ['ojo:descargas', false],
    ]);
    const off = fromOjo({ attention: false, screen: true, downloads: true });
    expect(off.every((e) => !e.enabled)).toBe(true);
    expect(off.find((e) => e.id === 'ojo:pantalla')?.detail).toBe('el ojo general está apagado');
  });

  it('el texto agrupa el ojo y no dice «aún no se ha ejecutado» de un interruptor', () => {
    const txt = formatOverview(fromOjo({ attention: true, screen: false, downloads: true }));
    expect(txt).toContain('Ojo de águila (avisos sin modelo) (3)');
    expect(txt).toContain('• Pantalla — avisos que aparecen en pantalla [en pausa]');
    expect(txt).not.toContain('aún no se ha ejecutado');
  });

  it('base sin tablas del ojo: valores por defecto del daemon (general sí, pantalla/descargas no)', () => {
    const db = new DatabaseSync(':memory:');
    expect(readOjoState(db)).toEqual({ attention: true, screen: false, downloads: false });
    db.close();
  });

  it('collectWatches lee los interruptores reales de memory.db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-vig-ojo-'));
    dirs.push(dir);
    const db = new DatabaseSync(join(dir, 'memory.db'));
    setOjoEnabled(db, true);
    setScreenEnabled(db, false);
    setDownloadsEnabled(db, true);
    db.close();
    const ro = new DatabaseSync(join(dir, 'memory.db'), { readOnly: true });
    expect(readOjoState(ro)).toEqual({ attention: true, screen: false, downloads: true });
    ro.close();
    const { entries, errors } = collectWatches({
      stateDir: dir,
      agentDb: join(dir, 'no-existe.db'),
    });
    expect(errors).toEqual([]);
    const ojo = entries.filter((e) => e.kind === 'ojo').map((e) => [e.id, e.enabled]);
    expect(ojo).toEqual([
      ['ojo', true],
      ['ojo:pantalla', false],
      ['ojo:descargas', true],
    ]);
  });
});
