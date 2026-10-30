/**
 * Resumen de un fallo de PowerShell apto para el log.
 *
 * El error de execFile lleva la línea de órdenes entera (`cmd`, `message`): el script,
 * que puede incluir títulos de ventana, texto del usuario o rutas. Al log solo va el
 * código de salida, la señal y la primera línea de stderr con lo entrecomillado tapado.
 */
export function psErrorSummary(err: unknown): {
  code?: number | string;
  signal?: string;
  killed?: boolean;
  stderr?: string;
  message?: string;
} {
  const e = (err ?? {}) as { code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown };
  const out: ReturnType<typeof psErrorSummary> = {};
  if (typeof e.code === 'number' || typeof e.code === 'string') out.code = e.code;
  if (typeof e.signal === 'string') out.signal = e.signal;
  if (e.killed === true) out.killed = true;
  // Un Error que no viene de execFile (sin `cmd`) no lleva la línea de órdenes.
  if (err instanceof Error && !('cmd' in err) && out.code === undefined) {
    out.message = err.message.slice(0, 160);
  }
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line) {
    out.stderr = line.replace(/'[^']*'|"[^"]*"|«[^»]*»|‘[^’]*’|“[^”]*”/g, "'…'").slice(0, 160);
  }
  return out;
}
