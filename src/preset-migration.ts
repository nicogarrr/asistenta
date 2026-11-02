/**
 * Migración única (decisión de Nico, 2-nov-2026): el modelo de Asistenta es
 * DeepSeek V4.1 Flash por OpenCode Go (su suscripción, coste 0 medido), NO el
 * `opencode serve` local. Un .env que aun fija PA_PROVIDER_PRESET=opencode-local
 * (pin del 15-oct, cuando se monto el adapter local) se reescribe solo a
 * 'opencode' y queda marcado: quien vuelva a fijar local a conciencia DESPUES
 * de la migracion no se migra otra vez. Si el pin no esta en el archivo (p.ej.
 * es una variable de entorno de verdad), no se toca nada: el entorno real manda.
 *
 * El arranque de Windows (resolve-preset.mjs) lee el mismo .env, asi que tras
 * la migracion Docker/OpenCode local ya no se abre (regla de run-stack.ps1).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { envFileText } from './env-text.js';
import { dotEnvFiles } from './envfile.js';

/** Marca de «ya migrado»: un pin nuevo a mano con la marca presente se respeta. */
export const PRESET_MIGRATION_MARKER = '# pa:preset-migrado-a-opencode-go';

const PIN_LOCAL = /^[ \t]*PA_PROVIDER_PRESET[ \t]*=[ \t]*opencode-local[ \t]*$/m;
/** El modelo -free del montaje local/zen roto: con PA_MODEL fijado pisaría el default. */
const PIN_MODEL_FREE = /^[ \t]*PA_MODEL[ \t]*=[ \t]*deepseek-v4\.1-flash-free[ \t]*$/m;

export interface PresetMigrationDeps {
  readFile?: (path: string) => Buffer;
  writeFile?: (path: string, text: string) => void;
  env?: { PA_PROVIDER_PRESET?: string | undefined; PA_MODEL?: string | undefined };
  files?: string[];
}

/**
 * Reescribe el pin del .env y ajusta process.env si el valor venia de ahi.
 * Devuelve el aviso para el usuario (en castellano) o null si no habia nada.
 */
export function migrateLocalPresetPin(deps: PresetMigrationDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const read = deps.readFile ?? ((p: string) => readFileSync(p));
  const write = deps.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));
  const files = deps.files ?? dotEnvFiles();
  let touched = false;
  for (const file of files) {
    let text: string;
    try {
      // UTF-16/BOM entran por envFileText; al reescribir se guarda en UTF-8,
      // que el mismo envFileText lee sin problema.
      text = envFileText(read(file));
    } catch {
      continue;
    }
    if (text.includes(PRESET_MIGRATION_MARKER)) continue;
    if (!PIN_LOCAL.test(text) && !PIN_MODEL_FREE.test(text)) continue;
    let out = text.replace(
      PIN_LOCAL,
      `PA_PROVIDER_PRESET=opencode\n${PRESET_MIGRATION_MARKER} (2-nov-2026: DeepSeek V4.1 Flash por OpenCode Go; para volver al serve local, borra esta marca y pon opencode-local)`,
    );
    out = out.replace(PIN_MODEL_FREE, 'PA_MODEL=deepseek-v4.1-flash');
    try {
      write(file, out);
    } catch {
      return `Aviso: tu .env fija PA_PROVIDER_PRESET=opencode-local y no pude reescribirlo. El modelo pedido es DeepSeek V4.1 Flash por OpenCode Go: cambia esa linea a «opencode».`;
    }
    touched = true;
  }
  if (!touched) return null;
  if ((env.PA_PROVIDER_PRESET ?? '').trim().toLowerCase() === 'opencode-local') {
    env.PA_PROVIDER_PRESET = 'opencode';
  }
  if ((env.PA_MODEL ?? '').trim().toLowerCase() === 'deepseek-v4.1-flash-free') {
    env.PA_MODEL = 'deepseek-v4.1-flash';
  }
  return 'Tu .env fijaba el modelo local o la versión -free: lo he pasado a OpenCode Go con DeepSeek V4.1 Flash, que es el que pediste. Para volver al local algún día: PA_PROVIDER_PRESET=opencode-local en el .env.';
}
