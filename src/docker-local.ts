/**
 * Docker/OpenCode local encendido sin usarse (Nico, 2 nov: «usamos la nube, que eso lo
 * compruebe automáticamente»). El contenedor «asistenta-opencode» solo sirve con
 * PA_PROVIDER_PRESET=opencode-local; con la nube, Docker Desktop y WSL gastan 2-3 GB de RAM
 * para nada. `pa doctor` lo dice; nunca para ni borra el contenedor (es de Nico).
 */
import { execFile } from 'node:child_process';

export const LOCAL_LLM_CONTAINER = 'asistenta-opencode';

/** ¿Está en marcha el contenedor local? Solo lectura (`docker ps`); sin Docker, false. */
export function localLlmContainerRunning(
  run: (exe: string, args: string[]) => Promise<string | null> = dockerOut,
): Promise<boolean> {
  return run('docker', [
    'ps',
    '--filter',
    `name=^${LOCAL_LLM_CONTAINER}$`,
    '--format',
    '{{.Names}}',
  ]).then(
    (out) => (out ?? '').split(/\r?\n/).some((l) => l.trim() === LOCAL_LLM_CONTAINER),
    () => false,
  );
}

function dockerOut(exe: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 5_000 }, (error, stdout) =>
      resolve(error ? null : String(stdout ?? '')),
    );
  });
}

/** Línea de `pa doctor`, o null si se usa (opencode-local) o no está encendido. */
export function unusedLocalLlmDoctorLine(preset: string, running: boolean): string | null {
  if (!running || preset.trim().toLowerCase() === 'opencode-local') return null;
  return 'docker local    Docker/OpenCode local en marcha pero no se usa (vas por la nube): puedes cerrarlo';
}
