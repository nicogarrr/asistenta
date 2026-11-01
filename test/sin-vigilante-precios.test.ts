import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRICE_SWEEP_REMOVED_TEXT, precioMuteArgs } from '../src/cli.js';

/**
 * Nico (31-oct-2026): «vamos a quitar el vigilante de precios porque no funciona». Al decir
 * «Hola» le llegó un «Vigilante de precios, resumen del 2026-10-27: 4 listados leídos, 0
 * productos vistos…» de hacía tres días. El barrido automático de tiendas (con su resumen
 * diario) ya no existe: ni arranca con el daemon ni puede mandar nada, aunque quede un
 * pricewatch.json o un pricewatch.sqlite viejo en el estado. Vigilar un enlace concreto
 * (/vigila, herramienta de precio) y /compara siguen.
 */
const root = join(import.meta.dirname, '..');
const src = (p: string) => readFileSync(join(root, 'src', p), 'utf8');

function allSources(dir = join(root, 'src')): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allSources(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('sin vigilante de precios automático', () => {
  it('no queda el código del barrido de tiendas', () => {
    for (const f of [
      'pricewatch.ts',
      'pricewatch-runner.ts',
      'pricewatch-loop.ts',
      'pricewatch-notify.ts',
      'pricewatch-cli.ts',
      'pricewatch-browser.ts',
      'pricewatch-browserd.ts',
      'listscan.ts',
      'discovery.ts',
    ]) {
      expect(existsSync(join(root, 'src', 'watch', f)), f).toBe(false);
    }
  });

  it('el daemon no programa ningún ciclo ni resumen del vigilante', () => {
    const cli = src('cli.ts');
    expect(cli).not.toMatch(/startPricewatchLoop|pricewatch-loop|pricewatch-runner/);
    expect(cli).not.toMatch(/pricewatch\.json|pricewatch\.sqlite|PRICEWATCH_/);
    for (const f of allSources()) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toContain('Vigilante de precios, resumen del');
      expect(text, f).not.toContain('Vigilante de precios activo');
    }
  });

  it('`pa precio` ya no existe en la ayuda del CLI', () => {
    expect(src('cli.ts')).not.toMatch(/^ {2}pa precio /m);
  });

  it('un botón viejo «🔕 Silenciar 1 día» contesta claro en vez de fallar', () => {
    expect(precioMuteArgs('silenciar a1b2c3d4')).toEqual({ action: 'silenciar', key: 'a1b2c3d4' });
    expect(precioMuteArgs('a1b2c3')).toBeNull();
    expect(PRICE_SWEEP_REMOVED_TEXT).toBe(
      'El vigilante de precios automático se ha quitado; puedo vigilar un enlace concreto si me lo pasas.',
    );
    expect(src('cli.ts')).toContain('PRICE_SWEEP_REMOVED_TEXT, { quote: true }');
  });

  it('.env.example ya no documenta variables del vigilante', () => {
    expect(readFileSync(join(root, '.env.example'), 'utf8')).not.toMatch(/PRICEWATCH_/);
  });
});
