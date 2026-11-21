/**
 * Empleo tech en España (spanish-top-tech-companies, MIT): sueldos por rol,
 * región y empresa, y ofertas abiertas. Todo de solo lectura.
 *
 * El servidor MCP va vendado en `vendor/tech-pay-spain` (código revisado antes
 * de integrarlo, con el commit anclado en THIRD_PARTY_NOTICES.md) y habla por
 * stdio con el mismo Node que ejecuta Asistenta, así no depende del `node` del
 * PATH. Los datos los lee en vivo de la web, sin claves ni telemetría (su
 * PostHog solo corre en su propio despliegue).
 *
 * Encendido salvo PA_EMPLEO=0. Solo se publican las tools de lectura
 * (`allowedTools` y `readOnlyOnly`): nunca `report_application` (cuenta
 * candidaturas a la web), `hiring_contact` (contactos de personas) ni
 * `application_guide` (instrucciones para el agente, no un dato) ni
 * `job_questions` (leería formularios externos en vivo, con el destino decidido
 * por el índice remoto: se deja fuera para no abrir esa salida de red). Las
 * candidaturas no se envían solas: aplicar a una oferta lo hace el dueño,
 * paso a paso y con su sí.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { log } from '../log.js';
import { REPO_DIR } from '../paths.js';
import type { McpServerConfig } from './client.js';

/** Nombre del servidor: sus tools se llaman `mcp_empleo_<tool>`. Reservado mientras esté encendido. */
export const EMPLEO_SERVER_NAME = 'empleo';
export const EMPLEO_TOOL_PREFIX = `mcp_${EMPLEO_SERVER_NAME}_`;

/**
 * Las únicas tools publicadas: consultas de solo lectura sobre datos públicos.
 */
export const EMPLEO_ALLOWED_TOOLS: readonly string[] = [
  'list_filters',
  'salary_stats',
  'top_companies',
  'company_salaries',
  'find_jobs',
];

/** Lo único del entorno que ve el servidor: rutas, carpetas de usuario y temporales, idioma. */
export const EMPLEO_ENV_ALLOWLIST: readonly string[] = (
  'PATH PATHEXT HOME USERPROFILE HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA TEMP TMP TMPDIR ' +
  'SystemRoot SystemDrive windir ComSpec ProgramFiles ProgramFiles(x86) ProgramData LANG LC_ALL'
).split(' ');

/** Encendido salvo PA_EMPLEO=0 (o no/false/off). */
export function empleoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.PA_EMPLEO ?? '').trim().toLowerCase();
  return !['0', 'no', 'false', 'off'].includes(value);
}

export const EMPLEO_MISSING_LINE =
  'El MCP de empleo no está en vendor/tech-pay-spain, así que buscar empleo y sueldos queda ' +
  'apagado. Vuelve a instalar o actualiza el repo.';

/** Ruta del script stdio vendado, resuelta desde la raíz del repo. */
export function empleoScriptPath(repoDir: string = REPO_DIR): string {
  return join(repoDir, 'vendor', 'tech-pay-spain', 'scripts', 'mcp-stdio.mjs');
}

/**
 * Configuración de arranque: el mismo Node que ejecuta Asistenta
 * (`process.execPath`), con el entorno mínimo, solo tools de lectura y un
 * reintento si el proceso cae.
 */
export function empleoServerConfig(
  execPath: string = process.execPath,
  repoDir: string = REPO_DIR,
): McpServerConfig {
  return {
    name: EMPLEO_SERVER_NAME,
    command: execPath,
    args: [empleoScriptPath(repoDir)],
    envAllowlist: [...EMPLEO_ENV_ALLOWLIST],
    allowedTools: [...EMPLEO_ALLOWED_TOOLS],
    readOnlyOnly: true,
    reconnect: true,
    // El arranque descarga data.json de la web: margen amplio.
    timeoutMs: 60_000,
  };
}

/**
 * Servidores MCP a arrancar: los de PA_MCP_SERVERS y el de empleo (salvo
 * PA_EMPLEO=0). Una entrada de PA_MCP_SERVERS llamada «empleo» se aparta para
 * no saltarse estas reglas. Si falta el vendor, no arranca (ni bloquea el
 * arranque): avisa una vez.
 */
export function withEmpleo(
  servers: McpServerConfig[],
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  notice: (line: string) => void = (line) => log.info(line),
  execPath: string = process.execPath,
  repoDir: string = REPO_DIR,
): McpServerConfig[] {
  if (!empleoEnabled(env)) return servers;
  const others = servers.filter((s) => s.name !== EMPLEO_SERVER_NAME);
  if (!exists(empleoScriptPath(repoDir))) {
    notice(EMPLEO_MISSING_LINE);
    return others;
  }
  return [...others, empleoServerConfig(execPath, repoDir)];
}

/** ¿Es una tool de empleo? */
export function isEmpleoTool(tool: string): boolean {
  return tool.startsWith(EMPLEO_TOOL_PREFIX);
}

const EMPLEO_HINT =
  'Empleo tech en España: ofertas abiertas (a diario) y sueldos por rol, región y empresa. ' +
  'Úsalo cuando el dueño pida buscar trabajo, comparar sueldos o ver qué paga una empresa. ' +
  'Solo lectura: no envía candidaturas; aplicar a una oferta lo hace el dueño, con su sí a cada paso. ';

/**
 * Las tools de empleo llevan una pista en castellano para el modelo. Las demás
 * tools pasan tal cual.
 */
export function guardEmpleoTools(tools: AgentTool[]): AgentTool[] {
  return tools.map((tool): AgentTool => {
    if (!isEmpleoTool(tool.name)) return tool;
    return { ...tool, description: `${EMPLEO_HINT}${tool.description}` };
  });
}
