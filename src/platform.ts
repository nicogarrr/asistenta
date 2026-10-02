/**
 * Modo escritorio.
 *
 * Las herramientas que controlan un PC Windows (pantalla, ventanas, OCR, volumen,
 * shell PowerShell, cámara, micrófono, voz SAPI) solo existen en Windows. En un
 * servidor Linux el daemon arranca igualmente con Telegram, el modelo, el
 * navegador headless, memoria, archivos, calendario y fetch.
 *
 * PA_DESKTOP=on|off fuerza el modo; por defecto está activo solo en Windows.
 */
export function desktopEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const forced = env.PA_DESKTOP?.trim().toLowerCase();
  if (forced === 'on' || forced === '1' || forced === 'true') return true;
  if (forced === 'off' || forced === '0' || forced === 'false') return false;
  return platform === 'win32';
}

/** Nombres de las herramientas que requieren el escritorio Windows. */
export const DESKTOP_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'computer',
  'windows',
  'ocr',
  'system',
  'shell',
  'media',
]);

export const DESKTOP_OFF_MESSAGE =
  'Esta función no está disponible: el asistente corre en modo servidor, sin escritorio.';
