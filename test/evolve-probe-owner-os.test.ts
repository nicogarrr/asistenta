import { describe, expect, it } from 'vitest';
import {
  connectionOwnerOs,
  pidFromLsof,
  pidFromNetstat,
  procTable,
  type Run,
} from '../evolve/probe-owner-os.js';

// En Windows y macOS no hay /proc: la sonda pregunta a netstat/lsof quién tiene la conexión
// y a la tabla de procesos qué programa es y de quién cuelga. Todo con salidas de mentira.

const PW = 'C:\\Users\\Nico\\AppData\\Local\\ms-playwright';
const SHELL = `${PW}\\chromium_headless_shell-1243\\chrome-win\\headless_shell.exe`;
const NETSTAT = [
  '',
  'Conexiones activas',
  '  Proto  Dirección local  Dirección remota  Estado  PID',
  '  TCP    127.0.0.1:8080   127.0.0.1:50001   ESTABLISHED   4',
  '  TCP    127.0.0.1:50001  127.0.0.1:8080    ESTABLISHED   2100',
  '  TCP    127.0.0.1:50002  127.0.0.1:8080    ESTABLISHED   3300',
  '  TCP    127.0.0.1:50003  127.0.0.1:8080    ESTABLISHED   4400',
  '  TCP    127.0.0.1:50004  127.0.0.1:8080    ESTABLISHED   5500',
].join('\r\n');
const WIN_PROCS = [
  '1000\t900\tC:\\Program Files\\nodejs\\node.exe',
  `2000\t1000\t${SHELL}`,
  `2100\t2000\t${SHELL}`,
  '3300\t1000\tC:\\Users\\Nico\\AppData\\Local\\Temp\\x\\chrome.exe',
  `4400\t1000\tC:\\Program Files\\nodejs\\node.exe`,
  `5000\t77\t${SHELL}`,
  `5500\t5000\t${SHELL}`,
].join('\r\n');

const fake =
  (out: Record<string, string>): Run =>
  async (cmd) =>
    out[cmd] ?? '';
const win = fake({ netstat: NETSTAT, 'powershell.exe': WIN_PROCS });
const opts = (run: Run) => ({ agentPid: 1000, platform: 'win32' as const, run, folder: PW });

describe('quién abrió la conexión en Windows', () => {
  it('lee el PID de netstat para esa pareja de puertos', () => {
    expect(pidFromNetstat(NETSTAT, 50001, 8080)).toBe(2100);
    expect(pidFromNetstat(NETSTAT, 8080, 50001)).toBe(4);
    expect(pidFromNetstat(NETSTAT, 59999, 8080)).toBeNull();
  });

  it('el proceso de red del navegador del agente es el navegador', async () => {
    expect(await connectionOwnerOs(50001, 8080, opts(win))).toEqual({ browser: true, root: 2000 });
  });

  it('un «chrome.exe» fuera de la carpeta de Playwright no lo es', async () => {
    expect((await connectionOwnerOs(50002, 8080, opts(win))).browser).toBe(false);
  });

  it('Node no lo es aunque mande User-Agent de navegador', async () => {
    expect((await connectionOwnerOs(50003, 8080, opts(win))).browser).toBe(false);
  });

  it('un navegador que no cuelga del agente no lo es', async () => {
    expect((await connectionOwnerOs(50004, 8080, opts(win))).browser).toBe(false);
  });

  it('sin netstat o sin tabla de procesos, no se sabe', async () => {
    expect((await connectionOwnerOs(50001, 8080, opts(fake({})))).browser).toBeNull();
    expect(
      (await connectionOwnerOs(50001, 8080, opts(fake({ netstat: NETSTAT })))).browser,
    ).toBeNull();
  });
});

describe('quién abrió la conexión en macOS', () => {
  const LSOF = [
    'p700',
    'n127.0.0.1:8080->127.0.0.1:50001',
    'p2100',
    'n127.0.0.1:50001->127.0.0.1:8080',
    'p4400',
    'n127.0.0.1:50003->127.0.0.1:8080',
  ].join('\n');
  const APP = '/Users/nico/Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium.app';
  const EXE = `${APP}/Contents/MacOS/Chromium`;
  const PS = [
    ' 1000   900 /usr/local/bin/node',
    ` 2000  1000 ${EXE}`,
    ` 2100  2000 ${EXE}`,
    ' 4400  1000 /usr/local/bin/node',
  ].join('\n');
  const mac = fake({ lsof: LSOF, ps: PS });
  const o = {
    agentPid: 1000,
    platform: 'darwin' as const,
    run: mac,
    folder: '/Users/nico/Library/Caches/ms-playwright',
  };

  it('lee el PID de lsof para esa pareja de puertos', () => {
    expect(pidFromLsof(LSOF, 50001, 8080)).toBe(2100);
    expect(pidFromLsof(LSOF, 8080, 50001)).toBe(700);
  });

  it('el navegador del agente lo es; Node no', async () => {
    expect(await connectionOwnerOs(50001, 8080, o)).toEqual({ browser: true, root: 2000 });
    expect((await connectionOwnerOs(50003, 8080, o)).browser).toBe(false);
  });

  it('un programa sin ruta completa no se puede comprobar', () => {
    expect(procTable('12 1 chrome').exe(12)).toBeNull();
  });
});
