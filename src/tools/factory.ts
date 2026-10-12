/**
 * The tool factory (capability "fabrica de herramientas"): when the agent does
 * not know how to do something, it builds the tool, tests it in a subprocess,
 * and proposes it for installation. Installed tools are loaded as `fab_<id>`
 * on the next message and stay installed for good - the assistant grows with
 * use.
 *
 * The order is the whole safety story, same rule as skills ("learning must
 * never be a side effect") and stricter than any other action:
 *
 *   build -> test (subprocess, mandatory) -> install (human approval, ALWAYS
 *   ask: no session scope, no grant window, no memo - see permissions.ts).
 *
 * A tool whose code changed after the last passed test cannot be installed:
 * `testedSha256` must match the current code hash, so `improve` always
 * re-opens the test requirement.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { runFactoryToolSandboxed } from '../factory/runner.js';
import {
  listFactoryTools,
  readFactoryTool,
  sha256,
  writeFactoryMeta,
  writeFactoryTestLog,
  writeFactoryTool,
} from '../factory/store.js';
import { FACTORY_ID, type FactoryToolMeta, MAX_FACTORY_CODE_BYTES } from '../factory/types.js';
import { log } from '../log.js';

export const FACTORY_TOOL_NAME = 'fabrica';

const FactoryParams = Type.Object({
  action: Type.Union([
    Type.Literal('list'),
    Type.Literal('read'),
    Type.Literal('build'),
    Type.Literal('test'),
    Type.Literal('install'),
    Type.Literal('uninstall'),
    Type.Literal('improve'),
  ]),
  id: Type.Optional(
    Type.String({
      description:
        'Slug de la herramienta (read/test/install/uninstall/improve). En build: opcional; se deriva del nombre.',
    }),
  ),
  name: Type.Optional(Type.String({ description: 'build: nombre humano corto.' })),
  description: Type.Optional(Type.String({ description: 'build: una linea con lo que consigue.' })),
  whenToUse: Type.Optional(
    Type.String({
      description: 'build: la peticion que deberia dispararla, como la diria el usuario.',
    }),
  ),
  parameters: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        'build: JSON schema de objeto para los parametros ({ "type": "object", "properties": { ... } }).',
    }),
  ),
  code: Type.Optional(
    Type.String({
      description:
        'build/improve: modulo ESM completo con exports name, description, parameters y run(params).',
    }),
  ),
  sampleParams: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'test: parametros de ejemplo para ejecutar la herramienta una vez.',
    }),
  ),
  note: Type.Optional(
    Type.String({ description: 'improve: que cambio y por que (queda en las notas del TOOL.md).' }),
  ),
});

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'tool'
  );
}

function text(t: string): {
  content: { type: 'text'; text: string }[];
  details: Record<string, never>;
} {
  return { content: [{ type: 'text', text: t }], details: {} };
}

function requireFields(action: string, args: Record<string, unknown>, fields: string[]): void {
  for (const f of fields) {
    if (args[f] === undefined || args[f] === null || args[f] === '') {
      throw new Error(`fabrica ${action}: falta el campo "${f}"`);
    }
  }
}

function describe(m: FactoryToolMeta): string {
  return `${m.id} [${m.status}] v${m.version} - ${m.name}: ${m.description} (cuando: ${m.whenToUse}) testOk=${m.lastTestOk} updated=${m.updatedAt}`;
}

export function createFactoryTool(
  opts: { onChange?: () => void } = {},
): AgentTool<typeof FactoryParams> {
  return {
    name: FACTORY_TOOL_NAME,
    label: 'Fabrica de herramientas',
    description: [
      'Construye herramientas nuevas cuando no sepas hacer algo: build escribe el modulo,',
      'test lo ejecuta una vez en un subproceso aislado (obligatorio), install lo deja',
      'instalado para siempre tras aprobacion del usuario (siempre pregunta), uninstall lo retira.',
      'Las herramientas instaladas aparecen como fab_<id> en el siguiente mensaje.',
      'Flujo: build -> test -> install. Sin test superado del codigo actual no hay install.',
    ].join(' '),
    parameters: FactoryParams,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      switch (args.action) {
        case 'list': {
          const all = listFactoryTools();
          if (!all.length) return text('Fabrica vacia: ninguna herramienta construida todavia.');
          return text(all.map(describe).join('\n'));
        }
        case 'read': {
          requireFields('read', args, ['id']);
          const t = readFactoryTool(args.id as string);
          if (!t) throw new Error(`no existe la herramienta ${args.id}`);
          return text(`${describe(t.meta)}\n--- tool.js ---\n${t.code}`);
        }
        case 'build': {
          requireFields('build', args, ['name', 'description', 'whenToUse', 'parameters', 'code']);
          const id = args.id ?? slugify(args.name as string);
          if (!FACTORY_ID.test(id)) throw new Error(`id invalido: ${id}`);
          const code = args.code as string;
          if (Buffer.byteLength(code) > MAX_FACTORY_CODE_BYTES) {
            throw new Error(`el codigo supera el maximo de ${MAX_FACTORY_CODE_BYTES} bytes`);
          }
          const existing = readFactoryTool(id);
          if (existing && existing.meta.status === 'installed') {
            throw new Error(
              `${id} esta instalada: usa improve (nueva version + test + aprobacion)`,
            );
          }
          const now = new Date().toISOString();
          const meta: FactoryToolMeta = {
            id,
            name: args.name as string,
            description: args.description as string,
            whenToUse: args.whenToUse as string,
            version: (existing?.meta.version ?? 0) + 1,
            status: 'built',
            createdAt: existing?.meta.createdAt ?? now,
            updatedAt: now,
            codeSha256: sha256(code),
            testedSha256: null,
            lastTestAt: null,
            lastTestOk: false,
            contract: existing?.meta.contract ?? null,
          };
          writeFactoryTool(meta, code, existing?.notes ?? '');
          log.info('factory build', { id, version: meta.version });
          return text(
            `Construida ${id} v${meta.version} [built]. Siguiente paso: action "test" con sampleParams.` +
              (existing ? '' : ' Luego "install" (pedira aprobacion del usuario).'),
          );
        }
        case 'test': {
          requireFields('test', args, ['id']);
          const t = readFactoryTool(args.id as string);
          if (!t) throw new Error(`no existe la herramienta ${args.id}`);
          const result = await runFactoryToolSandboxed(args.id as string, args.sampleParams ?? {});
          const now = new Date().toISOString();
          // Bind the test to the artifact actually executed: re-read the file
          // AFTER the sandbox run and hash that, never a cached field.
          const after = readFactoryTool(args.id as string);
          const realHash = after ? sha256(after.code) : t.meta.codeSha256;
          const meta: FactoryToolMeta = {
            ...t.meta,
            status: result.ok ? 'tested' : t.meta.status === 'installed' ? 'installed' : 'built',
            updatedAt: now,
            testedSha256: result.ok ? realHash : t.meta.testedSha256,
            contract: result.ok ? (result.contract ?? t.meta.contract) : t.meta.contract,
            lastTestAt: now,
            lastTestOk: result.ok,
          };
          writeFactoryMeta(meta, t.notes);
          writeFactoryTestLog(
            args.id as string,
            [
              `# test ${now} stage=${result.stage} ok=${result.ok} ${result.durationMs}ms`,
              result.output,
              '',
            ].join('\n'),
          );
          log.info('factory test', { id: args.id, ok: result.ok, stage: result.stage });
          if (!result.ok) {
            return text(
              `TEST FALLIDO (${result.stage}): ${result.output}\nCorrige con action "improve" y repite el test.`,
            );
          }
          return text(
            `TEST OK (${result.durationMs}ms). Salida: ${result.output}\n` +
              `Ya puedes action "install": pedira aprobacion del usuario.`,
          );
        }
        case 'install': {
          requireFields('install', args, ['id']);
          const t = readFactoryTool(args.id as string);
          if (!t) throw new Error(`no existe la herramienta ${args.id}`);
          if (t.meta.status === 'installed')
            return text(`${args.id} ya estaba instalada (v${t.meta.version}).`);
          // Bind the approval to the real artifact: hash the code on disk NOW
          // and compare against the hash that passed the test, never against a
          // cached metadata field.
          const realHash = sha256(t.code);
          if (t.meta.status === 'disabled') {
            // Reinstall still requires a fresh passing test of the current code.
            if (t.meta.testedSha256 !== realHash || !t.meta.lastTestOk) {
              throw new Error(
                `${args.id} esta disabled y su codigo no tiene test vigente: action "test" primero`,
              );
            }
          } else if (t.meta.status !== 'tested' || t.meta.testedSha256 !== realHash) {
            throw new Error(
              `${args.id} no tiene un test superado del codigo actual: action "test" primero`,
            );
          }
          writeFactoryMeta(
            { ...t.meta, status: 'installed', updatedAt: new Date().toISOString() },
            t.notes,
          );
          opts.onChange?.();
          log.info('factory install', { id: args.id, version: t.meta.version });
          return text(
            `Instalada fab_${args.id} v${t.meta.version}. Disponible como herramienta en el proximo mensaje.`,
          );
        }
        case 'uninstall': {
          requireFields('uninstall', args, ['id']);
          const t = readFactoryTool(args.id as string);
          if (!t) throw new Error(`no existe la herramienta ${args.id}`);
          writeFactoryMeta(
            { ...t.meta, status: 'disabled', updatedAt: new Date().toISOString() },
            t.notes,
          );
          opts.onChange?.();
          log.info('factory uninstall', { id: args.id });
          return text(
            `Retirada ${args.id} (los ficheros quedan guardados y auditables; reinstall pide test + aprobacion otra vez).`,
          );
        }
        case 'improve': {
          requireFields('improve', args, ['id', 'code']);
          const t = readFactoryTool(args.id as string);
          if (!t) throw new Error(`no existe la herramienta ${args.id}`);
          const code = args.code as string;
          if (Buffer.byteLength(code) > MAX_FACTORY_CODE_BYTES) {
            throw new Error(`el codigo supera el maximo de ${MAX_FACTORY_CODE_BYTES} bytes`);
          }
          const note = `[v${t.meta.version + 1}] ${args.note ?? 'sin nota'} (${new Date().toISOString()})`;
          const notes = `${note}\n${t.notes}`.trim();
          writeFactoryTool(
            {
              ...t.meta,
              version: t.meta.version + 1,
              // Any code change invalidates the install: back to built, and
              // the tested hash no longer matches by construction.
              status: 'built',
              updatedAt: new Date().toISOString(),
              codeSha256: sha256(code),
            },
            code,
            notes,
          );
          opts.onChange?.();
          log.info('factory improve', { id: args.id, version: t.meta.version + 1 });
          return text(
            `Mejorada ${args.id} a v${t.meta.version + 1} [built]. Requiere action "test" y luego "install" (con aprobacion) para volver a estar activa.`,
          );
        }
        default:
          throw new Error(`accion desconocida: ${args.action}`);
      }
    },
  };
}
