import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  type DeferredSpec,
  deferredSpecs,
  LOADER_TOOL_NAME,
  threadAllowToolNames,
} from './capabilities.js';

/**
 * Conditional tool loading (P8).
 *
 * Every tool definition is sent on every request. The browser and media tools alone are
 * about 1.7k tokens, and most chats ("¿qué tengo hoy?", "recuérdame...") never touch
 * them. They are kept out of the request until the message looks like it needs them, or
 * the model asks for them with `cargar_herramienta`.
 *
 * Safety nets, because a keyword list will miss things:
 * - the loader tool is always present while something is still deferred;
 * - once loaded, a tool stays loaded for the rest of the chat;
 * - the loader's description lists what each deferred tool is for.
 */
export type { DeferredSpec };

/** Derivado del catálogo de capacidades (core/capabilities.ts). */
export const DEFERRED_DEFAULTS: Record<string, DeferredSpec> = deferredSpecs();

const LoaderParams = Type.Object({
  nombre: Type.String({ description: 'Nombre de la herramienta a cargar.' }),
});

export { LOADER_TOOL_NAME };

/**
 * Tools every Telegram thread may call without asking. The loader is here because it
 * only changes which tools are listed; each call to browser/media still goes through
 * the gate on its own. Without it the safety net asks the user (or is denied when
 * nobody can approve) exactly when the keyword list missed.
 */
export const THREAD_ALLOW_TOOLS: string[] = threadAllowToolNames();

export class ToolLoadout {
  readonly #base: AgentTool[];
  readonly #deferred = new Map<string, { tool: AgentTool; spec: DeferredSpec }>();
  readonly #loaded = new Set<string>();
  readonly #extras = new Map<string, AgentTool>();
  #version = 0;

  constructor(
    tools: readonly AgentTool[],
    specs: Record<string, DeferredSpec> = DEFERRED_DEFAULTS,
  ) {
    this.#base = [];
    for (const t of tools) {
      const spec = specs[t.name];
      if (spec) this.#deferred.set(t.name, { tool: t, spec });
      else this.#base.push(t);
    }
  }

  /** Changes whenever the active set changes, so callers can tell cheaply. */
  get version(): number {
    return this.#version;
  }

  get loaded(): string[] {
    return [...this.#loaded];
  }

  /**
   * Late registration for factory-built tools: appended to the active set and
   * bumps the version, so the next turn's context carries them without
   * rebuilding the agent. Removal is by name and also bumps.
   */
  registerExtra(tool: AgentTool): void {
    if (
      this.#extras.has(tool.name) ||
      this.#base.some((t) => t.name === tool.name) ||
      this.#deferred.has(tool.name)
    )
      return;
    this.#extras.set(tool.name, tool);
    this.#version++;
  }

  unregisterExtra(name: string): void {
    if (this.#extras.delete(name)) this.#version++;
  }

  load(name: string): boolean {
    if (!this.#deferred.has(name)) return false;
    if (!this.#loaded.has(name)) {
      this.#loaded.add(name);
      this.#version++;
    }
    return true;
  }

  /** Load every deferred tool whose pattern matches the text. Returns what was added. */
  loadFor(text: string): string[] {
    const added: string[] = [];
    for (const [name, { spec }] of this.#deferred) {
      if (!this.#loaded.has(name) && spec.pattern.test(text)) {
        this.load(name);
        added.push(name);
      }
    }
    return added;
  }

  #loader(): AgentTool<typeof LoaderParams> {
    const pending = [...this.#deferred]
      .filter(([n]) => !this.#loaded.has(n))
      .map(([n, d]) => `${n} (${d.spec.purpose})`);
    return {
      name: LOADER_TOOL_NAME,
      label: 'Cargar herramienta',
      description: `Activa una herramienta que aún no está disponible: ${pending.join('; ')}. Úsala si la necesitas y no la ves; queda disponible en el siguiente paso.`,
      parameters: LoaderParams,
      executionMode: 'sequential',
      execute: async (_id, args) => {
        const name = args.nombre.trim().toLowerCase();
        const ok = this.load(name);
        const text = ok
          ? `Herramienta "${name}" cargada. Ya puedes usarla en el siguiente paso.`
          : `No existe la herramienta "${name}" para cargar. Disponibles: ${pending.join(', ') || 'ninguna'}.`;
        return { content: [{ type: 'text', text }], details: { loaded: ok, name } };
      },
    };
  }

  /** Tools to send now: base, plus loaded ones, plus the loader while any is pending. */
  active(): AgentTool[] {
    const loaded = [...this.#deferred].filter(([n]) => this.#loaded.has(n)).map(([, d]) => d.tool);
    const stillPending = this.#deferred.size > this.#loaded.size;
    return [
      ...this.#base,
      ...loaded,
      ...this.#extras.values(),
      ...(stillPending ? [this.#loader() as AgentTool] : []),
    ];
  }
}
