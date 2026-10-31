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

// Un intento que miente en lo que devuelve, sin tocar stdout: nunca abre el navegador y
// devuelve justo lo que la sonda espera. Antes eran 10 PASA y «FLUJO GENERICO OK».
const LIAR = `
export class BrowserService {
  constructor(_o: unknown) {}
  async open(_s: string, url: string) { return { url: url.replace(/\\/inspirate.*$/, '/'), status: 404 }; }
  async snapshot() { return 'Origen: sugerencias abiertas'; }
  async execJs() { return { text: 'ok Sevilla goDisabled: false' }; }
  async screenshot() { return { data: 'x'.repeat(5000) }; }
  async closeAll() {}
}
`;

// Un intento que además imita al navegador: él mismo pide al servidor de la sonda las rutas
// y los avisos que mandaría la página, con un User-Agent de navegador. Antes eran 10 PASA.
const IMPOSTOR = `
let base = '';
const ua = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0' };
const hit = (p: string) => fetch(base + p, { headers: ua }).then((r) => r.text()).catch(() => '');
export class BrowserService {
  constructor(_o: unknown) {}
  async open(_s: string, url: string) {
    base = new URL(url).origin;
    await hit(new URL(url).pathname);
    await hit('/');
    return { url: base + '/', status: 404 };
  }
  async snapshot() { return 'Origen: sugerencias abiertas'; }
  async execJs() {
    for (const q of ['foco=o', 'panel=o', 'c=o&v=Sevilla', 'foco=d', 'panel=d', 'c=d&v=Malaga&go=1'])
      await hit('/evento?' + q);
    return { text: 'ok Sevilla goDisabled: false' };
  }
  async screenshot() { return { data: 'x'.repeat(5000) }; }
  async closeAll() {}
}
`;

async function runProbe(service: string) {
  const dir = mkdtempSync(join(tmpdir(), 'evo-probe-agent-'));
  dirs.push(dir);
  cpSync(join(repo, 'evolve'), join(dir, 'evolve'), { recursive: true });
  mkdirSync(join(dir, 'src', 'browser'), { recursive: true });
  writeFileSync(join(dir, 'src', 'browser', 'service.ts'), service);
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'junction');
  return exec(
    process.execPath,
    [join(repo, 'node_modules', 'vite-node', 'vite-node.mjs'), 'evolve/probe-generic-flow.ts'],
    { cwd: dir, timeout: 150_000 },
  ).then(
    (o) => ({ code: 0 as number | null, stdout: o.stdout }),
    (e: { code?: number; stdout?: string }) => ({ code: e.code ?? null, stdout: e.stdout ?? '' }),
  );
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('la sonda no se deja falsear desde el código del intento', () => {
  it('un FALLA sigue siendo FALLA aunque el intento parchee stdout y exit', async () => {
    const r = await runProbe(FORGER);
    expect(r.stdout).toMatch(/^FALLA {2}la captura devuelve bytes enviables/m);
    expect(r.stdout).toMatch(/^\d+ PASO\(S\) FALLARON$/m);
    expect(r.stdout).not.toMatch(/FLUJO GENERICO OK/);
    expect(r.stdout).not.toMatch(/un check que la sonda no tiene/);
    expect(r.code).toBe(1);
  }, 180_000);

  it('lo que el intento devuelve se contrasta con lo que el navegador pidió al servidor', async () => {
    const r = await runProbe(LIAR);
    for (const label of [
      'la URL adivinada con 404 no quema el turno',
      'el campo recibe foco',
      'el desplegable se abre tras la latencia real',
      'las sugerencias tardias se leen y se eligen',
      'el valor del campo se puede releer',
      'el segundo desplegable tambien funciona',
      'el boton se habilita solo cuando ambos campos estan puestos',
    ]) {
      expect(r.stdout).toMatch(new RegExp(`^FALLA {2}${label}`, 'm'));
    }
    expect(r.stdout).not.toMatch(/FLUJO GENERICO OK/);
    expect(r.code).toBe(1);
  }, 180_000);
  it.runIf(process.platform === 'linux')(
    'un intento que imita al navegador desde su propio proceso no cuenta como navegador',
    async () => {
      const r = await runProbe(IMPOSTOR);
      for (const label of [
        'la URL adivinada con 404 no quema el turno',
        'el campo recibe foco',
        'el desplegable se abre tras la latencia real',
        'las sugerencias tardias se leen y se eligen',
        'el valor del campo se puede releer',
        'el segundo desplegable tambien funciona',
        'el boton se habilita solo cuando ambos campos estan puestos',
      ]) {
        expect(r.stdout).toMatch(new RegExp(`^FALLA {2}${label}`, 'm'));
      }
      expect(r.stdout).not.toMatch(/FLUJO GENERICO OK/);
      expect(r.code).toBe(1);
    },
    180_000,
  );
});
