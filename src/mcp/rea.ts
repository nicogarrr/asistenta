/**
 * REA (https://github.com/morluto/rea, MIT, npm `rea-agents`): servidor MCP para
 * mirar apps por dentro. Encendido salvo PA_REA=0 (docs/rea.md):
 * `rea` global o `npx -y rea-agents mcp`; sin las claves del entorno; solo tools
 * de solo lectura; solo el dueño; cada llamada pide permiso (src/permissions.ts);
 * su salida cuenta como contenido de fuera, como toda tool MCP.
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { log } from '../log.js';
import type { McpServerConfig } from './client.js';

/** Nombre del servidor: sus tools se llaman `mcp_rea_<tool>`. Reservado mientras REA esté encendido. */
export const REA_SERVER_NAME = 'rea';
export const REA_TOOL_PREFIX = `mcp_${REA_SERVER_NAME}_`;

/** Lo único del entorno que ve REA: rutas, carpetas de usuario y temporales, idioma. */
// GHIDRA_INSTALL_DIR: dónde está Ghidra, si el dueño lo instaló (opcional).
export const REA_ENV_ALLOWLIST: readonly string[] = (
  'PATH PATHEXT HOME USERPROFILE HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA TEMP TMP TMPDIR ' +
  'SystemRoot SystemDrive windir ComSpec ProgramFiles ProgramFiles(x86) ProgramData LANG LC_ALL ' +
  'GHIDRA_INSTALL_DIR'
).split(' ');

/**
 * Modo de REA (decisión del dueño, 31 oct): encendido por defecto.
 * - `off`: PA_REA=0 (o no/false/off).
 * - `on`: PA_REA=1 (o sí/true/yes/on): usa `rea` global o, si no hay, `npx -y rea-agents`.
 * - `auto` (sin PA_REA): solo si hay un `rea` global; sin él no se descarga nada al
 *   arrancar y queda una línea clara en el registro.
 */
export function reaMode(env: NodeJS.ProcessEnv = process.env): 'off' | 'on' | 'auto' {
  const value = (env.PA_REA ?? '').trim().toLowerCase();
  if (['0', 'no', 'false', 'off'].includes(value)) return 'off';
  if (['1', 'sí', 'si', 'true', 'yes', 'on'].includes(value)) return 'on';
  return 'auto';
}

/** REA está encendido salvo PA_REA=0. */
export function reaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return reaMode(env) !== 'off';
}

export const REA_MISSING_LINE =
  'REA no está instalado, así que analizar apps queda apagado. Para usarlo: ' +
  'npm install --global rea-agents (o PA_REA=1 para que lo descargue solo con npx).';

/** ¿Hay un `rea` global en el PATH? (en Windows, `rea.cmd`). */
export function reaOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const pathValue = env.PATH ?? env.Path ?? '';
  const names = platform === 'win32' ? ['rea.cmd', 'rea.exe'] : ['rea'];
  const sep = platform === 'win32' ? ';' : delimiter;
  return pathValue
    .split(sep)
    .filter(Boolean)
    .some((dir) => names.some((name) => exists(join(dir, name))));
}

/**
 * Configuración de arranque de REA. En Windows `npx`/`rea` son `.cmd` y Node no
 * los lanza sin shell, así que van por `cmd.exe /d /s /c` con argumentos fijos.
 */
export function reaServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): McpServerConfig {
  const launch = reaOnPath(env, platform, exists)
    ? ['rea', 'mcp']
    : ['npx', '-y', 'rea-agents', 'mcp'];
  const [command, ...args] =
    platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', ...launch] : launch;
  return {
    name: REA_SERVER_NAME,
    command: command as string,
    args,
    envAllowlist: [...REA_ENV_ALLOWLIST, ...reaOwnVars(env)],
    readOnlyOnly: true,
    // La primera vez npx descarga REA: margen amplio para arrancar y analizar.
    timeoutMs: 120_000,
  };
}

/** Los ajustes propios de REA (REA_*) sí pasan: son suyos, no claves de Asistenta. */
function reaOwnVars(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => /^REA_[A-Z0-9_]+$/.test(key));
}

/**
 * Servidores MCP a arrancar: los de PA_MCP_SERVERS y REA (salvo PA_REA=0). Una
 * entrada de PA_MCP_SERVERS llamada «rea» se aparta para no saltarse estas reglas.
 * Sin `rea` global y sin PA_REA=1, REA no arranca (ni bloquea el arranque): avisa una vez.
 */
export function withRea(
  servers: McpServerConfig[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  notice: (line: string) => void = (line) => log.info(line),
): McpServerConfig[] {
  const mode = reaMode(env);
  if (mode === 'off') return servers;
  const others = servers.filter((s) => s.name !== REA_SERVER_NAME);
  if (mode === 'auto' && !reaOnPath(env, platform, exists)) {
    notice(REA_MISSING_LINE);
    return others;
  }
  return [...others, reaServerConfig(env, platform, exists)];
}

/** ¿Es una tool de REA? */
export function isReaTool(tool: string): boolean {
  return tool.startsWith(REA_TOOL_PREFIX);
}

/** Motivo de la pregunta: cada llamada a REA pide permiso, sin «Siempre». */
export function reaAskReason(tool: string): string | null {
  return isReaTool(tool) ? 'Analizar una app por dentro (REA) necesita tu permiso cada vez.' : null;
}

const REA_HINT =
  'Analiza cómo funciona una app, web o programa del dueño o público, solo lectura (entenderlo, ' +
  'depurarlo o revisar su seguridad). Úsalo cuando diga «mira cómo hace X esta app», ' +
  '«analiza esta web/app/programa» o «qué hace este .exe». ';
const REA_NOT_OWNER = 'Analizar apps por dentro solo lo puede pedir el dueño.';

/**
 * Las tools de REA llevan una pista en castellano para el modelo y solo
 * funcionan en el chat privado del dueño. Las demás tools pasan tal cual.
 */
export function guardReaTools(tools: AgentTool[], isOwner: () => boolean): AgentTool[] {
  return tools.map((tool): AgentTool => {
    if (!isReaTool(tool.name)) return tool;
    const inner = tool.execute.bind(tool);
    return {
      ...tool,
      description: `${REA_HINT}${tool.description}`,
      execute: async (toolCallId, args, ...rest) => {
        if (!isOwner()) {
          return { content: [{ type: 'text', text: REA_NOT_OWNER }], details: {}, isError: true };
        }
        return inner(toolCallId, args, ...rest);
      },
    };
  });
}
