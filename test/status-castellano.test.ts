import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { statusCommand } from '../src/daemon-status.js';

// `pa status` justo después de instalar, con Asistenta parada: la primera línea
// tiene que entenderse sin saber inglés («PID no disponible (missing)»).
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function status(prep?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-status-es-'));
  dirs.push(dir);
  prep?.(dir);
  let out = '';
  expect(statusCommand([], { stateDir: dir }, (s) => (out += s))).toBeTypeOf('number');
  return out;
}

it('sin archivo de PID dice que Asistenta no parece estar en marcha', () => {
  const out = status();
  expect(out.split('\n')[0]).toBe('No hay archivo de PID: Asistenta no parece estar en marcha.');
  expect(out).not.toMatch(/\((missing|invalid|unreadable)\)/);
});

it('un PID dañado se dice en castellano', () => {
  const out = status((d) => writeFileSync(join(d, 'agent.pid'), 'hola'));
  expect(out.split('\n')[0]).toBe('El archivo de PID está dañado: no sé qué proceso es Asistenta.');
});
