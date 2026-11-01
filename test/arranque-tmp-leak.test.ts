import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  markStoppedOnPurpose,
  STOPPED_ON_PURPOSE_FILE,
  saveWatchdogLast,
  WATCHDOG_LAST_FILE,
} from '../src/autostart-watchdog.js';
import { saveStartupRecord } from '../src/startup-record.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** Una carpeta de estado donde el rename final falla: el destino es una carpeta no vacía. */
function blocked(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-tmp-leak-'));
  dirs.push(dir);
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, 'x'), 'x');
  return dir;
}
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

describe('ficheros de estado de arranque: un rename fallido no deja .tmp', () => {
  it('registro de arranque (pa iniciar)', () => {
    const dir = blocked('startup.json');
    saveStartupRecord(join(dir, 'startup.json'), []);
    expect(leftovers(dir)).toEqual([]);
  });

  it('marca de pa stop y última revisión del vigilante', () => {
    const dir = blocked(STOPPED_ON_PURPOSE_FILE);
    mkdirSync(join(dir, WATCHDOG_LAST_FILE));
    writeFileSync(join(dir, WATCHDOG_LAST_FILE, 'x'), 'x');
    markStoppedOnPurpose(dir);
    saveWatchdogLast(dir, 'en marcha');
    expect(leftovers(dir)).toEqual([]);
  });
});
