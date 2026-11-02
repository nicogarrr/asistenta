/**
 * `pa doctor` / diagnóstico con Asistenta caída decía «ocupada con: una tarea desde hace 5 min
 * («…»)» justo debajo de «en marcha: no, se ha parado»: leía ocupada.json, que se queda como
 * estaba en el momento del cierre. Parecía que seguía trabajando. Con el proceso muerto ya
 * no está ocupada con nada: se dice lo que tenía abierto al cerrarse.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnose } from '../src/diagnose.js';

const NOW = Date.parse('2026-11-02T21:00:00Z');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-diag-ocupada-'));
  mkdirSync(join(dir, 'autoupdate'), { recursive: true });
  writeFileSync(join(dir, 'agent.pid'), '4242');
  writeFileSync(
    join(dir, 'autoupdate', 'ocupada.json'),
    JSON.stringify({
      pid: 4242,
      turnos: 1,
      aprobaciones: 0,
      items: [
        {
          kind: 'turnos',
          label: 'instala HyperHDR',
          since: new Date(NOW - 5 * 60_000).toISOString(),
        },
      ],
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('diagnóstico: «ocupada con» con Asistenta parada', () => {
  it('parada: no dice que está ocupada, dice lo que tenía abierto al cerrarse', async () => {
    const r = await diagnose({ stateDir: dir, now: () => NOW, isAlive: () => false });
    expect(r.text).toContain('en marcha: no, se ha parado');
    expect(r.text).not.toContain('ocupada con: una tarea');
    expect(r.text).toContain(
      'ocupada con: nada, está parada (al cerrarse tenía abierto: una tarea desde hace 5 min («instala HyperHDR»))',
    );
  });

  it('en marcha: igual que antes', async () => {
    const r = await diagnose({ stateDir: dir, now: () => NOW, isAlive: () => true });
    expect(r.text).toContain('ocupada con: una tarea desde hace 5 min («instala HyperHDR»)');
  });
});
