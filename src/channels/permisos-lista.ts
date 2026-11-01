import type { AlwaysGrantDated, AlwaysGrantWithChat } from '../permissions.js';
import { listAlwaysGrantsDated } from '../permissions.js';

/** Lo mínimo de un gate vivo que hace falta para listar (sus «Siempre» en memoria). */
export interface PermisosListaGate {
  listPersistedAlwaysWithChat(): AlwaysGrantWithChat[];
}

/** Tope de líneas: la respuesta tiene que caber en un mensaje de Telegram. */
const MAX_LINES = 40;

function chatLabel(chat: string, currentChat: string | undefined): string {
  if (currentChat !== undefined && chat === currentChat) return 'este chat';
  if (chat === 'local') return 'consola local';
  return `chat ${chat}`;
}

function dateLabel(since: number | null): string {
  if (since === null) return 'fecha desconocida';
  return `desde ${new Date(since).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })}`;
}

/**
 * `/permisos lista`: un «Siempre» por línea con herramienta, dónde vale y desde
 * cuándo. Solo lectura: no lleva botones ni concede nada, y nunca muestra los
 * argumentos guardados, rutas ni secretos (solo el nombre de la herramienta).
 * Quitar uno sigue siendo escribir /permisos revocar.
 */
export function formatPermisosLista(
  rows: readonly AlwaysGrantDated[],
  currentChat?: string,
): string {
  if (rows.length === 0) return 'No me has dado ningún permiso «siempre».';
  const sorted = [...rows].sort(
    (a, b) =>
      a.tool.localeCompare(b.tool) ||
      Number(b.chat === currentChat) - Number(a.chat === currentChat) ||
      a.chat.localeCompare(b.chat),
  );
  const lines = sorted
    .slice(0, MAX_LINES)
    .map((r) => `• ${r.tool} — ${chatLabel(r.chat, currentChat)} — ${dateLabel(r.since)}`);
  if (sorted.length > MAX_LINES) lines.push(`… y ${sorted.length - MAX_LINES} más.`);
  return [
    `Permisos «siempre» (${rows.length}):`,
    ...lines,
    `Para quitar uno, dime cuál, por ejemplo /permisos revocar ${sorted[0]?.tool ?? 'shell'} (o añade «este chat» para quitarlo solo aquí).`,
  ].join('\n');
}

/** Junta los de la base y los que algún gate vivo tiene solo en memoria (sin fecha). */
export function permisosListaReply(
  gates: readonly PermisosListaGate[],
  dbPath: string | undefined,
  currentChat?: string,
): string {
  const rows = new Map<string, AlwaysGrantDated>();
  for (const row of listAlwaysGrantsDated(dbPath)) rows.set(`${row.tool}\u0000${row.chat}`, row);
  for (const gate of gates) {
    for (const row of gate.listPersistedAlwaysWithChat()) {
      const key = `${row.tool}\u0000${row.chat}`;
      if (!rows.has(key)) rows.set(key, { tool: row.tool, chat: row.chat, since: null });
    }
  }
  return formatPermisosLista([...rows.values()], currentChat);
}
