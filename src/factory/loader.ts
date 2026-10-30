/**
 * Loads installed factory tools into the live toolset. Every call site builds
 * its tool array when a message starts, so a tool installed (with approval)
 * during one message is simply there on the next - no restart, no hot-swap
 * machinery.
 *
 * Two hard rules, audited:
 *  - The daemon NEVER imports guest code. The tool wrapper executes the module
 *    through the same sandboxed runner used for the pre-install test (vm with
 *    no capabilities + --permission + empty env + timeout + output cap +
 *    process-group kill). A hung or crashing tool returns isError; the daemon
 *    keeps running.
 *  - Load is bound to the approved artifact: the tool.js on disk is re-hashed
 *    and must equal testedSha256 (the hash the approval covered), with
 *    lastTestOk. Any drift - tampering, hand edits, a test that rewrote the
 *    file - and the tool is skipped with an error log.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import { runFactoryToolSandboxed } from './runner.js';
import { listFactoryTools, readFactoryTool, sha256 } from './store.js';

export const FACTORY_TOOL_PREFIX = 'fab_';

/** Wall clock for one post-install call. */
export const FACTORY_RUNTIME_TIMEOUT_MS = 30_000;

export async function loadInstalledFactoryTools(
  opts: { timeoutMs?: number } = {},
): Promise<AgentTool[]> {
  const timeoutMs = opts.timeoutMs ?? FACTORY_RUNTIME_TIMEOUT_MS;
  const tools: AgentTool[] = [];
  for (const meta of listFactoryTools()) {
    if (meta.status !== 'installed') continue;
    try {
      const current = readFactoryTool(meta.id);
      if (!current) continue;
      const realHash = sha256(current.code);
      if (!meta.lastTestOk || !meta.testedSha256 || realHash !== meta.testedSha256) {
        log.error('factory tool con codigo que no es el aprobado (hash mismatch), omitida', {
          id: meta.id,
        });
        continue;
      }
      const contract = meta.contract;
      if (!contract) {
        log.error('factory tool sin contrato registrado (test anterior al contrato?), omitida', {
          id: meta.id,
        });
        continue;
      }
      tools.push({
        name: `${FACTORY_TOOL_PREFIX}${meta.id}`,
        label: meta.name,
        description: [
          contract.description,
          `Cuando usarla: ${meta.whenToUse || contract.description}`,
          '(Construida por la fabrica y aprobada por el usuario.)',
        ].join(' '),
        parameters: Type.Unsafe<Record<string, unknown>>(contract.parameters),
        execute: async (_id, args) => {
          // The wrapper outlives the load (it stays registered across
          // messages), so the approval is re-checked on every call: a tool.js
          // edited, or a tool uninstalled, after the load must not run.
          const refused = notApprovedNow(meta.id, realHash);
          if (refused) {
            log.error('factory tool rechazada al ejecutar', { id: meta.id, reason: refused });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No ejecuto ${meta.id}: ${refused}. Hay que volver a probarla y aprobarla.`,
                },
              ],
              details: { factory: meta.id, version: meta.version },
              isError: true,
            };
          }
          const result = await runFactoryToolSandboxed(meta.id, args, { timeoutMs });
          if (result.ok) {
            return {
              content: [{ type: 'text' as const, text: result.output.slice(0, 20_000) }],
              details: { factory: meta.id, version: meta.version },
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error en ${meta.id} (${result.stage}): ${result.output}`.slice(0, 4000),
              },
            ],
            details: { factory: meta.id, version: meta.version },
            isError: true,
          };
        },
      });
    } catch (err) {
      log.error('factory tool no cargada', { id: meta.id, err: String(err) });
    }
  }
  return tools;
}

/** Null when the tool on disk is still the installed, approved artifact; else the reason (Spanish). */
function notApprovedNow(id: string, approvedSha: string): string | null {
  try {
    const t = readFactoryTool(id);
    if (!t) return 'ya no existe';
    if (t.meta.status !== 'installed') return 'ya no está instalada';
    if (
      !t.meta.lastTestOk ||
      t.meta.testedSha256 !== approvedSha ||
      sha256(t.code) !== approvedSha
    ) {
      return 'su código ya no es el aprobado';
    }
    return null;
  } catch {
    return 'su TOOL.md no se puede leer';
  }
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
