import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Si Telegram está conectada, para quien mira desde fuera del daemon (`pa status --json`,
 * el icono de la bandeja). El daemon escribe `telegram.estado` en cada latido con
 * «1 <ms>» (conectada) o «0 <ms>» (sin conexión); un fichero viejo o raro no dice nada.
 */
export type TelegramEstado = 'conectada' | 'desconectada' | 'sin-dato';

export function writeTelegramEstado(stateDir: string, conectada: boolean, now = Date.now()): void {
  writeFileSync(join(stateDir, 'telegram.estado'), `${conectada ? 1 : 0} ${now}\n`);
}

export function readTelegramEstado(
  stateDir: string,
  now: number,
  staleAfterMs: number,
): TelegramEstado {
  let raw: string;
  try {
    raw = readFileSync(join(stateDir, 'telegram.estado'), 'utf8');
  } catch {
    return 'sin-dato';
  }
  const m = /^([01]) ([1-9]\d{0,15})\s*$/.exec(raw);
  if (!m) return 'sin-dato';
  const age = now - Number(m[2]);
  if (age < 0 || age >= staleAfterMs) return 'sin-dato';
  return m[1] === '1' ? 'conectada' : 'desconectada';
}

/** Escribe el estado ahora y cada `everyMs`; devuelve cómo pararlo. Nunca lanza. */
export function startTelegramEstado(
  stateDir: string,
  isReady: () => boolean,
  everyMs = 15_000,
): () => void {
  const tick = () => {
    try {
      writeTelegramEstado(stateDir, isReady());
    } catch {
      // Sin disco o sin permiso: la bandeja verá «sin dato», nunca un verde falso.
    }
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
