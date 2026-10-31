import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browserRoot,
  connectionFromBrowser,
  countsAsBrowser,
  judgeProcess,
  ownerLookupWorks,
  type ProcInfo,
} from '../evolve/probe-owner.js';

// La sonda pregunta al sistema qué proceso abrió cada conexión a su servidor de pruebas.
// Una petición hecha desde Node (como haría el código de un intento que se hace pasar por
// el navegador) no es del navegador, diga lo que diga su User-Agent.
describe('quién abrió la conexión a la sonda', () => {
  it.runIf(process.platform === 'linux')(
    'una petición desde Node no es del navegador',
    async () => {
      let verdict: boolean | null | undefined;
      const server = createServer((_req, res) => res.end('ok'));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      server.on('connection', (s: Socket) => {
        verdict = connectionFromBrowser(s.remotePort ?? 0, port);
      });
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/',
            headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          },
        );
        req.on('error', reject);
        req.end();
      });
      server.close();
      expect(verdict).toBe(false);
    },
  );

  it('un puerto que nadie usa no se atribuye a nadie', () => {
    expect(connectionFromBrowser(1, 2)).toBeNull();
  });

  // Un intento que copia Node a un fichero llamado «chrome» y manda los avisos desde ahí.
  // Antes contaba como navegador solo por el nombre.
  it.runIf(process.platform === 'linux')(
    'Node copiado con nombre de navegador no es el navegador',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'evo-owner-'));
      const folder = join(dir, 'ms-playwright', 'chromium-1', 'chrome-linux');
      mkdirSync(folder, { recursive: true });
      const chrome = join(folder, 'chrome');
      copyFileSync(process.execPath, chrome);
      let verdict: boolean | null | undefined;
      const server = createServer((_req, res) => res.end('ok'));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      server.on('connection', (s: Socket) => {
        verdict = connectionFromBrowser(s.remotePort ?? 0, port);
      });
      const old = process.env.PLAYWRIGHT_BROWSERS_PATH;
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(dir, 'ms-playwright');
      try {
        await new Promise<void>((resolve, reject) =>
          execFile(
            chrome,
            [
              '-e',
              `fetch('http://127.0.0.1:${port}/', { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' } }).then((r) => r.text())`,
            ],
            { timeout: 30_000 },
            (err) => (err ? reject(err) : resolve()),
          ),
        );
      } finally {
        if (old === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
        else process.env.PLAYWRIGHT_BROWSERS_PATH = old;
        server.close();
        rmSync(dir, { recursive: true, force: true });
      }
      expect(verdict).toBe(false);
    },
    60_000,
  );
});

// Procesos de mentira: 10 = agente de la sonda, 20 = navegador que lanzó, 21 = su proceso
// de red; 30 = otro navegador lanzado aparte (hijo de 99), 31 = su proceso de red.
const PW = '/pw/chromium_headless_shell-1/chrome-linux/headless_shell';
const table: Record<number, { exe: string; ppid: number }> = {
  10: { exe: '/usr/bin/node', ppid: 1 },
  20: { exe: PW, ppid: 10 },
  21: { exe: PW, ppid: 20 },
  30: { exe: PW, ppid: 99 },
  31: { exe: PW, ppid: 30 },
  40: { exe: '/tmp/x/chrome', ppid: 10 },
  99: { exe: '/usr/bin/bash', ppid: 1 },
};
const proc: ProcInfo = {
  exe: (pid) => table[pid]?.exe ?? null,
  ppid: (pid) => table[pid]?.ppid ?? null,
};

describe('qué navegador abrió la conexión', () => {
  it('el proceso de red del navegador del agente cuenta, con su proceso principal', () => {
    expect(judgeProcess(21, { agentPid: 10, folder: '/pw', proc })).toEqual({
      browser: true,
      root: 20,
    });
    expect(browserRoot(21, proc)).toBe(20);
  });

  it('un navegador que no cuelga del agente no cuenta', () => {
    expect(judgeProcess(31, { agentPid: 10, folder: '/pw', proc }).browser).toBe(false);
  });

  it('un «chrome» fuera de la carpeta de navegadores de Playwright no cuenta', () => {
    expect(judgeProcess(40, { agentPid: 10, folder: '/pw', proc }).browser).toBe(false);
  });
});

describe('cuando el dueño de la conexión ya no está', () => {
  it.runIf(process.platform === 'linux')('en Linux la sonda sabe mirar quién conecta', async () => {
    expect(await ownerLookupWorks()).toBe(true);
  });

  it('si el sistema sabe mirar, solo cuenta una conexión demostrada del navegador', () => {
    expect(countsAsBrowser(true, null, true)).toBe(false);
    expect(countsAsBrowser(true, undefined, true)).toBe(false);
    expect(countsAsBrowser(true, true, true)).toBe(true);
    expect(countsAsBrowser(false, true, true)).toBe(false);
  });

  it('si no sabe mirar, vale el User-Agent como antes', async () => {
    expect(await ownerLookupWorks(() => null)).toBe(false);
    expect(countsAsBrowser(true, null, false)).toBe(true);
    expect(countsAsBrowser(true, false, false)).toBe(false);
  });
});
