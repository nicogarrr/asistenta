import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeInstancesForInstall } from '../src/autostart.js';
import {
  asistentaInstances,
  closeAllInstances,
  closeOutcomeText,
  daemonOf,
  instanceChecksEnabled,
  instancesDoctorLine,
  isAsistentaRepo,
  launcherOf,
  listProcesses,
  otherInstanceReason,
  type ProcInfo,
  parsePsList,
  parseWindowsList,
  realCloseDeps,
} from '../src/instancias.js';

/**
 * Nico (2 nov, 13:25): dos grupos «Windows PowerShell» con su node cada uno y respuestas
 * repetidas en Telegram. Solo debe quedar una Asistenta; nunca se toca otro node/PowerShell.
 */
const REPO = 'C:\\Users\\Nico\\asistenta';
const EXE = 'C:\\Users\\Nico\\AppData\\Local\\Asistenta\\app';
const ours = (r: string) => r === REPO || r === EXE;
const P = (pid: number, name: string, cmd: string, ppid = 1): ProcInfo => ({
  pid,
  ppid,
  name,
  cmd,
});

const LIST: ProcInfo[] = [
  // Tarea de Windows (run-stack → run-hidden → node dist\pa.js serve).
  P(
    10,
    'powershell.exe',
    `powershell.exe -NoProfile -File "${REPO}\\deploy\\windows\\run-stack.ps1" -RepoDir "${REPO}"`,
  ),
  P(11, 'node.exe', `"C:\\Program Files\\nodejs\\node.exe" "${REPO}\\dist\\pa.js" serve`, 10),
  // El .exe instalado (copia vieja que se quedó viva).
  P(
    20,
    'powershell.exe',
    `powershell.exe -File ${EXE}\\deploy\\windows\\run-hidden.ps1 -RepoDir ${EXE}`,
  ),
  P(21, 'node.exe', `${EXE}\\..\\node\\node.exe ${EXE}\\dist\\cli.js serve`, 20),
  // Lo que NO es una instancia de Asistenta.
  P(
    30,
    'node.exe',
    `"C:\\Program Files\\nodejs\\node.exe" "${REPO}\\dist\\cli.js" autostart-watchdog`,
  ),
  P(
    31,
    'node.exe',
    `"C:\\Program Files\\nodejs\\node.exe" "${REPO}\\dist\\pa.js" autoupdate aplicar`,
  ),
  P(32, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\otro\\dist\\cli.js" serve'),
  P(33, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" dist\\pa.js iniciar'),
  P(34, 'powershell.exe', 'powershell.exe -Command Get-Process'),
  P(35, 'Code.exe', `Code.exe "${REPO}\\dist\\pa.js" serve`),
];

describe('instancias de Asistenta', () => {
  it('reconoce solo daemons y lanzadores de Asistenta, nunca otro node o PowerShell', () => {
    const { daemons, launchers } = asistentaInstances(LIST, [], ours);
    expect(daemons.map((p) => p.pid)).toEqual([11, 21]);
    expect(launchers.map((p) => p.pid)).toEqual([10, 20]);
    expect(daemonOf(LIST[1] as ProcInfo)).toEqual({
      node: 'C:\\Program Files\\nodejs\\node.exe',
      repo: REPO,
    });
    expect(launcherOf(LIST[0] as ProcInfo)).toEqual({ repo: REPO });
    // Ni este proceso ni su padre.
    expect(asistentaInstances(LIST, [11, 21], ours).daemons).toEqual([]);
  });

  it('doble /stop (2 nov): una segunda Asistenta de otra carpeta no arranca y dice por qué', async () => {
    // Dos daemons con el mismo bot reciben el mismo /stop antes de que ninguno lo dé por
    // leído en Telegram, y los dos contestan «No había nada en curso.». Con esto la del .exe
    // (pid 21) impide arrancar la de la carpeta de git, y al revés.
    const list = async () => LIST;
    const fromRepo = await otherInstanceReason({ list, repo: REPO, exclude: [], isOurs: ours });
    expect(fromRepo).toContain('Ya hay otra Asistenta en marcha (proceso 21');
    expect(fromRepo).toContain('pa autostart install --start');
    const fromExe = await otherInstanceReason({ list, repo: EXE, exclude: [], isOurs: ours });
    expect(fromExe).toContain('(proceso 11');
    // La de la misma carpeta (mayúsculas o barras distintas) no cuenta: eso lo para agent.pid.
    const same = LIST.filter((p) => p.pid !== 21 && p.pid !== 20);
    expect(
      await otherInstanceReason({
        list: async () => same,
        repo: `${REPO.toUpperCase()}\\`,
        exclude: [],
        isOurs: ours,
      }),
    ).toBeNull();
    // Si no se puede leer la lista de procesos, arranca como siempre.
    expect(
      await otherInstanceReason({
        list: async () => {
          throw new Error('sin permiso');
        },
        repo: REPO,
      }),
    ).toBeNull();
    // Solo en Windows: en Linux/macOS conviven copias de desarrollo y pruebas.
    expect(instanceChecksEnabled('win32')).toBe(true);
    expect(instanceChecksEnabled('linux')).toBe(false);
    expect(instanceChecksEnabled('darwin')).toBe(false);
  });

  it('una carpeta solo cuenta si es de Asistenta (package.json «personal-agent»)', () => {
    const read = (f: string) => {
      if (f === join('/srv/asistenta', 'package.json')) return '{"name":"personal-agent"}';
      if (f === join('/srv/otro', 'package.json')) return '{"name":"otro"}';
      throw new Error('ENOENT');
    };
    expect(isAsistentaRepo('/srv/asistenta', read)).toBe(true);
    expect(isAsistentaRepo('/srv/otro', read)).toBe(false);
    expect(isAsistentaRepo('/srv/nada', read)).toBe(false);
    expect(isAsistentaRepo('', read)).toBe(false);
    expect(isAsistentaRepo('dist', read)).toBe(false);
  });

  it('lee la lista de Windows (un objeto o varios) y la de ps', () => {
    expect(
      parseWindowsList(
        '{"ProcessId":5,"ParentProcessId":1,"Name":"node.exe","CommandLine":"node a"}',
      ),
    ).toEqual([{ pid: 5, ppid: 1, name: 'node.exe', cmd: 'node a' }]);
    expect(parseWindowsList('[{"ProcessId":5,"Name":"node.exe","CommandLine":null}]')).toEqual([
      { pid: 5, ppid: 0, name: 'node.exe', cmd: '' },
    ]);
    expect(parseWindowsList('')).toEqual([]);
    expect(parsePsList('  7   1 node node /r/dist/pa.js serve\n')).toEqual([
      { pid: 7, ppid: 1, name: 'node', cmd: 'node /r/dist/pa.js serve' },
    ]);
  });

  it('pa doctor avisa con más de una en marcha', () => {
    expect(instancesDoctorLine(0)).toBeNull();
    expect(instancesDoctorLine(1)).toBeNull();
    expect(instancesDoctorLine(2)).toContain('2 instancias de Asistenta en marcha');
  });

  it('cierre: primero el pa stop de cada instalación; lo que queda, a la fuerza (daemon y luego lanzador)', async () => {
    let alive = [...LIST];
    const stops: string[] = [];
    const killed: number[] = [];
    const out = await closeAllInstances(
      {
        list: async () => alive,
        // La del repo para bien; la copia del .exe no responde.
        stop: async (_node, repo) => {
          stops.push(repo);
          if (repo === REPO) alive = alive.filter((p) => p.pid !== 11 && p.pid !== 10);
        },
        kill: (pid) => {
          killed.push(pid);
          alive = alive.filter((p) => p.pid !== pid);
        },
        sleep: async () => {},
        exclude: [],
        isOurs: ours,
      },
      2_000,
    );
    expect(stops).toEqual([REPO, EXE]);
    expect(killed).toEqual([21, 20]);
    expect(out).toEqual({ found: 2, stoppedClean: 1, killed: [21, 20] });
    expect(closeOutcomeText(out)).toBe(
      'Asistentas en marcha: 2. Paradas bien: 1. Cerrados a la fuerza: 2 procesos de Asistenta (ningún otro).',
    );
    // Lo que no era de Asistenta sigue ahí.
    expect(alive.map((p) => p.pid)).toEqual([30, 31, 32, 33, 34, 35]);
  });

  it('autostart install: sin --start solo cierra si sobra alguna; con --start las cierra todas', async () => {
    const one = LIST.filter((p) => p.pid !== 21 && p.pid !== 20);
    const deps = (list: ProcInfo[]) => ({
      list: async () => list,
      stop: async () => {},
      kill: () => {},
      sleep: async () => {},
      exclude: [],
      isOurs: ours,
    });
    expect(await closeInstancesForInstall(false, deps(one))).toBeNull();
    expect(await closeInstancesForInstall(false, deps(LIST))).toContain('Asistentas en marcha: 2');
    expect(await closeInstancesForInstall(true, deps(one))).toContain('Asistentas en marcha: 1');
    expect(await closeInstancesForInstall(true, deps([]))).toBeNull();
  });

  it.runIf(process.platform === 'linux')(
    'de verdad: cierra un daemon de Asistenta que no hace caso al stop y deja vivo otro node',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pa-instancias-'));
      const repo = join(dir, 'asistenta');
      const other = join(dir, 'otro');
      for (const r of [repo, other]) {
        mkdirSync(join(r, 'dist'), { recursive: true });
        // serve: se queda colgado; stop: sale sin hacer nada (como una copia que no responde).
        writeFileSync(
          join(r, 'dist', 'cli.js'),
          "if (process.argv[2] === 'serve') setInterval(() => {}, 1000);",
        );
      }
      writeFileSync(join(repo, 'package.json'), '{"name":"personal-agent"}');
      writeFileSync(join(other, 'package.json'), '{"name":"otro"}');
      const a = spawn(process.execPath, [join(repo, 'dist', 'cli.js'), 'serve'], {
        stdio: 'ignore',
      });
      const b = spawn(process.execPath, [join(other, 'dist', 'cli.js'), 'serve'], {
        stdio: 'ignore',
      });
      try {
        await new Promise((r) => setTimeout(r, 300));
        // Solo las carpetas de este test: nunca los daemons de otras pruebas de la máquina.
        const onlyHere = (r: string) => r.startsWith(dir) && isAsistentaRepo(r);
        const found = asistentaInstances(await listProcesses(), [process.pid], onlyHere);
        expect(found.daemons.map((p) => p.pid)).toEqual([a.pid]);
        const out = await closeAllInstances({ ...realCloseDeps(), isOurs: onlyHere }, 1_000);
        expect(out.found).toBe(1);
        expect(out.killed).toEqual([a.pid]);
        await new Promise((r) => setTimeout(r, 300));
        expect(a.exitCode !== null || a.signalCode !== null).toBe(true);
        expect(b.exitCode).toBeNull();
        expect(b.signalCode).toBeNull();
      } finally {
        a.kill('SIGKILL');
        b.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it('autostart install quita la misma tarea registrada en otra carpeta del Programador', () => {
    const install = readFileSync(join('deploy', 'windows', 'install-all.ps1'), 'utf8');
    const block = install.slice(install.indexOf('# Una sola Asistenta'));
    expect(block).toContain("foreach($name in @('personal-agent-daemon','browserd-sidecar'))");
    // Solo las de OTRA carpeta (la propia se acaba de registrar) y solo con esos nombres.
    expect(block).toContain('Where-Object {$_.TaskPath -and $_.TaskPath -ne $identity.Path}');
    expect(block).toContain('Unregister-ScheduledTask -InputObject $_ -Confirm:$false');
    expect(block.indexOf('Unregister-ScheduledTask')).toBeLessThan(
      block.indexOf('if($LibraryOnly)'),
    );
  });
});
