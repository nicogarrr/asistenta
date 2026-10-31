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
});
