import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Watchdog } from '../src/watchdog.js';

const NOW = Date.UTC(2026, 9, 31, 9, 0, 0);
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-vigilante-informe-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const jerga = /heartbeat|turno|pid|watchdog|EACCES|Error:|[\\/]agent\./i;

describe('informe del vigilante en castellano llano', () => {
  it('latido viejo y reinicio: sin ruta, sin pid, sin «turno»', async () => {
    const beat = join(dir, 'agent.heartbeat');
    writeFileSync(beat, String(NOW - 10 * 60_000));
    const wd = new Watchdog({
      heartbeatFile: beat,
      staleAfterMs: 120_000,
      now: () => NOW,
      readPid: () => 4242,
      kill: () => {},
      restart: () => {},
      lastTurn: () => 'revisó el correo',
    });
    const text = wd.summary(await wd.check());
    expect(text).toContain('Lo último que hizo: revisó el correo.');
    expect(text).toContain('La reinicio.');
    expect(text).not.toMatch(jerga);
    expect(text).not.toContain(dir);
  });

  it('sin latido y con fallo al reiniciar: frase llana, sin ruta ni error', async () => {
    const beat = join(dir, 'agent.heartbeat');
    const wd = new Watchdog({
      heartbeatFile: beat,
      staleAfterMs: 120_000,
      now: () => NOW,
      readPid: () => null,
      restart: () => {
        throw new Error('EACCES: permission denied, open C:\\Asistenta\\x');
      },
    });
    const text = wd.summary(await wd.check());
    expect(text).toContain('todavía no ha dado señales de vida');
    expect(text).toContain('No encuentro su proceso para cerrarlo, así que no toco nada.');
    expect(text).not.toMatch(jerga);
    expect(text).not.toContain(dir);
  });
});
