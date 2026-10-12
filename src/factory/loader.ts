/**
 * Loads installed factory tools into the live toolset. Every call site builds
 * its tool array when a message starts, so a tool installed (with approval)
 * during one message is simply there on the next - no restart, no hot-swap
 * machinery.
 *
 * One bad tool must never break the daemon: a directory that fails to read,
 * import or validate is logged and skipped.
 */
import { pathToFileURL } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import { factoryDir, listFactoryTools, readFactoryTool } from './store.js';

export const FACTORY_TOOL_PREFIX = 'fab_';

interface FactoryModule {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (params: unknown) => Promise<unknown>;
}

function isFactoryModule(mod: unknown): mod is FactoryModule {
  const m = mod as Partial<FactoryModule>;
  return (
    !!m &&
    typeof m.name === 'string' &&
    !!m.name &&
    typeof m.description === 'string' &&
    !!m.parameters &&
    typeof m.parameters === 'object' &&
    typeof m.run === 'function'
  );
}

export async function loadInstalledFactoryTools(): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  for (const meta of listFactoryTools()) {
    if (meta.status !== 'installed') continue;
    try {
      const current = readFactoryTool(meta.id);
      if (!current) continue;
      // Cache-bust on the code hash so `improve` + reinstall picks the new
      // module instead of the cached import of the previous version.
      const url = `${pathToFileURL(`${factoryDir(meta.id)}/tool.js`).href}?v=${meta.codeSha256.slice(0, 12)}`;
      const mod: unknown = await import(url);
      if (!isFactoryModule(mod)) {
        log.error('factory tool con contrato invalido, omitida', { id: meta.id });
        continue;
      }
      const run = mod.run;
      tools.push({
        name: `${FACTORY_TOOL_PREFIX}${meta.id}`,
        label: meta.name,
        description: [
          mod.description,
          `Cuando usarla: ${meta.whenToUse || meta.description}`,
          '(Construida por la fabrica y aprobada por el usuario.)',
        ].join(' '),
        parameters: Type.Unsafe<Record<string, unknown>>(mod.parameters),
        execute: async (_id, args) => {
          try {
            const result = await run(args);
            const text =
              typeof result === 'string'
                ? result
                : result && typeof (result as { text?: unknown }).text === 'string'
                  ? (result as { text: string }).text
                  : JSON.stringify(result);
            return {
              content: [{ type: 'text' as const, text: String(text).slice(0, 20_000) }],
              details: { factory: meta.id, version: meta.version },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [
                { type: 'text' as const, text: `Error en ${meta.id}: ${msg}`.slice(0, 4000) },
              ],
              details: { factory: meta.id, version: meta.version },
              isError: true,
            };
          }
        },
      });
    } catch (err) {
      log.error('factory tool no cargada', { id: meta.id, err: String(err) });
    }
  }
  return tools;
}

/**
 * Keeps one agent's live toolset in sync with the installed factory set:
 * registers new installs, retracts uninstalls, idempotent both ways. Called
 * once after agent creation (initial load) and after every fabrica mutation.
 */
export function createFactorySync(
  register: (tool: AgentTool) => void,
  unregister: (name: string) => void,
): () => Promise<void> {
  const registered = new Set<string>();
  return async function syncFactoryTools() {
    const installed = await loadInstalledFactoryTools();
    const want = new Set(installed.map((t) => t.name));
    for (const t of installed) {
      if (!registered.has(t.name)) {
        register(t);
        registered.add(t.name);
      }
    }
    for (const name of [...registered]) {
      if (!want.has(name)) {
        unregister(name);
        registered.delete(name);
      }
    }
  };
}
