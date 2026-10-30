/**
 * Vista «Funciones» del panel: las mismas áreas y comandos que /funciones en Telegram
 * (src/funciones.ts, sacados del catálogo de /help), en solo lectura. El panel es del
 * dueño (loopback + token), así que ve también los comandos solo-dueño.
 */
import { FUNCION_AREAS, funcionCommands, visibleAreas } from '../funciones.js';

export interface PanelFuncionComando {
  /** «/comando [args]», tal y como se escribe en Telegram. */
  comando: string;
  descripcion: string;
}

export interface PanelFuncionArea {
  id: string;
  titulo: string;
  resumen: string;
  ejemplo: string;
  comandos: PanelFuncionComando[];
}

export function panelFunciones(): PanelFuncionArea[] {
  const comandos = funcionCommands();
  const visibles = new Set(visibleAreas({ owner: true }).map((a) => a.id));
  return FUNCION_AREAS.filter((a) => visibles.has(a.id)).map((a) => ({
    id: a.id,
    titulo: a.title,
    resumen: a.summary,
    ejemplo: a.example,
    comandos: comandos
      .filter((c) => c.area === a.id)
      .map((c) => ({
        comando: `/${c.command}${c.args ? ` ${c.args}` : ''}`,
        descripcion: c.description,
      })),
  }));
}
