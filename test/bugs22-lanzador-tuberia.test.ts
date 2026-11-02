import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { startDaemonTaskArgs } from '../src/autostart-watchdog.js';

/**
 * 2 nov: la tarea «personal-agent-daemon» seguía «En ejecución» sin ningún node vivo, así que
 * ni el reinicio de Task Scheduler (RestartCount) ni el vigilante (Start-ScheduledTask con
 * IgnoreNew) la volvían a levantar. Causa: run-hidden.ps1, ya con node cerrado, esperaba sin
 * plazo a que se cerrara la tubería de stdout/stderr; en Windows la heredan los procesos que
 * node deja vivos (el Chrome real por CDP, un `pa autoupdate aplicar` desligado…) y no se
 * cierra nunca. La espera de la copia tiene que tener plazo.
 */
const launcher = readFileSync('deploy/windows/run-hidden.ps1', 'utf8');
const core = readFileSync('deploy/windows/autostart-core.ps1', 'utf8');

describe('el lanzador no se queda colgado tras cerrarse node', () => {
  it('run-hidden.ps1 no espera sin plazo a las copias de stdout/stderr', () => {
    expect(launcher).not.toMatch(/\$(outCopy|errCopy)\.GetAwaiter\(\)\.GetResult\(\)/);
    expect(launcher).not.toMatch(/\$(outCopy|errCopy)\.Wait\(\)/);
    expect(launcher).toMatch(/\$outCopy\.Wait\(\d+\)/);
    expect(launcher).toMatch(/\$errCopy\.Wait\(\d+\)/);
    // Lo de siempre sigue: espera a node y devuelve su código.
    expect(launcher).toContain('$exitCode = $process.ExitCode');
    expect(launcher).toContain('exit $exitCode');
  });

  it('Invoke-BoundedProgram tampoco espera sin plazo a la salida del auxiliar', () => {
    const fn = core.slice(core.indexOf('function Invoke-BoundedProgram'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    expect(body).not.toMatch(/\$out\.GetAwaiter\(\)\.GetResult\(\)/);
    expect(body).toMatch(/\$out\.Wait\(\d+\)/);
  });
});

describe('arrancar la tarea del daemon con el daemon parado', () => {
  it('para antes la tarea si lleva minutos «En ejecución» (lanzador colgado) y luego la arranca', () => {
    const cmd = startDaemonTaskArgs().at(-1) ?? '';
    expect(cmd).toContain("Get-ScheduledTask -TaskName 'personal-agent-daemon' -ErrorAction Stop");
    const stop = cmd.indexOf('Stop-ScheduledTask');
    const start = cmd.lastIndexOf('Start-ScheduledTask');
    expect(stop).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(stop);
    // Solo si está en ejecución y desde hace rato: una tarea recién lanzada no se toca.
    const guard = cmd.slice(0, stop);
    expect(guard).toContain("$t.State -eq 'Running'");
    expect(guard).toMatch(/LastRunTime -lt \(Get-Date\)\.AddMinutes\(-\d+\)/);
  });
});
