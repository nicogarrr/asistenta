/**
 * Arranque «profesional»: una sola línea en la consola cuando el daemon está
 * listo, y (si Nico lo activa) un mensaje «Asistenta lista ✅» a su chat privado.
 *
 * El aviso está ENCENDIDO por defecto (Nico, 30/10 14:57); PA_BOOT_NOTICE=0 lo
 * apaga. Un daemon que se reinicia en bucle no debe llenarle el móvil, así que va
 * limitado: como mucho
 * uno cada 10 minutos, recordado en `<estado>/boot-notice.json`, que se escribe
 * ANTES de enviar para que un envío que se cuelga o un fallo justo después no
 * deje la puerta abierta al siguiente arranque. Solo va al dueño, nunca a un grupo
 * ni al último chat. Probado en test/boot-notice.test.ts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const BOOT_NOTICE_MIN_INTERVAL_MS = 10 * 60_000;

/** Encendido salvo PA_BOOT_NOTICE=0/off/false/no. */
export function bootNoticeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|off|false|no)$/i.test(env.PA_BOOT_NOTICE?.trim() ?? '');
}

export interface BootFacts {
  /** Modelo principal (PA_MODEL). */
  model?: string;
  /** Tele emparejada (no se comprueba si responde: eso es `pa iniciar`). */
  tv: boolean;
  /** Control del PC activo (escritorio + PA_COMPUTER_USE). */
  computerUse: boolean;
  /** Correo configurado. */
  mail: boolean;
  /** Panel web, si está encendido. */
  panelUrl?: string;
  /** Hilos recuperados del arranque anterior. */
  threads?: number;
}

const yesNo = (on: boolean) => (on ? 'sí' : 'no');

/** Una línea para la consola, en vez de un chorro de logs para saber si arrancó. */
export function bootBanner(facts: BootFacts): string {
  const parts = [
    'Asistenta lista ✅',
    'Telegram conectado',
    facts.model ? `modelo ${facts.model}` : null,
    `tele ${yesNo(facts.tv)}`,
    `PC ${yesNo(facts.computerUse)}`,
    `correo ${yesNo(facts.mail)}`,
    facts.panelUrl ? `panel ${facts.panelUrl}` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.join(' · ');
}

/** El mensaje a Nico: corto, sin datos sensibles (ni URL con token ni ids). */
export function bootNoticeText(facts: BootFacts): string {
  const lines = [
    'Asistenta lista ✅',
    [
      facts.model ? `Modelo: ${facts.model}` : null,
      `Tele: ${yesNo(facts.tv)}`,
      `PC: ${yesNo(facts.computerUse)}`,
      `Correo: ${yesNo(facts.mail)}`,
    ]
      .filter(Boolean)
      .join(' · '),
  ];
  if (facts.threads) lines.push(`Recuperadas ${facts.threads} conversaciones.`);
  lines.push('Escribe /funciones para ver lo que sé hacer.');
  return lines.join('\n');
}

export type BootNoticeResult = 'sent' | 'off' | 'no-owner' | 'rate-limited' | 'failed';

export interface BootNoticeDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Ruta de `boot-notice.json` en el directorio de estado. */
  statePath: string;
  /** Id del dueño (su chat privado), o null si no se conoce. */
  ownerChatId: number | null;
  send: (chatId: string, text: string) => Promise<unknown>;
  facts: BootFacts;
}

function lastSentAt(path: string): number {
  try {
    const value = (JSON.parse(readFileSync(path, 'utf8')) as { lastSentAt?: unknown }).lastSentAt;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function recordSent(path: string, at: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ lastSentAt: at }));
  renameSync(tmp, path);
}

export async function maybeSendBootNotice(deps: BootNoticeDeps): Promise<BootNoticeResult> {
  if (!bootNoticeEnabled(deps.env)) return 'off';
  if (deps.ownerChatId == null) return 'no-owner';
  const now = (deps.now ?? Date.now)();
  const last = lastSentAt(deps.statePath);
  // Un reloj que ha ido hacia atrás (last en el futuro) también cuenta como reciente.
  if (now - last < BOOT_NOTICE_MIN_INTERVAL_MS) return 'rate-limited';
  try {
    recordSent(deps.statePath, now);
  } catch {
    // Sin poder recordar el envío no se manda: mejor un aviso de menos que un bucle.
    return 'failed';
  }
  try {
    await deps.send(String(deps.ownerChatId), bootNoticeText(deps.facts));
    return 'sent';
  } catch {
    return 'failed';
  }
}
