import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// El instalador .exe se construye en GitHub al publicar una versión y se adjunta a ella.
const yml = readFileSync('.github/workflows/instalador-windows.yml', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

/** Bloque de primer nivel `key:` hasta la siguiente clave de primer nivel. */
function top(key: string): string {
  const m = yml.match(new RegExp(`^${key}:\\n((?:[ \\t]+.*\\n|\\n)+)`, 'm'));
  if (!m) throw new Error(`falta ${key}`);
  return m[1] ?? '';
}

/** Pasos del job: cada «- name/uses/run» con sus líneas. */
function steps(): string[] {
  const body = yml.slice(yml.indexOf('    steps:\n') + '    steps:\n'.length);
  return body.split(/\n(?= {6}- )/).map((s) => s.trim());
}

describe('workflow del instalador de Windows', () => {
  it('YAML sin tabuladores y con las claves de primer nivel', () => {
    expect(yml).not.toMatch(/\t/);
    for (const k of ['name', 'on', 'permissions', 'concurrency', 'jobs'])
      expect(yml).toMatch(new RegExp(`^${k}:`, 'm'));
  });

  it('solo al publicar una versión o a mano; nunca en push ni con etiquetas', () => {
    const on = top('on');
    expect(on).toMatch(/^ {2}release:\n {4}types: \[published\]$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on).not.toMatch(/push|pull_request|tags/);
    expect(yml).not.toMatch(/git (tag|push)|gh release create|create-release/);
  });

  it('permiso de escritura solo en el job; el resto, lectura', () => {
    expect(top('permissions')).toMatch(/^ {2}contents: read$/m);
    expect(yml).toMatch(/^ {4}permissions:\n {6}contents: write$/m);
    expect(top('concurrency')).toMatch(/cancel-in-progress: false/);
  });

  it('construye en Linux con NSIS y los scripts del repo', () => {
    expect(yml).toMatch(/runs-on: ubuntu-latest/);
    expect(yml).toMatch(/timeout-minutes: \d+/);
    const s = steps();
    const i = (re: RegExp) => s.findIndex((x) => re.test(x));
    expect(i(/node-version: 24/)).toBeGreaterThanOrEqual(0);
    expect(i(/apt-get install -y nsis/)).toBeGreaterThan(0);
    expect(i(/run: npm ci$/)).toBeGreaterThan(i(/apt-get install -y nsis/));
    expect(i(/run: npm run build$/)).toBeGreaterThan(i(/run: npm ci$/));
    expect(i(/run: npm run build:instalador$/)).toBeGreaterThan(i(/run: npm run build$/));
    expect(pkg.scripts['build:instalador']).toBe('node scripts/windows-app/build-installer.mjs');
  });

  it('adjunta el .exe y su SHA-256 a la versión publicada, con el token de GitHub', () => {
    const s = steps();
    const sha = s.find((x) => x.includes('sha256sum'));
    expect(sha).toContain('sha256sum Asistenta-Instalador-*.exe | tee Asistenta-Instalador.sha256');
    const up = s.find((x) => x.includes('gh release upload')) ?? '';
    expect(up).toContain("if: github.event_name == 'release'");
    expect(up).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(up).toContain(
      'gh release upload "$TAG" var/Asistenta-Instalador-*.exe var/Asistenta-Instalador.sha256 --clobber',
    );
    expect(s.indexOf(up)).toBeGreaterThan(s.indexOf(sha ?? ''));
    expect(yml).not.toMatch(/secrets\./);
  });

  it('la etiqueta tiene que coincidir con package.json (si no, para)', () => {
    const chk = steps().find((x) => x.includes('coincide con package.json')) ?? '';
    expect(chk).toContain("if: github.event_name == 'release'");
    expect(chk).toMatch(/"\$\{TAG#v\}" != "\$VERSION"/);
    expect(chk).toContain('exit 1');
  });

  it('a mano solo deja un artefacto', () => {
    const art = steps().find((x) => x.includes('upload-artifact')) ?? '';
    expect(art).toContain("if: github.event_name == 'workflow_dispatch'");
  });
});
