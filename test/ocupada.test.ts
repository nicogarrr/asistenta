import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busyBegin, readBusy, trackBusyIn } from '../src/ocupada.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-ocupada-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ocupada (lo que lee la autoactualización)', () => {
  it('sin fichero no sabe; con el daemon marcando, libre ↔ ocupada por turnos y aprobaciones', () => {
    expect(readBusy(dir)).toBe('desconocido');
    trackBusyIn(dir);
    expect(readBusy(dir)).toBe('libre');
    const endTurn = busyBegin('turnos');
    expect(readBusy(dir)).toBe('ocupada');
    const endApproval = busyBegin('aprobaciones');
    endTurn();
    endTurn();
    expect(readBusy(dir)).toBe('ocupada');
    endApproval();
    expect(readBusy(dir)).toBe('libre');
    const raw = JSON.parse(readFileSync(join(dir, 'autoupdate', 'ocupada.json'), 'utf8'));
    expect(raw).toMatchObject({ turnos: 0, aprobaciones: 0, pid: process.pid });
  });
});
