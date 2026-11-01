import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const error = vi.fn();
vi.mock('../src/log.js', async (orig) => {
  const real = await orig<typeof import('../src/log.js')>();
  return { ...real, logFile: { ...real.logFile, error: (...a: unknown[]) => error(...a) } };
});

const { OpenGymError } = await import('../src/opengym/client.js');
const { openGymCliError, openGymPaired, OPENGYM_FALLO } = await import(
  '../src/opengym/cli-text.js'
);

beforeEach(() => error.mockReset());

describe('pa opengym: consola en castellano llano', () => {
  it('un fallo inesperado no sale en crudo: una línea clara y el detalle al registro', () => {
    const raw = new Error(
      "EPERM: operation not permitted, open 'C:\\Users\\nico\\.pa\\vault.json'",
    );
    const linea = openGymCliError(raw);
    expect(linea).toBe(OPENGYM_FALLO);
    expect(linea).not.toMatch(/EPERM|vault|C:\\|Error:/);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls[0])).toContain('EPERM');
  });

  it('un error que no es Error tampoco sale en crudo', () => {
    expect(openGymCliError({ code: 'X' })).toBe(OPENGYM_FALLO);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('los motivos propios de openGym (ya en castellano) se muestran tal cual', () => {
    const e = new OpenGymError('network', 'openGym no responde (tiempo agotado).');
    expect(openGymCliError(e)).toBe('openGym no responde (tiempo agotado).');
    expect(error).not.toHaveBeenCalled();
  });

  it('el aviso de emparejado no nombra el vault ni la clave interna', () => {
    const t = openGymPaired('gym.tail1234.ts.net');
    expect(t).toContain('gym.tail1234.ts.net');
    expect(t).not.toMatch(/vault|opengym:token|token|canjeado/i);
  });

  it('cli.ts usa estos textos en vez de String(err) y del aviso con el vault', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const i = cli.indexOf('async function openGymCommand');
    const cuerpo = cli.slice(i, cli.indexOf('\n}\n', i));
    expect(cuerpo).toContain('openGymCliError(err)');
    expect(cuerpo).toContain('openGymPaired(host)');
    expect(cuerpo).not.toContain('String(err)');
    expect(cuerpo).not.toContain('opengym:token');
  });
});
