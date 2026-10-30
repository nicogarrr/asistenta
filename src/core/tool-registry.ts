import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Config } from '../config.js';
import { ThreadOutputs, threadContext } from '../daemon/thread-context.js';
import { computerPlugin } from '../plugins/computer.js';
import type { ActionGate, ScreenBackend } from '../tools/computer.js';
import { createAskTool, createDoneTool } from '../tools/done.js';
import { createFactoryTool } from '../tools/factory.js';
import { createFetchTool } from '../tools/fetch.js';
import { fsTools } from '../tools/fs.js';
import { createShellTool } from '../tools/shell.js';
import { createWebTool } from '../tools/web.js';
import { machineToolNames } from './capabilities.js';

/**
 * Registro de herramientas del núcleo (paso P0 del plan de cohesión).
 *
 * Antes, `pa chat` y `pa run` montaban cada uno su propia lista, copiada a mano, y el
 * daemon (`pa serve`) guardaba en un `Set` suelto dentro de cli.ts qué herramientas
 * mueven la máquina. Tres sitios que tenían que coincidir y nadie lo comprobaba.
 *
 * Este módulo es la única fuente de esas dos cosas. No cambia el comportamiento: la
 * lista y el orden son los de antes, y la puerta del computer use la sigue construyendo
 * quien llama, con su misma sesión, para que un lote de acciones vea las mismas
 * aprobaciones que la llamada de fuera.
 */

/**
 * Herramientas que mueven la máquina (ratón, teclado, ficheros, navegador, cobros,
 * audio). En el daemon solo estas pasan por el mutex de la máquina; las de solo
 * lectura van en paralelo entre conversaciones. Se deriva del catálogo
 * (`core/capabilities.ts`, campo `machine`).
 */
export const MACHINE_TOOLS: ReadonlySet<string> = new Set(machineToolNames());

export interface BaseToolDeps {
  config: Config;
  /** Pantalla para el computer use (WindowsScreen en el PC). */
  screen: ScreenBackend;
  /** Puerta del computer use, ya atada a la sesión del agente que la usa. */
  computerGate: ActionGate;
  /** La herramienta `delegate` (un pool por proceso: la construye cli.ts). */
  delegate: AgentTool;
  /** Aviso de cambios en las herramientas instaladas por la fábrica. */
  onFactoryChange: () => void;
}

/**
 * Lista base que comparten la consola (`pa chat`) y `pa run`: ficheros, fetch, web,
 * done/preguntar, fábrica, shell, delegate y computer use, en este orden.
 */
export function baseTools(deps: BaseToolDeps): AgentTool[] {
  return [
    ...fsTools,
    createFetchTool(),
    createWebTool(deps.config),
    createDoneTool(),
    createAskTool(),
    createFactoryTool({ onChange: deps.onFactoryChange }),
    createShellTool(deps.config),
    deps.delegate,
    // El mismo plugin que usa cada hilo del daemon, con un contexto sin hilo: sin
    // turno del panel ni canal, así que la tool es la de siempre (sin envío de capturas).
    ...computerPlugin.tools({
      config: deps.config,
      screen: deps.screen,
      ctx: threadContext({ key: 'local', outputs: new ThreadOutputs(), gate: deps.computerGate }),
    }),
  ] as AgentTool[];
}
