/**
 * «actualizarme»: cuando el dueño pide «actualízate», Asistenta NO hace git pull / npm ci
 * con su propio shell. Mientras corre, Windows tiene bloqueados sus .node (sherpa,
 * onnxruntime) y `npm ci` se queda a medias: eso le pasó a Nico el 6 de noviembre.
 *
 * Esta herramienta lanza el mismo actualizador aparte que el botón «🔄 Buscar actualización
 * ahora» (`pa autoupdate boton`): espera a que acabe este turno, para Asistenta, se baja
 * main, `npm ci` + `npm run build`, la vuelve a arrancar por su tarea de inicio y avisa por
 * Telegram de cómo fue (o del motivo y de que volvió a la versión anterior).
 */
import { resolve } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { UPDATE_SEARCHING } from '../autoupdate-boton.js';
import { lazySchema, Type } from '../core/lazy-schema.js';

export const SELF_UPDATE_TOOL_NAME = 'actualizarme';

const Params = lazySchema(() => Type.Object({}));

export interface SelfUpdateDeps {
  /** Solo el chat privado del dueño. */
  allowed(): boolean;
  /** Lanza el actualizador aparte; devuelve lo que diría el botón. */
  start(): Promise<{ notice: string; reply?: string }>;
}

export const SELF_UPDATE_NOT_OWNER =
  'Solo me actualizo cuando me lo pide el dueño en su chat privado.';
export const SELF_UPDATE_STARTED =
  'Actualizador lanzado aparte. En cuanto acabe este turno me cierro, instalo la versión nueva y vuelvo a arrancar; el aviso de cómo fue llega solo a Telegram (si falla, vuelvo a la versión anterior). Dile al dueño que en un par de minutos vuelvo y no hagas nada más en este turno.';

export function createSelfUpdateTool(deps: SelfUpdateDeps): AgentTool<ReturnType<typeof Params>> {
  return {
    name: SELF_UPDATE_TOOL_NAME,
    label: 'Actualizarme',
    description: [
      'Update Asistenta herself to the latest version (origin/main) when the owner asks («actualízate», «ponte al día», «instala la versión nueva»).',
      'It starts a separate updater that waits for this turn to end, stops Asistenta, pulls, runs npm ci and the build, restarts her and reports on Telegram; on failure it rolls back.',
      'ALWAYS use this instead of running git pull, npm ci, npm install or npm run build with the shell in Asistenta’s own folder: while she runs, Windows locks her native files and the install breaks.',
    ].join(' '),
    parameters: Params(),
    executionMode: 'sequential',
    execute: async () => {
      if (!deps.allowed()) {
        return {
          content: [{ type: 'text', text: SELF_UPDATE_NOT_OWNER }],
          details: { started: false },
        };
      }
      const r = await deps.start();
      const started = r.notice === UPDATE_SEARCHING;
      const text = started ? SELF_UPDATE_STARTED : [r.notice, r.reply].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text }], details: { started } };
    },
  };
}

const SELF_INSTALL =
  /\bnpm(?:\.cmd)?\b[^;&|\r\n]*?\s(?:ci|install|i|run\s+build)(?=\s|$|[;&|])|\bgit\s+(?:pull|reset\s+--hard|clean)\b/i;
const CHANGES_DIR = /(?:^|[;&|]\s*)(?:cd|chdir|set-location|sl|pushd)\s+(\S+)/gi;

function samePath(a: string, b: string): boolean {
  const n = (p: string) =>
    resolve(p.replace(/^["']|["']$/g, ''))
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  return n(a) === n(b);
}

/**
 * Si el shell del modelo va a reinstalar o actualizar la propia Asistenta mientras corre,
 * devuelve por qué no y qué hacer; si no, null. Solo cuenta la carpeta de Asistenta: un
 * `npm install` en otro proyecto sigue igual.
 */
export function selfInstallBlock(command: string, cwd: string, repo: string): string | null {
  if (!SELF_INSTALL.test(command)) return null;
  const targets = [...command.matchAll(CHANGES_DIR)].map((m) => m[1] ?? '');
  const inRepo = targets.length
    ? targets.some((t) => samePath(resolve(cwd, t.replace(/^["']|["']$/g, '')), repo))
    : samePath(cwd, repo);
  if (!inRepo && !command.toLowerCase().includes(repo.toLowerCase())) return null;
  return 'No: eso reinstala la propia Asistenta mientras está en marcha, y Windows tiene bloqueados sus archivos nativos (la instalación se queda a medias). Usa la herramienta «actualizarme»: lo hace aparte, con Asistenta parada, y vuelve atrás si algo falla.';
}
