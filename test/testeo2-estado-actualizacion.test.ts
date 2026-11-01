import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchdogLastLine } from '../src/autostart-watchdog.js';
import { writeAutoupdateState } from '../src/autoupdate.js';
import { autoupdateStatusLine } from '../src/autoupdate-cli.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-testeo2-estado-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse('2026-11-01T12:00:00Z');

describe('pa autoupdate/autostart status: la última revisión se lee bien', () => {
  it('una revisión de hace 3 días no se dice en minutos', () => {
    writeAutoupdateState(dir, {
      last: {
        kind: 'al-dia',
        text: 'al día (aaaaaaa)',
        at: new Date(NOW - 3 * 86_400_000).toISOString(),
      },
    });
    const line = autoupdateStatusLine(dir, {}, NOW);
    expect(line).toContain('Última (hace 3 días): al día (aaaaaaa).');
    expect(line).not.toContain('4320 min');
  });

  it('de hace 5 horas dice «hace 5 h»', () => {
    writeAutoupdateState(dir, {
      last: {
        kind: 'al-dia',
        text: 'al día (aaaaaaa)',
        at: new Date(NOW - 5 * 3_600_000).toISOString(),
      },
    });
    expect(autoupdateStatusLine(dir, {}, NOW)).toContain('Última (hace 5 h): al día (aaaaaaa).');
  });

  it('un texto que ya acaba en punto no sale con «..»', () => {
    writeAutoupdateState(dir, {
      last: {
        kind: 'revertida',
        text: '⚠️ Una actualización se quedó a medias (¿se apagó o se suspendió el PC?). He vuelto a la versión anterior y lo reintentaré más tarde.',
        at: new Date(NOW - 10 * 60_000).toISOString(),
      },
    });
    const line = autoupdateStatusLine(dir, {}, NOW);
    expect(line).toContain('lo reintentaré más tarde.');
    expect(line).not.toContain('..');
  });

  it('el vigilante: días en vez de minutos y sin «..»', () => {
    expect(watchdogLastLine({ at: NOW - 2 * 86_400_000, text: 'en marcha' }, NOW)).toBe(
      ' Última revisión hace 2 días: en marcha.',
    );
    expect(watchdogLastLine({ at: NOW - 60_000, text: 'en marcha.' }, NOW)).toBe(
      ' Última revisión hace 1 min: en marcha.',
    );
  });
});
