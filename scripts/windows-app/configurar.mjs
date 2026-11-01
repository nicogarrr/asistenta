// «Configurar Asistenta» del instalador .exe: pide el token de Telegram y la clave del
// modelo con el mismo asistente que instalar.bat (scripts/instalar.mjs), sin `npm ci`
// ni compilar, porque el instalador ya trae el programa listo.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instalar, realDeps } from '../instalar.mjs';

/** Carpeta app (donde viven .env y dist/), sea cual sea la carpeta desde la que se abre. */
export const appDir = (url = import.meta.url) => join(dirname(fileURLToPath(url)), '..', '..');

/** Lo mismo que instalar.bat, menos descargar y compilar: npm no se lanza nunca. */
export function configurarDeps(base, cwd) {
  return {
    ...base,
    cwd,
    instalado: true,
    internet: undefined,
    npm: async () => true,
    run: async (cmd, args) => (cmd === 'npm' ? 0 : base.run(cmd, args)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.chdir(appDir());
  process.exitCode = await instalar(configurarDeps(realDeps, appDir()));
  // Configurada: Asistenta se queda en segundo plano con su icono junto al reloj.
  if (process.exitCode === 0 && process.platform === 'win32') {
    const vbs = join(appDir(), 'scripts', 'windows-app', 'asistenta.vbs');
    spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    process.stdout.write('✓ Asistenta sigue en segundo plano: mira el icono junto al reloj.\n');
  }
  // La ventana se queda abierta para leer el resultado.
  process.stdout.write('\nPulsa Enter para cerrar.');
  process.stdin.once('data', () => process.exit());
}
