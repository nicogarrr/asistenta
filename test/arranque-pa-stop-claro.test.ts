import { describe, expect, it } from 'vitest';
import { runStopCommand } from '../src/stop-command.js';

async function run(stop: () => Promise<{ instanceId: string }>) {
  let out = '';
  let err = '';
  let marked = false;
  const code = await runStopCommand({
    stop,
    markStopped: () => {
      marked = true;
    },
    write: (t) => {
      out += t;
    },
    writeErr: (t) => {
      err += t;
    },
  });
  return { code, out, err, marked };
}

describe('pa stop habla claro', () => {
  it('al parar no enseña el identificador interno y dice que no volverá sola', async () => {
    const r = await run(async () => ({ instanceId: 'abcdef0123456789'.repeat(4) }));
    expect(r.code).toBe(0);
    expect(r.marked).toBe(true);
    expect(r.out).not.toMatch(/Instancia|[a-f0-9]{12}/);
    expect(r.out).toContain('Asistenta parada');
    expect(r.out).toContain('pa iniciar');
  });

  it('control de otro usuario: dice qué suele pasar y no marca nada', async () => {
    const r = await run(async () => {
      throw new Error(
        'DACL, propietario o control nativo no verificables; no se ha detenido ningún proceso.',
      );
    });
    expect(r.code).toBe(1);
    expect(r.marked).toBe(false);
    expect(r.err).toContain('otro usuario o como administrador');
  });

  it('otro fallo cualquiera no lleva esa pista', async () => {
    const r = await run(async () => {
      throw new Error('Parada aceptada pero no confirmada limpia a tiempo.');
    });
    expect(r.code).toBe(1);
    expect(r.err).not.toContain('otro usuario');
  });

  it('los fallos técnicos salen en claro, sin «Metadata», «flock» ni «Windows»', async () => {
    const cases: [string, string][] = [
      ['Control ocupado o flock no disponible; no se ha detenido ningún proceso.', 'en un momento'],
      [
        'Parada Windows no confirmada limpia a tiempo; no se ha matado ni relanzado ningún proceso.',
        'no ha terminado a tiempo',
      ],
      ['El cierre no fue limpio o no se pudo autenticar.', 'no he podido comprobar'],
      ['Metadata Windows ilegible.', 'Administrador de tareas'],
      ['Metadata de control ilegible.', 'Administrador de tareas'],
    ];
    for (const [raw, plain] of cases) {
      const r = await run(async () => {
        throw new Error(raw);
      });
      expect(r.code).toBe(1);
      expect(r.marked).toBe(false);
      expect(r.err).toContain(plain);
      expect(r.err).not.toMatch(/Metadata|flock|Windows|autenticar/);
    }
  });

  it('un motivo desconocido da una línea clara, no el texto técnico', async () => {
    const r = await run(async () => {
      throw new Error('Algo raro.');
    });
    expect(r.err).toContain('No he podido parar Asistenta: ha pasado algo inesperado');
    expect(r.err).not.toContain('Algo raro.');
  });
});
