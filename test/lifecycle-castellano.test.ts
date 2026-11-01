import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNotRunning, installLifecycle } from '../src/lifecycle.js';

/** Doble clic en levantar.bat con Asistenta ya abierta: una frase clara, no inglés. */
describe('Asistenta ya abierta: aviso en castellano', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'pa-life-es-'));

  it('pid vivo: dice que ya está en marcha y cómo reiniciarla', () => {
    const d = dir();
    writeFileSync(join(d, 'agent.pid'), String(process.ppid));
    let msg = '';
    try {
      assertNotRunning(d, 'agent');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('Asistenta ya está en marcha');
    expect(msg).toContain('pa stop');
    expect(msg).not.toMatch(/already running|stop it first/);
  });

  it('dos arranques a la vez: el segundo lo dice en castellano, sin rutas ni errores crudos', () => {
    const d = dir();
    writeFileSync(join(d, 'agent.pid'), '424242');
    let msg = '';
    try {
      installLifecycle({ name: 'agent', stateDir: d, onShutdown: async () => {} });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('Asistenta ya se está abriendo');
    expect(msg).not.toMatch(/could not claim|EEXIST|won the race/);
    expect(msg).not.toContain(d);
  });
});
