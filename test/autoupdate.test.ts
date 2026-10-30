import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autoupdateDue,
  autoupdateEnabled,
  autoupdateIntervalMin,
  cleanSubject,
  formatChangelog,
  lockHeld,
  readAutoupdateState,
  successMessage,
  tryLock,
  unlock,
  writeAutoupdateState,
} from '../src/autoupdate.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupdate-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('candado y estado', () => {
  it('dos revisiones nunca se pisan', () => {
    expect(tryLock(dir)).toBe(true);
    expect(tryLock(dir)).toBe(false);
    expect(lockHeld(dir)).toBe(true);
    unlock(dir);
    expect(lockHeld(dir)).toBe(false);
  });

  it('un candado de un proceso muerto (viejo) se reemplaza', () => {
    expect(tryLock(dir)).toBe(true);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(dir, 'autoupdate', 'en-curso.lock'), old, old);
    expect(lockHeld(dir)).toBe(false);
    expect(tryLock(dir)).toBe(true);
  });

  it('PA_AUTOUPDATE=0 o pa autoupdate off la apagan; encendida por defecto', () => {
    expect(autoupdateEnabled(dir, {})).toBe(true);
    expect(autoupdateEnabled(dir, { PA_AUTOUPDATE: '0' })).toBe(false);
    writeAutoupdateState(dir, { off: true });
    expect(readAutoupdateState(dir).off).toBe(true);
    expect(autoupdateEnabled(dir, {})).toBe(false);
    expect(autoupdateIntervalMin({})).toBe(30);
    expect(autoupdateIntervalMin({ PA_AUTOUPDATE_INTERVAL_MIN: '1' })).toBe(5);
  });
});

describe('changelog', () => {
  it('quita prefijos y números de PR, deduplica y corta en 8 con «y N cambios más»', () => {
    expect(cleanSubject('feat(arranque)!: vigilante de Windows (#746)')).toBe(
      'Vigilante de Windows',
    );
    expect(cleanSubject('refactor: x')).toBe('X');
    const many = Array.from({ length: 11 }, (_, i) => `fix: cambio ${i}`);
    const lines = formatChangelog([...many, 'fix: cambio 0', 'Merge branch main']);
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe('• Cambio 0');
    expect(lines.at(-1)).toBe('y 3 cambios más');
    expect(formatChangelog(['a', 'b', 'c'], 2).at(-1)).toBe('y 1 cambio más');
    expect(successMessage([])).toBe('🆕 Me he actualizado\n• Cambios internos');
  });

  it('autoupdateDue respeta el intervalo', () => {
    const now = Date.parse('2026-10-30T18:00:00Z');
    expect(autoupdateDue({}, now, 30)).toBe(true);
    expect(autoupdateDue({ lastCheckAt: '2026-10-30T17:45:00Z' }, now, 30)).toBe(false);
    expect(autoupdateDue({ lastCheckAt: '2026-10-30T17:29:00Z' }, now, 30)).toBe(true);
  });
});
