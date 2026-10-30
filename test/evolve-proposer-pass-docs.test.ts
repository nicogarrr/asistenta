import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Qué poner en PA_EVOLVE_PROPOSER_PASS para que el evaluador de la batería tenga modelo:
// la lista de .env.example y docs/evolve-bateria.md tiene que nombrar variables que existen.
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
function src(dir = join(ROOT, 'src')): string {
  return readdirSync(dir)
    .map((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? src(p) : n.endsWith('.ts') ? readFileSync(p, 'utf8') : '';
    })
    .join('\n');
}
/** Nombre de variable portátil de un secreto (vault.ts): provider:apiKey → PA_SECRET_PROVIDER_APIKEY. */
const secretVar = (k: string) => `PA_SECRET_${k.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

describe('PA_EVOLVE_PROPOSER_PASS documentado', () => {
  const line = read('.env.example')
    .split('\n')
    .find((l) => l.startsWith('# PA_EVOLVE_PROPOSER_PASS='));
  const names = /evaluador: ([A-Z0-9_,]+)/.exec(line ?? '')?.[1]?.split(',') ?? [];

  it('.env.example dice qué variables necesita el modelo del evaluador', () => {
    expect(line).toBeDefined();
    expect(names).toEqual(expect.arrayContaining(['PA_PROVIDER', 'PA_MODEL']));
  });

  it('cada variable existe en el código y la doc nombra las mismas', () => {
    const code = src();
    const secrets = [...code.matchAll(/vaultGet\('([^']+)'\)/g)].map((m) =>
      secretVar(m[1] as string),
    );
    const docs = read('docs/evolve-bateria.md');
    expect(docs).not.toContain('PA_API_KEY,');
    // La clave del modelo: la que lee provider.ts, con el nombre del almacén portátil.
    expect(code).toContain("vaultGet('provider:apiKey')");
    expect(docs).toContain(secretVar('provider:apiKey'));
    for (const n of names) {
      expect(code.includes(`'${n}'`) || secrets.includes(n), n).toBe(true);
      expect(docs, n).toContain(n);
    }
  });

  it('el evaluador usa el almacén portátil para poder leer la clave pasada', () => {
    expect(read('scripts/evolve-battery-case.mjs')).toMatch(/PA_VAULT_BACKEND = 'portable'/);
  });
});
