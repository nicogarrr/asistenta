import { describe, expect, it } from 'vitest';
import { ownerLookupWorks } from '../evolve/probe-owner.js';
import {
  connectionOwnerOs,
  fallbackNote,
  NETSTAT_MS,
  OWNER_LOOKUP_WAIT_MS,
  ownerLookupOs,
  pidFromLsof,
  pidFromNetstat,
  procTable,
  type Run,
  TABLE_MS,
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

// En Windows cada consulta de la tabla de procesos es un PowerShell (~1 s). Antes era uno por
// conexión y, si tardaba más de 15 s, la sonda pasaba sin decir nada a mirar solo el User-Agent.
describe('la consulta de Windows es barata, acotada y avisa', () => {
  const counting = (delays: Record<string, number> = {}) => {
    const calls: Record<string, number> = {};
    const run: Run = (cmd) => {
      calls[cmd] = (calls[cmd] ?? 0) + 1;
      const out = cmd === 'netstat' ? NETSTAT : WIN_PROCS;
      const ms = delays[cmd];
      if (ms === undefined) return Promise.resolve(out);
      return new Promise((r) => (ms < 0 ? undefined : setTimeout(() => r(out), ms)));
    };
    return { calls, run };
  };

  it('diez conexiones a la vez: un netstat y un PowerShell, no diez', async () => {
    const { calls, run } = counting();
    const look = ownerLookupOs({ platform: 'win32', run, folder: PW });
    const ports = [50001, 50002, 50003, 50004, 50001, 50002, 50003, 50004, 50001, 50002];
    const v = await Promise.all(ports.map((p) => look(p, 8080, { agentPid: 1000 })));
    expect(v.map((x) => x.browser)).toEqual([
      true,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(calls).toEqual({ netstat: 1, 'powershell.exe': 1 });
    // Más tarde, con procesos ya conocidos: otro netstat (la conexión es nueva), sin PowerShell.
    expect((await look(50001, 8080, { agentPid: 1000 })).browser).toBe(true);
    expect(calls).toEqual({ netstat: 2, 'powershell.exe': 1 });
  });

  it('un proceso que no está en la tabla guardada obliga a leerla otra vez', async () => {
    let procs = WIN_PROCS.split('\r\n')
      .filter((l) => !l.startsWith('4400'))
      .join('\r\n');
    let ps = 0;
    const run: Run = async (cmd) => {
      if (cmd === 'netstat') return NETSTAT;
      ps++;
      return procs;
    };
    const look = ownerLookupOs({ platform: 'win32', run, folder: PW });
    expect((await look(50001, 8080, { agentPid: 1000 })).browser).toBe(true);
    procs = WIN_PROCS;
    // 4400 es Node: hay que verlo en una tabla nueva, no fiarse de la vieja.
    expect((await look(50003, 8080, { agentPid: 1000 })).browser).toBe(false);
    expect(ps).toBe(2);
  });

  it('una tabla vieja no se reutiliza', async () => {
    let t = 0;
    const { calls, run } = counting();
    const look = ownerLookupOs({
      platform: 'win32',
      run,
      folder: PW,
      now: () => t,
      tableTtlMs: 1000,
    });
    await look(50001, 8080, { agentPid: 1000 });
    t = 5000;
    await look(50001, 8080, { agentPid: 1000 });
    expect(calls['powershell.exe']).toBe(2);
  });

  it('PowerShell lento pero dentro del plazo: la comprobación fuerte sigue en pie', async () => {
    const selfTest = async (tableMs: number) => {
      let pair = '';
      const run: Run = (cmd) =>
        cmd === 'netstat'
          ? Promise.resolve(`  TCP    ${pair}   ESTABLISHED   1000`)
          : new Promise((r) => setTimeout(() => r(WIN_PROCS), 60));
      const look = ownerLookupOs({ platform: 'win32', run, folder: PW, tableMs });
      const works = await ownerLookupWorks(async (c, s) => {
        pair = `127.0.0.1:${c}  127.0.0.1:${s}`;
        return (await look(c, s)).browser;
      }, 2000);
      return { works, problem: look.problem() };
    };
    expect(await selfTest(500)).toEqual({ works: true, problem: null });
    expect(await selfTest(20)).toEqual({
      works: false,
      problem: 'powershell.exe tardó más de 1 s',
    });
    // La sonda espera lo que pueden tardar netstat y PowerShell juntos.
    expect(OWNER_LOOKUP_WAIT_MS).toBeGreaterThan(NETSTAT_MS + TABLE_MS);
  });

  it('si PowerShell no responde a tiempo, lo dice una vez y la conexión no cuenta', async () => {
    const { calls, run } = counting({ 'powershell.exe': -1 });
    const said: string[] = [];
    const look = ownerLookupOs({
      platform: 'win32',
      run,
      folder: PW,
      tableMs: 50,
      onProblem: (w) => said.push(w),
    });
    const v = await Promise.all(
      [50001, 50002, 50001].map((p) => look(p, 8080, { agentPid: 1000 })),
    );
    expect(v.map((x) => x.browser)).toEqual([null, null, null]);
    await look(50001, 8080, { agentPid: 1000 });
    expect(said).toEqual(['powershell.exe tardó más de 1 s']);
    expect(look.problem()).toBe('powershell.exe tardó más de 1 s');
    expect(calls['powershell.exe']).toBe(2);
  });

  it('la vuelta al User-Agent se anuncia con el motivo', () => {
    expect(fallbackNote(true, null)).toBeNull();
    const n = fallbackNote(false, 'powershell.exe tardó más de 30 s') ?? '';
    expect(n).toContain('powershell.exe tardó más de 30 s');
    expect(n).toContain('User-Agent');
    expect(fallbackNote(false, null)).toContain('el sistema no lo dice');
  });
});
