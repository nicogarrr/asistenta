import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorDetail } from '../src/lifecycle.js';
import {
  busyBegin,
  describeBusy,
  interruptedTasks,
  readBusy,
  readBusyDetail,
  trackBusyIn,
} from '../src/ocupada.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-busy-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const file = () => join(dir, 'autoupdate', 'ocupada.json');

describe('estado ocupada fantasma', () => {
  it('dice exactamente qué espera', () => {
    trackBusyIn(dir);
    const end = busyBegin('turnos', 'instala HyperHDR');
    const d = readBusyDetail(dir);
    expect(d.state).toBe('ocupada');
    expect(describeBusy(d.items)).toMatch(/una tarea desde hace 0 min \(«instala HyperHDR»\)/);
    end();
  });

  it('un turno abierto más del tope se considera colgado y no frena la actualización', () => {
    trackBusyIn(dir);
    const end = busyBegin('turnos', 'colgada');
    const later = Date.now() + 31 * 60_000;
    const d = readBusyDetail(dir, later);
    expect(d.state).toBe('libre');
    expect(d.hung).toHaveLength(1);
    // con un tope mayor por entorno, sigue ocupada
    expect(readBusyDetail(dir, later, { PA_BUSY_MAX_MIN: '60' }).state).toBe('ocupada');
    end();
    expect(readBusy(dir)).toBe('libre');
  });

  it('fichero de una versión anterior (solo contadores) sigue contando como ocupada', () => {
    trackBusyIn(dir);
    writeFileSync(file(), JSON.stringify({ pid: 1, turnos: 1, aprobaciones: 0, at: 'x' }));
    expect(readBusy(dir)).toBe('ocupada');
  });

  it('al arrancar devuelve lo que el proceso anterior dejó abierto', () => {
    trackBusyIn(dir);
    const end = busyBegin('turnos', 'montar HyperHDR');
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    writeFileSync(file(), JSON.stringify({ ...raw, pid: raw.pid + 1 }));
    const cut = trackBusyIn(dir);
    expect(cut.map((c) => c.label)).toEqual(['montar HyperHDR']);
    expect(interruptedTasks()).toHaveLength(1);
    end();
  });
});

describe('errorDetail', () => {
  it('lleva la traza acotada', () => {
    const d = errorDetail(new Error('boom'));
    expect(d.name).toBe('Error');
    expect(d.stack?.split('\n').length).toBeLessThanOrEqual(12);
  });
});

describe('/stop libera la ocupada pegada', () => {
  it('cierra lo abierto antes del /stop y deja lo posterior', async () => {
    const { releaseBusyOpenedBefore } = await import('../src/ocupada.js');
    trackBusyIn(dir);
    busyBegin('turnos', 'pegado');
    const stopAt = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 5));
    busyBegin('turnos', 'nuevo');
    expect(releaseBusyOpenedBefore(stopAt)).toBe(1);
    expect(readBusyDetail(dir).items.map((i) => i.label)).toEqual(['nuevo']);
    releaseBusyOpenedBefore(Date.now() + 10);
    expect(readBusy(dir)).toBe('libre');
  });
});
