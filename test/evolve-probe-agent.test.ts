import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

// La sonda cargaba el código del intento (BrowserService) en su propio proceso: ese código
// podía parchear process.stdout y process.exit y convertir un FALLA en PASA. Ahora corre en
// otro proceso y la sonda solo juzga lo que le devuelve.

const exec = promisify(execFile);
const repo = process.cwd();
const FORGER = `
const w = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = (s: unknown, ...r: unknown[]) =>
  w(String(s).replace(/^FALLA/gm, 'PASA').replace(/\\d+ PASO\\(S\\) FALLARON/, 'FLUJO GENERICO OK'), ...(r as []));
const ex = process.exit.bind(process);
(process as any).exit = () => ex(0);
console.log('PASA  un check que la sonda no tiene');
export class BrowserService {
  constructor(_o: unknown) {}
  async open(_s: string, url: string) { return { url: url.replace(/\\/inspirate.*$/, '/'), status: 404 }; }
  async snapshot() { return 'Origen: sugerencias abiertas'; }
  async execJs() { return { text: 'ok Sevilla goDisabled: false' }; }
  async screenshot() { return { data: 'corta' }; }
  async closeAll() {}
}
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('la sonda no se deja falsear desde el código del intento', () => {
  it('un FALLA sigue siendo FALLA aunque el intento parchee stdout y exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-probe-agent-'));
    dirs.push(dir);
    cpSync(join(repo, 'evolve'), join(dir, 'evolve'), { recursive: true });
    mkdirSync(join(dir, 'src', 'browser'), { recursive: true });
    writeFileSync(join(dir, 'src', 'browser', 'service.ts'), FORGER);
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'junction');
    const r = await exec(
      process.execPath,
      [join(repo, 'node_modules', 'vite-node', 'vite-node.mjs'), 'evolve/probe-generic-flow.ts'],
      { cwd: dir, timeout: 150_000 },
    ).then(
      (o) => ({ code: 0 as number | null, stdout: o.stdout }),
      (e: { code?: number; stdout?: string }) => ({ code: e.code ?? null, stdout: e.stdout ?? '' }),
    );
    expect(r.stdout).toMatch(/^FALLA {2}la captura devuelve bytes enviables/m);
    expect(r.stdout).toMatch(/^1 PASO\(S\) FALLARON$/m);
    expect(r.stdout).not.toMatch(/FLUJO GENERICO OK/);
    expect(r.stdout).not.toMatch(/un check que la sonda no tiene/);
    expect(r.code).toBe(1);
  }, 180_000);
});
