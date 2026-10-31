import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_ITEMS,
  NODE_SHA256,
  nodeZip,
  nodeZipUrl,
  PROD_INSTALL_ARGS,
  removeAppLines,
  renderNsi,
  sha256,
  stagePlan,
  // @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
} from '../scripts/windows-app/build-installer.mjs';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { bmp24, icoFromPngs } from '../scripts/windows-app/icono.mjs';

const NSI = readFileSync('scripts/windows-app/asistenta.nsi', 'utf8');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pa-appwin-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const vars = { VERSION: '0.1.0', STAGE: '/tmp/x', OUTFILE: '/tmp/x.exe', SIZE_KB: 1 };

describe('instalador .exe: preparación', () => {
  it('hay orden npm para construirlo', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['build:instalador']).toBe('node scripts/windows-app/build-installer.mjs');
  });

  it('copia el programa y nunca el .env ni los datos; sin compilar avisa en llano', () => {
    const root = tmp();
    expect(() => stagePlan(root, '/s')).toThrow(/npm run build/);
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'cli.js'), '');
    for (const f of ['package.json', 'package-lock.json', '.env', '.env.example'])
      writeFileSync(join(root, f), '{}');
    mkdirSync(join(root, '.data'));
    const plan = stagePlan(root, '/s');
    const to = plan.map((p: { to: string }) => p.to.replace('/s/app/', '')).sort();
    expect(to).toEqual(['.env.example', 'dist', 'package-lock.json', 'package.json']);
    expect(
      APP_ITEMS.some(
        (i: { path: string }) => i.path.startsWith('.env') && i.path !== '.env.example',
      ),
    ).toBe(false);
  });
  it('dependencias de producción para Windows x64', () => {
    expect(PROD_INSTALL_ARGS).toEqual(
      expect.arrayContaining(['ci', '--omit=dev', '--os=win32', '--cpu=x64']),
    );
  });
});

describe('instalador .exe: Node portable', () => {
  it('versión fija desde nodejs.org con SHA-256', () => {
    expect(nodeZipUrl()).toMatch(
      /^https:\/\/nodejs\.org\/dist\/v24\.\d+\.\d+\/node-v24\.\d+\.\d+-win-x64\.zip$/,
    );
    expect(NODE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rechaza una descarga que no coincide y no la guarda', async () => {
    const cacheDir = tmp();
    const fetchFn = vi.fn(async () => new Response('falso'));
    await expect(nodeZip({ fetchFn, cacheDir })).rejects.toThrow(/no coincide/);
    expect(existsSync(join(cacheDir, 'node-v24.22.2-win-x64.zip'))).toBe(false);
  });

  it('guarda la buena y luego la reutiliza sin bajarla otra vez', async () => {
    const cacheDir = tmp();
    const body = Buffer.from('zip de prueba');
    const fetchFn = vi.fn(async () => new Response(body));
    const opts = { fetchFn, cacheDir, version: '24.0.0', expected: sha256(body) };
    const file = await nodeZip(opts);
    expect(readFileSync(file).equals(body)).toBe(true);
    await nodeZip(opts);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('instalador .exe: script NSIS', () => {
  it('rellena todos los huecos o falla', () => {
    expect(renderNsi(NSI, vars)).not.toMatch(/@@[A-Z_]+@@/);
    expect(() => renderNsi(NSI, { VERSION: '1' })).toThrow(/falta el valor @@/);
  });

  it('por usuario (sin administrador) y en «Agregar o quitar programas»', () => {
    expect(NSI).toContain('RequestExecutionLevel user');
    expect(NSI).toContain('InstallDir "$LOCALAPPDATA\\Asistenta"');
    for (const k of [
      'DisplayName',
      'DisplayVersion',
      'Publisher',
      'DisplayIcon',
      'UninstallString',
    ])
      expect(NSI).toMatch(new RegExp(`WriteRegStr HKCU "\\$\\{UNINST_KEY\\}" "${k}"`));
    expect(NSI).toContain('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Asistenta');
    expect(NSI).toContain(`DeleteRegKey HKCU "\${UNINST_KEY}"`);
  });

  it('desinstalar conserva .env y datos salvo la casilla (desmarcada de serie)', () => {
    expect(removeAppLines()).not.toMatch(/\.env"/);
    expect(NSI).toContain(`\${NSD_SetState} $CasillaDatos \${BST_UNCHECKED}`);
    const unin = NSI.slice(NSI.indexOf('Section "Uninstall"'));
    const casilla = unin.slice(
      unin.indexOf(`\${If} $BorrarDatos == \${BST_CHECKED}`),
      unin.indexOf(`\${EndIf}`, unin.indexOf('$BorrarDatos')),
    );
    const fuera = unin.replace(casilla, '');
    expect(casilla).toContain('Delete "$INSTDIR\\app\\.env"');
    expect(casilla).toContain('personal-agent');
    expect(fuera).not.toMatch(
      /\.env"|personal-agent|RMDir \/r "\$INSTDIR"|RMDir \/r "\$INSTDIR\\app"$/m,
    );
  });

  it('instalar encima no borra .env: solo quita lo que trae el programa', () => {
    const inst = renderNsi(NSI, vars).slice(0, NSI.indexOf('Section "Uninstall"'));
    expect(inst).not.toMatch(/\.env"|RMDir \/r "\$INSTDIR(\\app)?"/);
  });

  const makensis = spawnSync('makensis', ['-VERSION']).status === 0;
  it.skipIf(!makensis)('makensis lo compila con una preparación de prueba', () => {
    const stage = tmp();
    mkdirSync(join(stage, 'app', 'dist'), { recursive: true });
    mkdirSync(join(stage, 'node'));
    writeFileSync(join(stage, 'app', 'dist', 'cli.js'), '');
    writeFileSync(join(stage, 'node', 'node.exe'), '');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(stage, 'asistenta.ico'), icoFromPngs([{ size: 16, data: png }]));
    writeFileSync(join(stage, 'bienvenida.bmp'), bmp24(1, 1, Buffer.from([1, 2, 3])));
    const out = join(stage, 'prueba.exe');
    writeFileSync(join(stage, 'a.nsi'), renderNsi(NSI, { ...vars, STAGE: stage, OUTFILE: out }));
    const r = spawnSync(
      'makensis',
      ['-NOCONFIG', '-INPUTCHARSET', 'UTF8', '-V1', '-WX', join(stage, 'a.nsi')],
      {
        encoding: 'utf8',
      },
    );
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
  });
});
