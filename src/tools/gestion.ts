/**
 * The `gestion` tool: "hazme X en esta web/programa" for ANY site or program
 * (capability 3, GESTOR UNIVERSAL). preparar shows the plan - every step with
 * its effect class next to it, one Telegram-legible piece - and waits;
 * ejecutar starts the work, only ever through the Gate, which hardcodes
 * `gestion:ejecutar` as always-ask, the same treatment as activating a goal.
 * The errand then runs live in this chat with the ordinary tools: paso marks
 * each approved step done and completar closes it. While it is active, the
 * Gate re-asks about any call whose effect exceeds the class approved for the
 * current step (see effectOverrideReason in gestor/store.ts).
 *
 * The scope comes from the caller, never from the model: a gestión belongs to
 * the chat that asked for it and cannot be touched from another.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { EFFECT_CLASSES, EFFECT_LABEL, type EffectClass } from '../gestor/effects.js';
import type { Gestion, GestionStep, GestorStore } from '../gestor/store.js';

/**
 * Telegram's per-message ceiling is 4096 chars and the channel splits anything
 * longer into 4000-char chunks. The plan Nico approves must stay ONE piece, so
 * the whole message is budgeted before anything is stored: over budget is an
 * honest error, never a silently truncated plan.
 */
export const MAX_GESTION_CHARS = 3900;

const EFFECT_DESCRIPTION =
  'Effect class of the step: lee (read-only) | escribe-local (writes on this PC) | envia-terceros (sends/publishes/books something with third parties) | paga (spends money or credits) | destructivo (deletes or destroys). Declare the WORST thing the step may do.';

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('preparar'),
    Type.Literal('ejecutar'),
    Type.Literal('paso'),
    Type.Literal('completar'),
    Type.Literal('cancelar'),
    Type.Literal('listar'),
    Type.Literal('estado'),
  ]),
  id: Type.Optional(
    Type.String({
      description:
        'Gestion id (from preparar/listar). Optional for paso/completar/cancelar/estado: the active gestion of this chat.',
    }),
  ),
  titulo: Type.Optional(Type.String({ description: 'preparar: short title, in Spanish.' })),
  encargo: Type.Optional(Type.String({ description: "preparar: the user's request, verbatim." })),
  pasos: Type.Optional(
    Type.Array(
      Type.Object({
        texto: Type.String({ description: 'The step, in Spanish.' }),
        efecto: Type.String({ description: EFFECT_DESCRIPTION }),
      }),
      { description: 'preparar: the plan, one step per entry, in order.' },
    ),
  ),
  paso: Type.Optional(Type.Number({ description: 'paso: 1-based step number completed.' })),
  nota: Type.Optional(
    Type.String({ description: 'paso: one line on what happened in that step.' }),
  ),
});

function reply(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

/** The plan Nico approves: Spanish, one piece, every step with its effect class. */
export function formatProposal(g: Gestion): string {
  const steps = g.plan.map((s, i) => `${i + 1}. [${EFFECT_LABEL[s.effect]}] ${s.text}`).join('\n');
  return [
    `📋 Gestión propuesta: "${g.title}"`,
    '',
    `Lo que pediste: ${g.encargo}`,
    '',
    'Plan (cada paso con su clase de efecto):',
    steps,
    '',
    'Mientras la ejecute, si algo supera la clase aprobada de su paso - enviar a terceros, pagar o destruir - te pregunto sí o sí. Credenciales siempre por el vault, nunca por aquí.',
    '',
    `Para ejecutarla responde "sí". Para cambiar algo, dime qué. (id: ${g.id})`,
  ].join('\n');
}

const STATUS_LABEL: Record<Gestion['status'], string> = {
  proposed: 'propuesta (esperando tu sí)',
  active: 'activa',
  done: 'terminada',
  cancelled: 'cancelada',
};

function oneLine(g: Gestion): string {
  const done = g.plan.filter((s) => s.done).length;
  return `- "${g.title}" [${STATUS_LABEL[g.status]}] ${done}/${g.plan.length} pasos (id: ${g.id})`;
}

export interface GestionToolDeps {
  gestor: GestorStore;
  scopeOf: () => string;
}

export function createGestionTool(deps: GestionToolDeps): AgentTool<typeof Params> {
  /** Reads the gestion and pins it to the calling chat: no cross-chat reach. */
  const mine = (id: string): Gestion | AgentToolResult => {
    const gestion = deps.gestor.read(id);
    if (!gestion) return reply(`No existe la gestión ${id}.`, true);
    if (gestion.scope !== deps.scopeOf()) {
      return reply('Esa gestión pertenece a otro chat; aquí no puedes tocarla.', true);
    }
    return gestion;
  };

  /** The target of the actions that default to "the active one in this chat". */
  const target = (id: string | undefined): Gestion | AgentToolResult => {
    if (id) return mine(id);
    const active = deps.gestor.activeForScope(deps.scopeOf());
    if (!active) {
      return reply(
        'No hay ninguna gestión activa en este chat; indica el id (lo ves con action=listar).',
        true,
      );
    }
    return active;
  };

  return {
    name: 'gestion',
    label: 'Gestión',
    description: [
      'Universal errand runner: the user asks "hazme X en esta web/programa" and you run it live in this chat.',
      'preparar: build the plan and show it, each step with its effect class (lee / escribe-local / envia-terceros / paga / destructivo). Nothing runs until the user says yes.',
      'ejecutar: start the approved errand - ONLY after the user said an explicit yes to the plan just shown; the gate still asks them.',
      'Then work the steps with the normal tools, calling paso as each one completes, and completar at the end.',
      'Never claim an errand is active unless ejecutar said so.',
    ].join('\n'),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const scope = deps.scopeOf();

      if (args.action === 'preparar') {
        if (!args.titulo?.trim() || !args.encargo?.trim()) {
          return reply('preparar necesita titulo y encargo (las palabras del usuario).', true);
        }
        const pasos = (args.pasos ?? [])
          .map((p) => ({ texto: p.texto.trim(), efecto: p.efecto.trim() }))
          .filter((p) => p.texto);
        if (pasos.length === 0) {
          return reply('preparar necesita al menos un paso en el plan.', true);
        }
        const badEffect = pasos.findIndex((p) => !EFFECT_CLASSES.includes(p.efecto as EffectClass));
        if (badEffect !== -1) {
          return reply(
            `El paso ${badEffect + 1} tiene una clase de efecto desconocida ("${pasos[badEffect]?.efecto}"): usa ${EFFECT_CLASSES.join(', ')}.`,
            true,
          );
        }
        // NEVER truncate: slicing the request would silently drop Nico's own
        // conditions ("...NO ENVIAR EL FORMULARIO" at char 1001). Over a limit
        // the answer is an honest rejection and nothing is stored.
        const title = args.titulo.trim();
        if (title.length > 120) {
          return reply(`El título no puede pasar de 120 caracteres (tiene ${title.length}).`, true);
        }
        const encargo = args.encargo.trim();
        if (encargo.length > 1000) {
          return reply(
            `El encargo no puede pasar de 1000 caracteres (tiene ${encargo.length}): resúmelo tú - no lo recorto yo, no voy a quitarte condiciones.`,
            true,
          );
        }
        if (pasos.length > 20) {
          return reply(
            `El plan no puede tener más de 20 pasos (tiene ${pasos.length}): agrúpalos y proponlo de nuevo.`,
            true,
          );
        }
        const tooLong = pasos.findIndex((p) => p.texto.length > 200);
        if (tooLong !== -1) {
          return reply(
            `El paso ${tooLong + 1} no puede pasar de 200 caracteres (tiene ${pasos[tooLong]?.texto.length ?? 0}): resúmelo y proponlo de nuevo.`,
            true,
          );
        }
        const plan: GestionStep[] = pasos.map((p) => ({
          text: p.texto,
          effect: p.efecto as EffectClass,
          done: false,
        }));
        // Budget the exact message Nico would approve. The probe id is the
        // same length as a real one (36), so the check sees the true size.
        const probe = formatProposal({
          id: '0'.repeat(36),
          scope: '',
          title,
          encargo,
          plan,
          status: 'proposed',
          currentStep: 0,
          ledger: [],
          createdAt: '',
          updatedAt: '',
        });
        if (probe.length > MAX_GESTION_CHARS) {
          return reply(
            `El plan no cabe en un solo mensaje (${probe.length} caracteres, máximo ${MAX_GESTION_CHARS}): resume los pasos o acorta el encargo y proponlo de nuevo. Nada quedó guardado.`,
            true,
          );
        }
        const gestion = deps.gestor.propose({ scope, title, encargo, plan });
        return reply(formatProposal(gestion));
      }

      if (args.action === 'listar') {
        const rows = deps.gestor
          .list(scope)
          .filter((g) => g.status !== 'done' && g.status !== 'cancelled');
        if (rows.length === 0) return reply('No hay gestiones en marcha ni propuestas.');
        return reply(['Gestiones:', ...rows.map(oneLine)].join('\n'));
      }

      const gestionOrErr = target(args.id);
      if (!('plan' in gestionOrErr)) return gestionOrErr;
      const gestion = gestionOrErr;

      switch (args.action) {
        case 'estado': {
          const steps = gestion.plan
            .map(
              (s, i) =>
                `  ${i + 1}. [${s.done ? 'x' : ' '}] [${EFFECT_LABEL[s.effect]}] ${s.text}${s.note ? ` — ${s.note}` : ''}`,
            )
            .join('\n');
          const ledger = gestion.ledger
            .slice(-5)
            .map((e) => `  paso ${e.step}: ${e.note || '(sin nota)'}`)
            .join('\n');
          return reply(
            [
              `📋 "${gestion.title}" [${STATUS_LABEL[gestion.status]}]`,
              `Lo que pediste: ${gestion.encargo}`,
              'Plan:',
              steps,
              ledger ? `Últimos avances:\n${ledger}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }
        case 'ejecutar': {
          // The Gate already collected Nico's yes (gestion:ejecutar is
          // always-ask); start() re-checks status and the one-active-per-chat
          // cap, and only then does the work begin.
          try {
            deps.gestor.start(gestion.id);
          } catch (err) {
            return reply(err instanceof Error ? err.message : String(err), true);
          }
          const first = gestion.plan[0];
          return reply(
            [
              `Gestión "${gestion.title}" activa.`,
              `Ejecuta ahora el paso 1 con las herramientas normales: ${first?.text ?? ''}`,
              'Marca cada paso con gestion:paso al completarlo y cierra con gestion:completar. Si algo real supera la clase aprobada de su paso, para y explícaselo al usuario: la aprobación cubre el plan, no lo que se salga de él.',
            ].join('\n'),
          );
        }
        case 'paso': {
          const idx = (args.paso ?? 0) - 1;
          try {
            deps.gestor.recordStep(gestion.id, idx, args.nota?.slice(0, 200) ?? '');
          } catch (err) {
            return reply(err instanceof Error ? err.message : String(err), true);
          }
          const after = deps.gestor.read(gestion.id);
          const next = after?.plan.find((s) => !s.done);
          return reply(
            next
              ? `Paso ${idx + 1} de "${gestion.title}" marcado como hecho. Sigue el paso ${(after?.plan.indexOf(next) ?? 0) + 1}: ${next.text}`
              : `Paso ${idx + 1} de "${gestion.title}" marcado como hecho. Plan completado: cierra con gestion:completar.`,
          );
        }
        case 'completar': {
          const pending = gestion.plan.map((s, i) => ({ s, i })).filter(({ s }) => !s.done);
          if (pending.length > 0) {
            return reply(
              `Aún quedan pasos sin hacer (${pending.map(({ i }) => i + 1).join(', ')}). Márcalos con gestion:paso o cancela la gestión.`,
              true,
            );
          }
          try {
            deps.gestor.complete(gestion.id);
          } catch (err) {
            return reply(err instanceof Error ? err.message : String(err), true);
          }
          return reply(
            `Gestión "${gestion.title}" terminada. ${gestion.ledger.length} pasos registrados.`,
          );
        }
        case 'cancelar': {
          try {
            deps.gestor.cancel(gestion.id);
          } catch (err) {
            return reply(err instanceof Error ? err.message : String(err), true);
          }
          return reply(`Gestión "${gestion.title}" cancelada.`);
        }
        default:
          return reply(`Acción no soportada: ${args.action as string}`, true);
      }
    },
  };
}
