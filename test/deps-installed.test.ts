import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Las dependencias instaladas tienen que ser las que fija package-lock.json.
 *
 * Tras un `git pull` sin `npm ci` (o un node_modules copiado de un clon viejo) los tests
 * corren contra versiones antiguas y fallan con mensajes que confunden: así pasó con
 * test/mail-recipients-envelope.test.ts, que fallaba con nodemailer 10.0.13 cuando
 * package.json ya pedía 10.3.1 (el arreglo de seguridad de addressparser). Este test
 * dice directamente qué paquete está desfasado y qué hacer.
 */
type Lock = { packages: Record<string, { version?: string; optional?: boolean }> };
type Pkg = Record<
  'dependencies' | 'devDependencies' | 'optionalDependencies',
  Record<string, string> | undefined
>;

const root = new URL('../', import.meta.url);
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, root), 'utf8')) as T;

function installedVersion(name: string): string | null {
  try {
    return readJson<{ version: string }>(`node_modules/${name}/package.json`).version;
  } catch {
    return null;
  }
}

describe('node_modules coincide con package-lock.json', () => {
  it('cada dependencia directa está instalada en la versión del lock', () => {
    const pkg = readJson<Pkg>('package.json');
    const lock = readJson<Lock>('package-lock.json');
    const names = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
    });
    expect(names.length).toBeGreaterThan(0);
    const stale: string[] = [];
    for (const name of names) {
      const entry = lock.packages[`node_modules/${name}`];
      if (!entry?.version) continue;
      const have = installedVersion(name);
      if (have === null && entry.optional) continue;
      if (have !== entry.version)
        stale.push(`${name} ${have ?? 'no instalado'} (el lock pide ${entry.version})`);
    }
    expect(stale, `node_modules desfasado, ejecuta \`npm ci\`: ${stale.join('; ')}`).toEqual([]);
  });
});
