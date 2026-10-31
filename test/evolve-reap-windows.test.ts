import { describe, expect, it } from 'vitest';
import {
  attemptRoots,
  noteAttemptRoot,
  type ProcInfo,
  parseWindowsProcs,
  pickAttempt,
  reapAttempt,
} from '../src/evolve/reap.js';

// En Windows solo se ve la línea de órdenes de cada proceso. Un proceso que el intento deja
// huérfano con una orden que no nombra la copia («node server.js» lanzado desde la copia) se
// quedaba vivo. Ahora se recuerdan los procesos que lanzamos nosotros, y en Windows un
// huérfano sigue apuntando a su padre muerto: sus hijos se encuentran por ahí.
const DIR = 'C:\\Users\\nico\\AppData\\Local\\Temp\\pa-evolve-abc';
const SELF = 1;
const T0 = 1_800_000_000_000;

describe('cerrar lo que el intento deja en Windows', () => {
  it('un huérfano del proponente con una orden que no nombra la copia se cierra', () => {
    const dir = `${DIR}-1`;
    let now = T0;
    const ended = noteAttemptRoot(dir, 500, () => now);
    now += 30_000;
    ended();
    const procs: ProcInfo[] = [
      { pid: SELF, ppid: 0, created: T0 - 60_000 },
      // el proponente (500) ya terminó; su hijo sigue vivo
      { pid: 600, ppid: 500, cmd: 'node server.js', created: T0 + 1_000 },
      { pid: 601, ppid: 600, cmd: 'node worker.js', created: T0 + 2_000 },
      // otro programa del usuario, sin relación
      { pid: 700, ppid: 4, cmd: 'notepad.exe', created: T0 + 1_500 },
    ];
    const killed: number[] = [];
    const n = reapAttempt(dir, {
      list: () => procs.filter((p) => !killed.includes(p.pid)),
      kill: (pid) => killed.push(pid),
    });
    expect(killed.sort()).toEqual([600, 601]);
    expect(n).toBe(2);
  });

  it('un pid reutilizado por otro programa no se toca', () => {
    const roots = [{ pid: 500, at: T0, end: T0 + 30_000 }];
    const procs: ProcInfo[] = [
      { pid: SELF, ppid: 0, created: T0 - 60_000 },
      // el 500 ahora es otro programa, nacido después de que el nuestro terminara
      { pid: 500, ppid: 4, cmd: 'chrome.exe', created: T0 + 90_000 },
      { pid: 800, ppid: 500, cmd: 'chrome.exe --type=renderer', created: T0 + 91_000 },
    ];
    expect(pickAttempt(procs, DIR, SELF, true, roots)).toEqual([]);
  });

  it('el proponente aún vivo y sus hijos se cierran', () => {
    const roots = [{ pid: 500, at: T0 }];
    const procs: ProcInfo[] = [
      { pid: SELF, ppid: 0, created: T0 - 60_000 },
      { pid: 500, ppid: SELF, cmd: 'proponer.exe', created: T0 + 100 },
      { pid: 501, ppid: 500, cmd: 'node x.js', created: T0 + 200 },
    ];
    expect(pickAttempt(procs, DIR, SELF, true, roots).sort()).toEqual([500, 501]);
  });

  it('una orden con la copia escrita con barras normales o dobles también cuenta', () => {
    const procs: ProcInfo[] = [
      { pid: SELF, ppid: 0 },
      { pid: 20, ppid: 4, cmd: 'node C:/Users/nico/AppData/Local/Temp/pa-evolve-abc/evil.js' },
      {
        pid: 21,
        ppid: 4,
        cmd: 'node -e "require(\'C:\\\\Users\\\\nico\\\\AppData\\\\Local\\\\Temp\\\\pa-evolve-abc\\\\x\')"',
      },
      { pid: 22, ppid: 4, cmd: 'node C:/Users/nico/otra/evil.js' },
    ];
    expect(pickAttempt(procs, DIR, SELF, true).sort()).toEqual([20, 21]);
  });

  it('lee la fecha de creación que da PowerShell 5 y 7', () => {
    const ps5 = parseWindowsProcs(
      '[{"ProcessId":5,"ParentProcessId":4,"CommandLine":null,"CreationDate":"/Date(1800000000000)/"}]',
    );
    expect(ps5[0]).toMatchObject({ pid: 5, ppid: 4, created: T0 });
    const ps7 = parseWindowsProcs(
      '{"ProcessId":6,"ParentProcessId":4,"CommandLine":"x","CreationDate":"2027-01-15T08:00:00Z"}',
    );
    expect(ps7[0]?.created).toBe(Date.parse('2027-01-15T08:00:00Z'));
  });

  it('se apuntan los procesos que lanzamos', () => {
    const dir = `${DIR}-apunta`;
    noteAttemptRoot(dir, 42, () => T0)();
    noteAttemptRoot(dir, undefined)();
    expect(attemptRoots(dir)).toEqual([{ pid: 42, at: T0, end: T0 }]);
  });
});
