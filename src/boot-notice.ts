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
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileReplacing } from './fs-tmp.js';
import { ago } from './startup-record.js';

/** Estado del aviso en el directorio de estado (registrado en src/state-files.ts). */
export const BOOT_NOTICE_FILE = 'boot-notice.json';
export const BOOT_NOTICE_MIN_INTERVAL_MS = 10 * 60_000;
/** Un último envío fechado más allá de esto en el futuro se ignora (reloj corregido). */
export const BOOT_NOTICE_FUTURE_IGNORED_MS = 60 * 60_000;

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

function readState(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Escribe `boot-notice.json` conservando los demás campos (lastSentAt y lastResult conviven). */
function writeState(path: string, patch: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileReplacing(path, JSON.stringify({ ...readState(path), ...patch }));
}

function recordSent(path: string, at: number): void {
  writeState(path, { lastSentAt: at });
}

const RESULTS: readonly BootNoticeResult[] = ['sent', 'off', 'no-owner', 'rate-limited', 'failed'];

export interface BootNoticeRecord {
  result: BootNoticeResult;
  /** ISO de cuándo se decidió. */
  at: string;
}

/** Último resultado del aviso de arranque, para `pa autostart status`. Nunca lanza. */
export function readBootNoticeResult(path: string): BootNoticeRecord | undefined {
  const state = readState(path);
  const result = state.lastResult;
  const at = state.lastResultAt;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return undefined;
  if (!RESULTS.includes(result as BootNoticeResult)) return undefined;
  return { result: result as BootNoticeResult, at };
}

function rememberResult(path: string, result: BootNoticeResult, now: number): BootNoticeResult {
  try {
    writeState(path, { lastResult: result, lastResultAt: new Date(now).toISOString() });
  } catch {
    // Solo es un diagnóstico para `pa autostart status`.
  }
  return result;
}

const RESULT_TEXT: Record<BootNoticeResult, string> = {
  sent: 'enviado a tu chat privado ✅',
  off: 'apagado (PA_BOOT_NOTICE=0)',
  'no-owner':
    '❌ no enviado: no sé cuál es tu chat privado. Mira «pa iniciar --solo-comprobar» (línea «Dueño»)',
  'rate-limited': 'no enviado: ya se había mandado hace menos de 10 min',
  failed: '❌ falló al enviarlo por Telegram. Mira el log del daemon',
};

/** Una línea para `pa autostart status`. */
export function formatBootNoticeResult(
  rec: BootNoticeRecord | undefined,
  now: Date = new Date(),
): string {
  const head = 'Aviso «Asistenta lista ✅» del último arranque';
  if (!rec) return `${head}: ninguno registrado todavía.`;
  return `${head}, ${ago(rec.at, now)}: ${RESULT_TEXT[rec.result]}.`;
}

export async function maybeSendBootNotice(deps: BootNoticeDeps): Promise<BootNoticeResult> {
  const now = (deps.now ?? Date.now)();
  const result = await decideAndSend(deps, now);
  return rememberResult(deps.statePath, result, now);
}

async function decideAndSend(deps: BootNoticeDeps, now: number): Promise<BootNoticeResult> {
  if (!bootNoticeEnabled(deps.env)) return 'off';
  if (deps.ownerChatId == null) return 'no-owner';
  const last = lastSentAt(deps.statePath);
  // Un reloj que ha ido un poco hacia atrás (last en el futuro) también cuenta como
  // reciente. Pero un envío fechado más de 1 h por delante (hora corregida, reloj
  // adelantado, arranque dual) no es un envío reciente: sin esto no volvía a avisar
  // hasta que el reloj alcanzara esa fecha. Al mandar se guarda `now`, así que un
  // bucle de reinicios sigue frenado desde el primer aviso.
  const future = last - now > BOOT_NOTICE_FUTURE_IGNORED_MS;
  if (!future && now - last < BOOT_NOTICE_MIN_INTERVAL_MS) return 'rate-limited';
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
