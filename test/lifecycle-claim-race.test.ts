import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLifecycle } from '../src/lifecycle.js';

// Fichero propio: los manejadores de señal de installLifecycle son globales.
afterEach(() => vi.restoreAllMocks());

const EVENTS = [
  'SIGINT',
  'SIGTERM',
  'SIGBREAK',
  'message',
  'uncaughtException',
  'unhandledRejection',
] as const;
const counts = () => EVENTS.map((e) => process.listenerCount(e));

describe('installLifecycle: quien pierde la carrera del pid no deja nada', () => {
  it('no instala manejadores si otro proceso ya tiene el fichero pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-lcr-'));
    writeFileSync(join(dir, 'agent.pid'), '424242');
    const before = counts();
    expect(() =>
      installLifecycle({ name: 'agent', stateDir: dir, onShutdown: async () => {} }),
    ).toThrow(/another instance won the race/);
    expect(counts()).toEqual(before);
  });

  it('un Ctrl+C después no borra el pid del ganador ni escribe .stale', async () => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const dir = mkdtempSync(join(tmpdir(), 'pa-lcr-'));
    writeFileSync(join(dir, 'agent.pid'), '424242');
    const onShutdown = vi.fn(async () => {});
    expect(() => installLifecycle({ name: 'agent', stateDir: dir, onShutdown })).toThrow();
    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 50));
    expect(onShutdown).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'agent.pid'), 'utf8')).toBe('424242');
    expect(existsSync(join(dir, 'agent.pid.stale'))).toBe(false);
  });
});

describe('installLifecycle: el cierre solo borra su propio fichero pid', () => {
  it('deja el fichero si ya nombra a otro proceso', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-lcr-'));
    const lc = installLifecycle({ name: 'own', stateDir: dir, onShutdown: async () => {} });
    expect(readFileSync(join(dir, 'own.pid'), 'utf8')).toBe(String(process.pid));
    writeFileSync(join(dir, 'own.pid'), '424242');
    lc.stop('test');
    await lc.done;
    expect(lc.outcome()).toBe('clean');
    expect(readFileSync(join(dir, 'own.pid'), 'utf8')).toBe('424242');
  });

  it('borra el suyo en un cierre limpio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-lcr-'));
    const lc = installLifecycle({ name: 'own2', stateDir: dir, onShutdown: async () => {} });
    // La identidad de arranque queda junto al pid (para no confundirlo con otro proceso).
    expect(readFileSync(join(dir, 'own2.pid.start'), 'utf8')).toMatch(
      new RegExp(`^${process.pid} (proc|ms):\\d+\n$`),
    );
    lc.stop('test');
    await lc.done;
    expect(existsSync(join(dir, 'own2.pid.start'))).toBe(false);
    expect(existsSync(join(dir, 'own2.pid'))).toBe(false);
    expect(existsSync(join(dir, 'own2.pid.stale'))).toBe(false);
  });
});
