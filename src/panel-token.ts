/**
 * Token del panel web cuando no hay PA_WEB_TOKEN en .env (Nico, 31 oct: «actívalo
 * por defecto»). Se genera una vez al azar y se guarda en el directorio de estado,
 * solo legible por el usuario. Ese directorio ya está vetado a las herramientas del
 * agente (secretStatePaths), así que el modelo no lo puede leer. Nunca se registra en
 * el log; `pa panel` abre el navegador con él.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Un token guardado más corto que esto no vale: se crea otro. */
const MIN_STORED_TOKEN = 32;

export function panelTokenPath(stateDir: string): string {
  return join(stateDir, 'panel-token');
}

function readStored(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * El token guardado, o uno nuevo (32 bytes al azar, 43 caracteres) si no hay o no
 * vale. Lanza si no se puede leer ni escribir el directorio de estado.
 */
export function ensurePanelToken(stateDir: string): string {
  const file = panelTokenPath(stateDir);
  const stored = readStored(file);
  if (stored.length >= MIN_STORED_TOKEN) return stored;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  try {
    // 'wx' si no existía: si dos procesos lo crean a la vez, gana uno y el otro lo lee.
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: stored ? 'w' : 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const other = readStored(file);
    if (other.length >= MIN_STORED_TOKEN) return other;
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows no tiene modos POSIX: el fichero queda en el perfil del usuario.
  }
  return token;
}
