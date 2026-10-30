/**
 * Entorno para procesos hijos que no necesitan credenciales (ffmpeg, PowerShell de
 * voz, yt-dlp, arp, conversores, sidecars).
 *
 * Un hijo hereda por defecto TODO el entorno del daemon: el token del bot de
 * Telegram, las claves de los modelos, contraseñas de correo… Un programa externo
 * que falla, se actualiza mal o registra su entorno no tiene por qué llevárselos.
 * Se quitan solo las variables con nombre de credencial; PATH, SystemRoot, TEMP y
 * demás variables del sistema pasan intactas.
 */

/** Names that carry credentials (bot tokens, API keys, passwords), never system vars. */
export function isSecretEnvName(name: string): boolean {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE)/i.test(
    name,
  );
}

/** Copia de `base` sin credenciales, más las variables propias del hijo (`extra`). */
export function childEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!isSecretEnvName(name)) env[name] = value;
  }
  return { ...env, ...extra };
}
