import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchdogLastLine } from '../src/autostart-watchdog.js';
import { writeAutoupdateState } from '../src/autoupdate.js';
import { autoupdateStatusLine } from '../src/autoupdate-cli.js';
import { ago, formatStartupRecord } from '../src/startup-record.js';

// Tras corregir la hora hacia atrás (reloj adelantado, arranque dual), un
// registro guardado «en el futuro» no debe leerse como «hace un momento».
const now = new Date('2026-10-31T10:00:00Z');
const in3h = '2026-10-31T13:00:00Z';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-fecha-futura-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('estado con fecha futura', () => {
  it('pa autostart status: la comprobación de arranque dice que la fecha es futura', () => {
    expect(ago(in3h, now)).toBe('con fecha futura (dentro de 3 h; ¿se cambió el reloj?)');
    const line = formatStartupRecord({ at: in3h, ok: true, fallos: [], avisos: [] }, now);
    expect(line).not.toContain('hace un momento');
    expect(line).toContain('con fecha futura');
  });

  it('unos segundos por delante sigue siendo «hace un momento»; fecha rota no dice NaN', () => {
    expect(ago('2026-10-31T10:00:20Z', now)).toBe('hace un momento');
    expect(ago('2026-10-31T09:55:00Z', now)).toBe('hace 5 min');
    expect(ago('no-es-fecha', now)).toBe('en fecha desconocida');
  });

  it('vigilante: la última revisión con fecha futura no dice «hace 0 min»', () => {
    const line = watchdogLastLine({ at: Date.parse(in3h), text: 'en marcha' }, now.getTime());
    expect(line).toBe(
      ' Última revisión con fecha futura (dentro de 3 h; ¿se cambió el reloj?): en marcha.',
    );
    expect(watchdogLastLine({ at: now.getTime() - 7 * 60_000, text: 'ok' }, now.getTime())).toBe(
      ' Última revisión hace 7 min: ok.',
    );
  });

  it('autoactualización: la última revisión con fecha futura no dice «hace 0 min»', () => {
    writeAutoupdateState(dir, { last: { at: in3h, text: 'al día' } } as never);
    const line = autoupdateStatusLine(dir, {}, now.getTime());
    expect(line).not.toContain('hace 0 min');
    expect(line).toContain(
      'Última (con fecha futura (dentro de 3 h; ¿se cambió el reloj?)): al día.',
    );
  });
});
