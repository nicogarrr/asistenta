import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemonStatus, statusCommand } from '../src/daemon-status.js';
import {
  readTelegramEstado,
  startTelegramEstado,
  writeTelegramEstado,
} from '../src/telegram-estado.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-tg-estado-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});
const now = 1_800_000_000_000;
const vivo = () => {
  writeFileSync(join(dir, 'agent.pid'), '4242');
  writeFileSync(join(dir, 'agent.heartbeat'), String(now - 1000));
};

describe('estado de Telegram para la bandeja', () => {
  it('pa status --json dice si Telegram está conectada', () => {
    vivo();
    writeTelegramEstado(dir, true, now - 2000);
    expect(daemonStatus({ stateDir: dir, now: () => now, probe: () => 'alive' }).telegram).toBe(
      'conectada',
    );
    writeTelegramEstado(dir, false, now - 2000);
    expect(daemonStatus({ stateDir: dir, now: () => now, probe: () => 'alive' }).telegram).toBe(
      'desconectada',
    );
  });

  it('sin fichero, viejo, futuro o raro: sin dato (nunca un verde falso)', () => {
    expect(readTelegramEstado(dir, now, 60_000)).toBe('sin-dato');
    writeTelegramEstado(dir, true, now - 61_000);
    expect(readTelegramEstado(dir, now, 60_000)).toBe('sin-dato');
    writeTelegramEstado(dir, true, now + 5_000);
    expect(readTelegramEstado(dir, now, 60_000)).toBe('sin-dato');
    for (const raro of ['2 123', 'si', '1 0', '1 12abc', '']) {
      writeFileSync(join(dir, 'telegram.estado'), raro);
      expect(readTelegramEstado(dir, now, 60_000), raro).toBe('sin-dato');
    }
  });

  it('pa status en castellano: dice si Telegram está conectada', () => {
    vivo();
    writeTelegramEstado(dir, false, now - 2000);
    let out = '';
    statusCommand([], { stateDir: dir, now: () => now, probe: () => 'alive' }, (t) => {
      out += t;
    });
    expect(out).toContain('Telegram: sin conexión ahora mismo; Asistenta reintenta sola.');
    writeTelegramEstado(dir, true, now - 2000);
    out = '';
    statusCommand([], { stateDir: dir, now: () => now, probe: () => 'alive' }, (t) => {
      out += t;
    });
    expect(out).toContain('Telegram: conectada.');
  });

  it('el daemon lo reescribe en cada latido con lo que diga el canal', () => {
    vi.useFakeTimers();
    let listo = false;
    const parar = startTelegramEstado(dir, () => listo, 15_000);
    expect(readFileSync(join(dir, 'telegram.estado'), 'utf8')).toMatch(/^0 \d+\n$/);
    listo = true;
    vi.advanceTimersByTime(15_000);
    expect(readFileSync(join(dir, 'telegram.estado'), 'utf8')).toMatch(/^1 \d+\n$/);
    parar();
  });

  it('un fallo al escribir no tumba el daemon', () => {
    const parar = startTelegramEstado(join(dir, 'no', 'existe'), () => true);
    parar();
  });

  it('el daemon lo arranca con el canal de Telegram', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toContain('startTelegramEstado(paths.state, () => telegram.isReady());');
  });
});
