import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/watch/pricewatch.js';
import { pricewatchCommand } from '../src/watch/pricewatch-cli.js';

function cfgFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-precio-'));
  const p = join(dir, 'pricewatch.json');
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

async function run(args: string[], configPath: string, ran = false) {
  let out = '';
  let err = '';
  let cycles = 0;
  const code = await pricewatchCommand(args, {
    configPath,
    dbPath: join(tmpdir(), 'nunca-se-abre.sqlite'),
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    runOnce: async () => {
      cycles++;
      return { ran, cycleMinutes: 60 };
    },
  });
  return { code, out, err, cycles };
}

const valid = {
  enabled: true,
  products: [{ name: 'tele', label: 'Tele del salón', urls: { amazon: 'B0CHX1W1XY' } }],
};

describe('pa precio', () => {
  it('comprobar resume la config sin hacer peticiones', async () => {
    const r = await run(['comprobar'], cfgFile(valid));
    expect(r.code).toBe(0);
    expect(r.cycles).toBe(0);
    expect(r.out).toContain('ACTIVADO');
    expect(r.out).toContain('Tele del salón: Amazon.es');
  });

  it('una config rota se dice en castellano y sale con 1, sin ciclo', async () => {
    const r = await run([], cfgFile({ products: [{ name: 'x', urls: { ebay: 'y' } }] }));
    expect(r.code).toBe(1);
    expect(r.cycles).toBe(0);
    expect(r.err).toContain('tienda desconocida "ebay"');
    const j = await run(['comprobar'], cfgFile('{no es json'));
    expect(j.code).toBe(1);
    expect(j.err).toContain('no es válido');
  });

  it('sin fichero explica que está apagado', async () => {
    const r = await run([], join(tmpdir(), 'no-existe-pricewatch.json'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('apagado');
    expect(r.cycles).toBe(0);
  });

  it('sin argumentos lanza un ciclo', async () => {
    const r = await run([], cfgFile(valid), true);
    expect(r.code).toBe(0);
    expect(r.cycles).toBe(1);
    expect(r.out).toContain('ciclo hecho');
  });

  it('subcomando desconocido: uso y 2', async () => {
    const r = await run(['borrar'], cfgFile(valid));
    expect(r.code).toBe(2);
    expect(r.err).toContain('uso: pa precio');
  });
});

describe('parseConfig label', () => {
  it('conserva label para el texto de la alerta (antes se perdía)', () => {
    const c = parseConfig(valid);
    expect(c.products[0]?.label).toBe('Tele del salón');
  });
  it('sin label no inventa uno; label no textual es error', () => {
    expect(parseConfig({ products: [{ name: 'a', urls: {} }] }).products[0]?.label).toBeUndefined();
    expect(() => parseConfig({ products: [{ name: 'a', label: 3, urls: {} }] })).toThrow(/label/);
  });
});
