import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  instaladoAutoupdateCommand,
  isInstalledLayout,
  isNewer,
  RELEASES_API,
  SHA_ASSET,
  shaFor,
} from '../src/actualizar-instalado.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-act-inst-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const EXE = Buffer.from('MZ instalador falso');
const EXE_NAME = 'Asistenta-Instalador-0.2.0.exe';
const EXE_URL = `https://github.com/nicogarrr/asistenta/releases/download/v0.2.0/${EXE_NAME}`;
const SHA_URL = `https://github.com/nicogarrr/asistenta/releases/download/v0.2.0/${SHA_ASSET}`;
const hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type Routes = Record<string, { status?: number; body: string | Buffer; url?: string }>;
function fakeFetch(routes: Routes, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = String(input);
    calls.push(u);
    const r = routes[u];
    if (!r) return new Response('no', { status: 404 });
    const body = typeof r.body === 'string' ? r.body : new Uint8Array(r.body);
    const res = new Response(body, { status: r.status ?? 200 });
    if (r.url) Object.defineProperty(res, 'url', { value: r.url });
    return res;
  }) as typeof fetch;
}
const release = (tag = 'v0.2.0', exeUrl = EXE_URL) =>
  JSON.stringify({
    tag_name: tag,
    assets: [
      { name: EXE_NAME, browser_download_url: exeUrl },
      { name: SHA_ASSET, browser_download_url: SHA_URL },
    ],
  });
const good = (): Routes => ({
  [RELEASES_API]: { body: release() },
  [SHA_URL]: { body: `${hex(EXE)}  ${EXE_NAME}\n` },
  [EXE_URL]: { body: EXE },
});

async function run(args: string[], routes: Routes, extra: { platform?: NodeJS.Platform } = {}) {
  const out: string[] = [];
  const launched: Array<[string, string[]]> = [];
  const calls: string[] = [];
  const code = await instaladoAutoupdateCommand(args, dir, {
    fetch: fakeFetch(routes, calls),
    current: '0.1.0',
    platform: extra.platform ?? 'win32',
    tmpDir: join(dir, 'tmp'),
    launch: (exe, flags) => launched.push([exe, flags]),
    out: (t) => out.push(t),
  });
  return { code, text: out.join('\n'), launched, calls };
}

describe('pa autoupdate en la copia instalada con el .exe', () => {
  it('reconoce la carpeta instalada: sin .git, con desinstalador y Node propio', () => {
    const app = join(dir, 'Asistenta', 'app');
    mkdirSync(join(dir, 'Asistenta', 'node'), { recursive: true });
    mkdirSync(app, { recursive: true });
    expect(isInstalledLayout(app)).toBe(false);
    writeFileSync(join(dir, 'Asistenta', 'Uninstall.exe'), '');
    writeFileSync(join(dir, 'Asistenta', 'node', 'node.exe'), '');
    expect(isInstalledLayout(app)).toBe(true);
    mkdirSync(join(app, '.git'));
    expect(isInstalledLayout(app)).toBe(false);
  });

  it('compara versiones x.y.z; lo raro nunca cuenta como nuevo', () => {
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('v0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('v0.0.9', '0.1.0')).toBe(false);
    for (const raro of ['', 'latest', 'v1.0.0-beta', '1.0'])
      expect(isNewer(raro, '0.1.0'), raro).toBe(false);
    expect(shaFor(`${'a'.repeat(64)} *${EXE_NAME}\r\n`, EXE_NAME)).toBe('a'.repeat(64));
    expect(shaFor(`${'a'.repeat(64)}  otro.exe`, EXE_NAME)).toBeNull();
  });

  it('status y la autoactualización periódica nunca descargan ni instalan', async () => {
    for (const a of [[], ['status'], ['aplicar'], ['on'], ['off']]) {
      const r = await run(a, good());
      expect(r.code, a.join()).toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.launched).toEqual([]);
      expect(r.text).toContain('pa autoupdate now');
    }
  });

  it('now: versión nueva con huella correcta → instala encima sin ventanas (/S)', async () => {
    const r = await run(['now'], good());
    expect(r.code).toBe(0);
    expect(r.launched).toEqual([[join(dir, 'tmp', EXE_NAME), ['/S']]]);
    expect(readFileSync(join(dir, 'tmp', EXE_NAME))).toEqual(EXE);
    expect(r.text).toContain('Instalando la versión 0.2.0 (tenías 0.1.0)');
    expect(r.text).toContain('tu .env y tus datos se quedan');
  });

  it('now: huella distinta → no instala ni guarda nada', async () => {
    const routes = good();
    routes[SHA_URL] = { body: `${'0'.repeat(64)}  ${EXE_NAME}\n` };
    const r = await run(['now'], routes);
    expect(r.code).toBe(1);
    expect(r.launched).toEqual([]);
    expect(existsSync(join(dir, 'tmp', EXE_NAME))).toBe(false);
    expect(r.text).toContain('no coincide con su huella SHA-256');
  });

  it('now: ya al día → no descarga el instalador', async () => {
    const routes = good();
    routes[RELEASES_API] = { body: release('v0.1.0') };
    const r = await run(['now'], routes);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([RELEASES_API]);
    expect(r.text).toBe('Ya tienes la última versión (0.1.0).');
  });

  it('now: sin versiones publicadas o sin internet → dice cómo actualizar a mano', async () => {
    const sin = await run(['now'], {});
    expect(sin.code).toBe(1);
    expect(sin.text).toContain('Todavía no hay ninguna versión publicada');
    expect(sin.text).toContain('https://github.com/nicogarrr/asistenta/releases');
    const caido = await run(['now'], { [RELEASES_API]: { status: 503, body: '' } });
    expect(caido.text).toContain('No he podido mirar si hay versión nueva');
    expect(caido.launched).toEqual([]);
  });

  it('now: solo descarga de GitHub (ni enlaces ni redirecciones a otro sitio)', async () => {
    const fuera = good();
    fuera[RELEASES_API] = { body: release('v0.2.0', 'https://ejemplo.invalid/x.exe') };
    const a = await run(['now'], fuera);
    expect(a.launched).toEqual([]);
    expect(a.calls).not.toContain('https://ejemplo.invalid/x.exe');
    const redir = good();
    redir[EXE_URL] = { body: EXE, url: 'https://ejemplo.invalid/x.exe' };
    const b = await run(['now'], redir);
    expect(b.code).toBe(1);
    expect(b.launched).toEqual([]);
  });

  it('now: sin el .sha256 adjunto no instala', async () => {
    const routes = good();
    routes[RELEASES_API] = {
      body: JSON.stringify({
        tag_name: 'v0.2.0',
        assets: [{ name: EXE_NAME, browser_download_url: EXE_URL }],
      }),
    };
    const r = await run(['now'], routes);
    expect(r.code).toBe(1);
    expect(r.launched).toEqual([]);
    expect(r.text).toContain('sin instalador adjunto');
  });

  it('fuera de Windows no hace nada; con órdenes raras deja la ayuda de siempre', async () => {
    const r = await run(['now'], good(), { platform: 'linux' });
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
    expect((await run(['ya'], good())).code).toBeNull();
    expect((await run(['now', 'x'], good())).code).toBeNull();
  });

  it('cli.ts lo usa solo en la copia instalada; el instalador silencioso vuelve a abrir Asistenta', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(
      /if \(inst\.isInstalledLayout\(autostartRepo\(\)\)\) \{\n\s+const code = await inst\.instaladoAutoupdateCommand\(rest, autostartRepo\(\)\);\n\s+if \(code !== null\) return code;/,
    );
    const nsi = readFileSync('scripts/windows-app/asistenta.nsi', 'utf8');
    expect(nsi).toMatch(
      /IfSilent 0 \+2\n\s+Exec '"\$SYSDIR\\wscript\.exe" "\$INSTDIR\\app\\scripts\\windows-app\\asistenta\.vbs"'\nSectionEnd/,
    );
  });
});
