import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { statusCommand } from '../src/daemon-status.js';
import { RESTART_TEXT } from '../src/stop-command.js';

// `pa status` / `pa restart` para alguien que no sabe qué es un PID, un latido o un daemon.
const JERGA =
  /daemon|supervisor|latido|umbral|timestamp|heartbeat|agent\.pid|Restart no disponible/i;
const NOW = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function status(probe: 'alive' | 'dead' | 'unknown', beatAgoMs: number | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-status-llano-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'agent.pid'), '4242');
  if (beatAgoMs !== null) writeFileSync(join(dir, 'agent.heartbeat'), String(NOW - beatAgoMs));
  let out = '';
  statusCommand([], { stateDir: dir, probe: () => probe, now: () => NOW }, (s) => {
    out += s;
  });
  expect(out).not.toMatch(JERGA);
  expect(out).not.toContain(dir);
  return out;
}

it('en marcha y sana: lo dice en la primera línea', () => {
  expect(status('alive', 5_000).split('\n')[0]).toBe(
    'Asistenta está en marcha: dio señal de vida hace 5 s.',
  );
});

it('abierta pero colgada: lo dice y cuenta qué hacer', () => {
  const out = status('alive', 10 * 60_000);
  expect(out.split('\n')[0]).toMatch(/lleva 10 min sin dar señal de vida: puede estar colgada/);
  expect(out).toMatch(/pa stop y vuelve a arrancarla/);
});

it('cerrada de golpe: no está en marcha y cómo arrancarla', () => {
  const out = status('dead', 10 * 60_000);
  expect(out.split('\n')[0]).toBe('Asistenta no está en marcha: se cerró sin avisar.');
  expect(out).toMatch(/levantar\.bat o pa iniciar/);
});

it('sin señal de vida todavía, no confirma que responda', () => {
  const out = status('alive', null);
  expect(out).toMatch(/no puedo confirmar que responda/);
});

it('pa restart explica cómo reiniciar a mano, sin jerga', () => {
  expect(RESTART_TEXT).not.toMatch(JERGA);
  expect(RESTART_TEXT).toMatch(/pa stop y después levantar\.bat/);
  expect(RESTART_TEXT).toMatch(/No he parado ni arrancado nada/);
});
