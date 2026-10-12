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
 * Playbooks (PR3 / D4): a gestión that taught something reusable about a site
 * leaves it in a per-domain playbook (login flow, selectors, quirks) via
 * playbook_guardar, and reads it back with playbook_leer - BEFORE preparar,
 * because tool-result `details` never reach the model (only `content` does),
 * and knowledge that arrives after the plan is written cannot shape it. The
 * message Nico approves carries no playbook content; an existing playbook for
 * a declared login domain is announced as one plain line in the Accesos
 * section, true for Nico and a pointer for the model.
 *
 * Credentials never enter AND never leave a playbook: save and serve both
 * check the rendered content against ALL current vault values (one fresh
 * snapshot per operation, exact case-sensitive match, env-only secrets
 * included) and one match rejects the write or blocks the read with a generic
 * error. The guarantee covers the vault values at that operation; rotation
 * afterwards is caught by the next operation's revalidation.
 *
 * The scope comes from the caller, never from the model: a gestión belongs to
 * the chat that asked for it and cannot be touched from another.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Store } from '../db.js';
import { EFFECT_CLASSES, EFFECT_LABEL, type EffectClass } from '../gestor/effects.js';
import { missingLoginFields, normalizeDomain, siteKey } from '../gestor/login.js';
import {
  canonicalPlaybookDomain,
  containsVaultValue,
  type Playbook,
  type PlaybookStore,
  renderPlaybook,
  validatePlaybook,
} from '../gestor/playbooks.js';
import type { Gestion, GestionStep, GestorStore } from '../gestor/store.js';
import { buildMacroPrompt, isMacroName } from '../routines.js';
import { vaultList, vaultSnapshotValues } from '../vault.js';

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
    Type.Literal('playbook_leer'),
    Type.Literal('playbook_guardar'),
    Type.Literal('macro'),
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
  logins: Type.Optional(
    Type.Array(
      Type.String({ description: 'A domain the plan must log into, e.g. seg-social.es.' }),
      {
        description:
          'preparar: sites the plan must log into. Credentials live in the vault as ' +
          'site:<dominio>:username and site:<dominio>:password; the proposal lists every ' +
          'missing key with the exact `pa vault set` command so Nico can store it. Values ' +
          'never pass through here.',
      },
    ),
  ),
  paso: Type.Optional(Type.Number({ description: 'paso: 1-based step number completed.' })),
  nota: Type.Optional(
    Type.String({ description: 'paso: one line on what happened in that step.' }),
  ),
  dominio: Type.Optional(
    Type.String({
      description:
        'playbook_leer/playbook_guardar: the site domain (e.g. seg-social.es). Canonicalized ' +
        'with the vault login convention, so www./URL/port forms land on the same playbook.',
    }),
  ),
  login: Type.Optional(
    Type.Array(Type.String({ description: 'One line of the login flow that worked.' }), {
      description:
        'playbook_guardar: login flow notes. Vault key NAMES only as references ' +
        '(site:<dominio>:username|password); a real value here rejects the whole save.',
    }),
  ),
  selectores: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'playbook_guardar: selectors that worked, one line each: what it is + the selector.',
    }),
  ),
  quirks: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'playbook_guardar: quirks and waits (iframes, captcha, multi-step flows, timeouts).',
    }),
  ),
  macro: Type.Optional(
    Type.String({
      description:
        'macro: the stored macro name, always with its namespace (macro/<nombre>). The user sees them with /routines.',
    }),
  ),
  parametros: Type.Optional(
    Type.Array(Type.Object({ nombre: Type.String(), valor: Type.String() }), {
      description:
        'macro: one entry per declared parameter (nombre, valor). Every value is validated ' +
        'against its declared type before anything runs. Values are task arguments, never ' +
        'secrets - credentials stay in the vault as always.',
    }),
  ),
});

function reply(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

/** The plan Nico approves: Spanish, one piece, every step with its effect class. */
export function formatProposal(g: Gestion, access: string[] = []): string {
  const steps = g.plan.map((s, i) => `${i + 1}. [${EFFECT_LABEL[s.effect]}] ${s.text}`).join('\n');
  return [
    `📋 Gestión propuesta: "${g.title}"`,
    '',
    `Lo que pediste: ${g.encargo}`,
    '',
    'Plan (cada paso con su clase de efecto):',
    steps,
    ...(access.length > 0 ? ['', ...access] : []),
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
  /** Per-domain playbooks: preparar reads them, playbook_guardar writes them. */
  playbooks: PlaybookStore;
  /** Stored routines, for action=macro: looked up in this chat's scope only. */
  routines: Pick<Store, 'getRoutine'>;
  /** Vault key NAMES only, for the access section of preparar. Tests inject this. */
  vaultNames?: () => Promise<string[]>;
  /**
   * One fresh snapshot of ALL current vault values, for the playbook
   * credential guard (save AND serve). Tests inject canaries; production is
   * vaultSnapshotValues, which includes env-only secrets vaultList cannot
   * see. Values are only ever compared - never logged, returned or stored.
   */
  vaultSnapshotValues?: () => Promise<string[]>;
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
      'Site knowledge goes to a PLAYBOOK, not a skill: after a gestión taught you how a site works ' +
        '(login flow, selectors that worked, quirks/waits), save it with playbook_guardar. BEFORE ' +
        'preparar, call playbook_leer for every domain you plan to declare in logins - its result ' +
        'content reaches you, preparar details would not, and a plan built on known selectors is a ' +
        'better plan. Credentials never go in or out: reference vault keys by NAME ' +
        '(site:<dominio>:password); a real value rejects the save and blocks the read.',
      'macro: run a stored macro (macro/<nombre>) with its typed parameters - the validated ' +
        'prompt comes back in this result content for you to execute live in this chat, each ' +
        'step still governed by the gate. Parameters are task arguments, never secrets.',
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
        // The vault login convention (PR2): the proposal names every key the
        // plan needs and the exact `pa vault set` command for each missing
        // one. Key NAMES only - a value never passes through this tool.
        const domains: string[] = [];
        let loginIndex = 0;
        for (const raw of args.logins ?? []) {
          loginIndex++;
          const domain = normalizeDomain(raw);
          if (!domain) {
            // NEVER echo the raw input: a malformed URL can carry userinfo
            // (user:secret@host) and this error goes straight to the chat.
            return reply(
              `El login número ${loginIndex} no parece un dominio válido: usa algo como seg-social.es.`,
              true,
            );
          }
          if (!domains.includes(domain)) domains.push(domain);
        }
        let access: string[] = [];
        if (domains.length > 0) {
          const names = await (deps.vaultNames ?? vaultList)();
          access = ['Accesos (credenciales solo por el vault, nunca por aquí):'];
          for (const domain of domains) {
            const missing = missingLoginFields(domain, names);
            if (missing.length === 0) {
              access.push(`- ${domain}: ✔ usuario y contraseña ya están en el vault.`);
            } else {
              for (const field of missing) {
                access.push(
                  `- ${domain}: falta ${siteKey(domain, field)} - guárdala con: pa vault set ${siteKey(domain, field)} <valor>`,
                );
              }
            }
            // One plain line, true for Nico and a pointer for the model: the
            // playbook CONTENT never rides here - the model reads it with
            // playbook_leer, whose result content does reach it.
            if (deps.playbooks.read(domain)) {
              access.push(
                `- ${domain}: hay un playbook guardado de este sitio (lo leo con gestion:playbook_leer).`,
              );
            }
          }
        }
        // Budget the exact message Nico would approve. The probe id is the
        // same length as a real one (36), so the check sees the true size.
        const probe = formatProposal(
          {
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
          },
          access,
        );
        if (probe.length > MAX_GESTION_CHARS) {
          return reply(
            `El plan no cabe en un solo mensaje (${probe.length} caracteres, máximo ${MAX_GESTION_CHARS}): resume los pasos o acorta el encargo y proponlo de nuevo. Nada quedó guardado.`,
            true,
          );
        }
        const gestion = deps.gestor.propose({ scope, title, encargo, plan });
        return reply(formatProposal(gestion, access));
      }

      if (args.action === 'playbook_leer') {
        const domain = canonicalPlaybookDomain(args.dominio ?? '');
        if (!domain) {
          return reply('playbook_leer necesita un dominio válido (p. ej. seg-social.es).', true);
        }
        const pb = deps.playbooks.read(domain);
        if (!pb) {
          return reply(
            `No hay playbook de ${domain}. Cuando una gestión en ese sitio enseñe algo reusable, guárdalo con playbook_guardar.`,
          );
        }
        // Serve revalidates like save: the file could have been hand-edited,
        // or a value it quotes could have become a secret after a rotation.
        // One snapshot per read; a match blocks with a generic error and the
        // content is never returned.
        const values = await (deps.vaultSnapshotValues ?? vaultSnapshotValues)();
        if (containsVaultValue(renderPlaybook(pb), values)) {
          return reply(
            `El playbook de ${domain} está bloqueado: su contenido coincide con un valor actual del vault. Revísalo a mano (playbooks/${domain}.md) o bórralo, y vuelve a guardarlo solo con conocimiento, nunca con credenciales.`,
            true,
          );
        }
        return reply(renderPlaybook(pb));
      }

      if (args.action === 'playbook_guardar') {
        const domain = canonicalPlaybookDomain(args.dominio ?? '');
        if (!domain) {
          return reply('playbook_guardar necesita un dominio válido (p. ej. seg-social.es).', true);
        }
        const pb: Playbook = {
          domain,
          updatedAt: new Date().toISOString(),
          login: (args.login ?? []).map((l) => l.trim()).filter(Boolean),
          selectores: (args.selectores ?? []).map((l) => l.trim()).filter(Boolean),
          quirks: (args.quirks ?? []).map((l) => l.trim()).filter(Boolean),
        };
        if (pb.login.length + pb.selectores.length + pb.quirks.length === 0) {
          return reply(
            'playbook_guardar necesita contenido en alguna sección (login, selectores o quirks).',
            true,
          );
        }
        const invalid = validatePlaybook(pb);
        if (invalid) return reply(invalid, true);
        // Credential guard, positive and provable: the rendered content is
        // checked against ALL current vault values (exact, case-sensitive)
        // before anything is written. One match rejects the save with a
        // generic message - the matched value is never named or echoed.
        const values = await (deps.vaultSnapshotValues ?? vaultSnapshotValues)();
        if (containsVaultValue(renderPlaybook(pb), values)) {
          return reply(
            'El playbook no se guarda: su contenido coincide con un valor del vault. Las credenciales viven en el vault; aquí solo va el NOMBRE de la clave (site:<dominio>:campo).',
            true,
          );
        }
        deps.playbooks.save(pb);
        const notes = pb.login.length + pb.selectores.length + pb.quirks.length;
        return reply(
          `Playbook de ${domain} guardado (${notes} notas). La próxima gestión en ${domain} lo leerá al preparar el plan.`,
        );
      }

      if (args.action === 'macro') {
        const name = args.macro?.trim() ?? '';
        if (!isMacroName(name)) {
          return reply(
            'macro necesita el nombre con su namespace: macro/<nombre> (las ves con /routines).',
            true,
          );
        }
        const routine = deps.routines.getRoutine(scope, name);
        if (!routine?.params?.length) {
          return reply(`No encuentro la macro ${name} en este chat.`, true);
        }
        const argMap: Record<string, string> = {};
        for (const entry of args.parametros ?? []) {
          const key = entry.nombre.trim();
          if (key in argMap) return reply(`Parámetro repetido: ${key}.`, true);
          argMap[key] = entry.valor;
        }
        const built = buildMacroPrompt(routine, argMap);
        if (!built.ok) return reply(built.error, true);
        // The validated prompt is the result content: the model executes it
        // live in this chat, with the gate watching every step as always.
        return reply(
          `Macro ${name} validada. Ejecútala ahora, paso a paso, en este chat:\n\n${built.prompt}`,
        );
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
            `Gestión "${gestion.title}" terminada. ${gestion.ledger.length} pasos registrados. ` +
              'Si el sitio enseñó algo reusable (flujo de login, selectores que funcionaron, esperas), ' +
              'guárdalo con gestion:playbook_guardar - la próxima gestión en ese dominio lo leerá al preparar el plan.',
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
