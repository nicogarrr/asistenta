import { describe, expect, it } from 'vitest';
import { runStopCommand } from '../src/stop-command.js';

async function stopFailing(message: string, code?: string) {
  let err = '';
  const rc = await runStopCommand({
    stop: async () => {
      throw Object.assign(new Error(message), code ? { code } : {});
    },
    markStopped: () => {
      throw new Error('no debe marcar');
    },
    write: () => {},
    writeErr: (t) => {
      err += t;
    },
  });
  return { rc, err };
}

describe('pa stop: cualquier fallo se explica en castellano llano', () => {
  it.each([
    ['Instancia Windows sustituida.', /ha cambiado mientras la paraba[^\n]*pa status/],
    ['Prueba de cierre modificada.', /ha cambiado mientras la paraba/],
    ['Solicitud Windows no autenticada.', /ha cambiado mientras la paraba/],
    ["EACCES: permission denied, open 'C:\\Users\\nico\\state\\ready.json'", /no tengo permiso/],
    ['Socket anterior ambiguo.', /algo inesperado[^\n]*pa status/],
    ['ENAMETOOLONG: something odd', /algo inesperado/],
  ])('«%s» → línea clara, sin el texto técnico', async (raw, re) => {
    const { rc, err } = await stopFailing(raw);
    expect(rc).toBe(1);
    expect(err).toMatch(re);
    expect(err).not.toContain(raw);
    expect(err).not.toMatch(/EACCES|ENAMETOOLONG|Socket|Instancia Windows|nico/);
    expect(err).toMatch(/No he marcado nada/);
  });

  it('propietario distinto: dice que es de otra cuenta y cómo pararla', async () => {
    const { err } = await stopFailing('Permisos o propietario de control no seguros.');
    expect(err).toMatch(/otra cuenta de usuario/);
    expect(err).toMatch(/párala desde esa misma cuenta/);
    expect(err).not.toMatch(/no seguros/);
  });
});
