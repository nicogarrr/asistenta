import type { AgentTool } from '@earendil-works/pi-agent-core';

/**
 * Una capacidad (Computer Use, tele, iPhone…) como plugin: un id y las tools que aporta
 * a partir de sus dependencias. Qué modos la usan, si es exclusiva de la máquina o
 * diferida no se repite aquí: lo dice el catálogo único (src/core/capabilities.ts).
 * Ver ARCHITECTURE.md §4.
 */
export interface CapabilityPlugin<Deps> {
  readonly id: string;
  // biome-ignore lint/suspicious/noExplicitAny: cada tool tiene su propio esquema de parámetros
  tools(deps: Deps): AgentTool<any>[];
}
