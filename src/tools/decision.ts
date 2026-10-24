/**
 * The `decision` tool: record what the user settled, with provenance.
 *
 * `registrar` needs a literal quote from the user's CURRENT message; the ledger
 * checks it against the message the channel delivered (same thread, authorised
 * author) and refuses negations, doubts, questions and forwarded text. Passing
 * that guard shows provenance, it is not proof the user meant it: when in
 * doubt use `tentativa`, which never shows as resolved. A recorded decision is
 * context, never permission to act: gated actions keep their own approval.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { AuthenticInbound, DecisionLedger } from '../memory/decisions.js';
import type { WorkstreamStore } from '../memory/workstreams.js';

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('registrar'),
    Type.Literal('tentativa'),
    Type.Literal('retirar'),
    Type.Literal('listar'),
  ]),
  frente: Type.Optional(Type.String({ description: 'Workstream id (see action=listar).' })),
  resumen: Type.Optional(Type.String({ description: 'One short line: what was decided.' })),
  cita: Type.Optional(
    Type.String({
      description:
        'registrar: the exact words from the user message that say it, copied verbatim, a whole affirmative clause.',
    }),
  ),
  sustituye: Type.Optional(
    Type.String({ description: 'registrar: id of the decision this corrects.' }),
  ),
  id: Type.Optional(Type.String({ description: 'retirar: decision id.' })),
});

export interface DecisionToolDeps {
  ledger: DecisionLedger;
  workstreams: WorkstreamStore;
  scopeOf: () => string;
  inbound: () => AuthenticInbound | undefined;
}

const reply = (text: string, isError = false): AgentToolResult => ({
  content: [{ type: 'text', text }],
  details: {},
  isError,
});

export function createDecisionTool(deps: DecisionToolDeps): AgentTool<typeof Params> {
  return {
    name: 'decision',
    label: 'decision',
    description:
      'Record a decision the user made in an open workstream. registrar requires a verbatim quote from their current message; ' +
      'use tentativa when unsure. Never records anything as resolved from examples, questions, negations or forwarded text. ' +
      'A decision is context, not permission to execute or pay.',
    parameters: Params,
    execute: async (_id, args) => {
      const scope = deps.scopeOf();
      const mine = (frente: string | undefined) => {
        const w = frente ? deps.workstreams.read(frente) : null;
        return w && w.scope === scope ? w : null;
      };
      switch (args.action) {
        case 'listar': {
          const open = deps.workstreams.active(scope);
          if (!open.length) return reply('Sin frentes abiertos.');
          return reply(
            open
              .map((w) => {
                const ds = deps.ledger
                  .list(w.id)
                  .filter((d) => d.status === 'confirmed' || d.status === 'tentative')
                  .map((d) => {
                    const src =
                      d.status === 'confirmed'
                        ? ` | cita «${d.quote ?? ''}» | ${d.receivedAt ?? 'sin fecha'} | mensaje ${d.messageId || 'sin id'}`
                        : '';
                    const label =
                      d.status === 'confirmed'
                        ? 'dicha por el usuario, intención no verificada'
                        : 'tentativa';
                    return `  - ${d.id} [${label}] ${d.summary}${src}`;
                  });
                return [`${w.id}: ${w.title}`, ...ds].join('\n');
              })
              .join('\n'),
          );
        }
        case 'registrar': {
          const w = mine(args.frente);
          if (!w) return reply('Ese frente no existe en este chat.', true);
          const r = deps.ledger.recordConfirmed(
            w.id,
            args.resumen ?? '',
            args.cita ?? '',
            deps.inbound(),
            args.sustituye,
          );
          return r.ok
            ? reply(`Decisión registrada (${r.id}) con la cita del mensaje del usuario.`)
            : reply(`No registrada: ${r.reason}. Si dudas, usa action=tentativa.`, true);
        }
        case 'tentativa': {
          const w = mine(args.frente);
          if (!w) return reply('Ese frente no existe en este chat.', true);
          const r = deps.ledger.recordTentative(w.id, args.resumen ?? '');
          return r.ok
            ? reply(`Anotada como tentativa (${r.id}); no cuenta como resuelta.`)
            : reply(`No anotada: ${r.reason}`, true);
        }
        case 'retirar':
          return args.id && deps.ledger.retract(args.id, scope)
            ? reply('Decisión retirada.')
            : reply('No existe esa decisión en este chat.', true);
        default:
          return reply('Acción desconocida.', true);
      }
    },
  };
}
