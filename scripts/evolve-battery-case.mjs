// Evaluador por defecto de la batería (PA_EVOLVE_BATTERY sin definir).
// El bucle lo lanza como `node scripts/evolve-battery-case.mjs` con cwd = la copia del código
// que se mide y el caso en PA_BATTERY_CASE. Corre ese caso con el código FUENTE de esa copia
// (src/, sin compilar: Node 24 quita los tipos), con datos en una carpeta temporal y sin
// cuentas reales, y escribe la traza JSON en la última línea de stdout.
// Salida: 0 = traza escrita; 2 = caso inválido; 1 = el código no arrancó o falló.
import { mkdtempSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// src/ importa con «.js» lo que en disco es «.ts»: si el .js no existe, prueba el .ts.
const hook = `export async function resolve(s, c, next) {
  try { return await next(s, c); } catch (e) {
    if ((s.startsWith('./') || s.startsWith('../')) && s.endsWith('.js')) return next(s.slice(0, -3) + '.ts', c);
    throw e;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const dir = mkdtempSync(join(tmpdir(), 'pa-battery-'));
// Nada de lo que arranque aquí puede leer ni escribir los datos reales de Nico.
process.env.PA_STATE_DIR = join(dir, 'state');
process.env.HOME = dir;
process.env.USERPROFILE = dir;

let code = 1;
try {
  const mod = await import(pathToFileURL(join(process.cwd(), 'src', 'evolve', 'battery-case.ts')).href);
  let c;
  try {
    c = mod.caseFromEnv(process.env);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    code = 2;
  }
  if (c) {
    const { loadConfig } = await import(pathToFileURL(join(process.cwd(), 'src', 'config.ts')).href);
    const trace = await mod.runBatteryCase(c, { config: loadConfig(), stateDir: join(dir, 'caso') });
    process.stdout.write(`${JSON.stringify(trace)}\n`);
    code = 0;
  }
} catch (e) {
  process.stderr.write(`El evaluador de la batería falló: ${e instanceof Error ? e.message : String(e)}\n`);
  code = 1;
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Un fichero bloqueado en Windows no debe tapar la traza.
  }
}
process.exitCode = code;
