import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * .env.example es la referencia de configuración: toda variable PA_* que lea
 * src/ tiene que estar documentada ahí, y lo documentado tiene que existir.
 * Las internas (las pasa el propio proceso a un hijo o a un script) no son
 * configuración del usuario y van en INTERNAL.
 */
const INTERNAL = new Set([
  'PA_CAPTURE', // screen/windows.ts → script de captura
  'PA_SIZE',
  'PA_CONTROL_LEAF', // windows-control-native.ts → proceso hijo
  'PA_CONTROL_MODE',
  'PA_CONTROL_STATE',
  'PA_FOREGROUND_PID',
  'PA_TTS_TEXT', // voice/tts.ts → proceso hijo
  'PA_TTS_WAV',
  'PA_SPK_FILE',
  'PA_EVOLVE_ATTEMPT', // evolve/run.ts → proponente
  'PA_EVOLVE_HYPOTHESIS',
  'PA_SECRET_TELEGRAM_BOTTOKEN', // nombre de secreto del almacén, no se configura aquí
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|mts|js)$/.test(name) ? [p] : [];
  });
}

function vars(text: string): Set<string> {
  // PA_X_ (acaba en _) es un prefijo dinámico (PA_SECRET_*, PA_DIAG_END_*), no una variable.
  return new Set([...text.matchAll(/\bPA_[A-Z0-9_]*[A-Z0-9]\b(?!_)/g)].map((m) => m[0]));
}

const root = join(import.meta.dirname, '..');
const used = new Set<string>();
for (const f of files(join(root, 'src')))
  for (const v of vars(readFileSync(f, 'utf8'))) used.add(v);
const documented = vars(readFileSync(join(root, '.env.example'), 'utf8'));

describe('.env.example', () => {
  it('documenta toda variable PA_* que lee el código', () => {
    const missing = [...used].filter((v) => !INTERNAL.has(v) && !documented.has(v)).sort();
    expect(missing, 'añade una línea comentada en su sección de .env.example').toEqual([]);
  });

  it('no documenta variables que el código ya no lee', () => {
    const stale = [...documented].filter((v) => !used.has(v)).sort();
    expect(stale).toEqual([]);
  });

  it('la lista de internas no tiene restos', () => {
    expect([...INTERNAL].filter((v) => !used.has(v))).toEqual([]);
  });
});
