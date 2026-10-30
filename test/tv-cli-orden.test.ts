import { describe, expect, it, vi } from 'vitest';
import { tvCommand, tvOrderCommand } from '../src/tv/tv-cli.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe('pa tv orden (sin modelo)', () => {
  it('une los argumentos y ejecuta la orden con la tool (action=command)', async () => {
    const { out, deps } = io();
    const runOrder = vi.fn(async () => 'Entendido: apagar la tele. Tele apagada.');
    const code = await tvCommand(['orden', 'apaga', 'la', 'tele'], { ...deps, runOrder });
    expect(code).toBe(0);
    expect(runOrder).toHaveBeenCalledWith('apaga la tele');
    expect(out.join('')).toContain('Tele apagada');
  });

  it('sin texto: uso y código 2, no toca la tele', async () => {
    const { err, deps } = io();
    const runOrder = vi.fn(async () => 'x');
    expect(await tvCommand(['orden'], { ...deps, runOrder })).toBe(2);
    expect(err.join('')).toContain('pa tv orden');
    expect(runOrder).not.toHaveBeenCalled();
  });

  it('no entendida: lo dice con ejemplos y no ejecuta nada', async () => {
    const { err, deps } = io();
    const runOrder = vi.fn(async () => 'x');
    expect(await tvOrderCommand('hazme un café', { ...deps, runOrder })).toBe(2);
    expect(err.join('')).toContain('No he entendido');
    expect(runOrder).not.toHaveBeenCalled();
  });

  it('demasiado larga: código 2 sin ejecutar', async () => {
    const { deps } = io();
    const runOrder = vi.fn(async () => 'x');
    expect(await tvOrderCommand(`apaga la tele ${'x'.repeat(300)}`, { ...deps, runOrder })).toBe(2);
    expect(runOrder).not.toHaveBeenCalled();
  });

  it('error de la tele: mensaje en castellano y código 1', async () => {
    const { err, deps } = io();
    const runOrder = vi.fn(async () => {
      throw new Error('No llego a la tele');
    });
    expect(await tvOrderCommand('silencio', { ...deps, runOrder })).toBe(1);
    expect(err.join('')).toMatch(/No he podido .*No llego a la tele/);
  });

  it('respuesta vacía: «Hecho: …»', async () => {
    const { out, deps } = io();
    expect(await tvOrderCommand('volumen a 15', { ...deps, runOrder: async () => '  ' })).toBe(0);
    expect(out.join('')).toMatch(/^Hecho: /);
  });

  it('sin ejecutor inyectado: código 1, nada se ejecuta', async () => {
    const { err, deps } = io();
    expect(await tvOrderCommand('silencio', deps)).toBe(1);
    expect(err.join('')).toContain('no disponibles');
  });
});
