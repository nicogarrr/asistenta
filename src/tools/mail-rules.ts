import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  defaultBatchFile,
  describeSelection,
  saveBatch,
  selectForCleanup,
  takeBatch,
} from '../mail/cleanup.js';
import { type ImapMover, MOVE_TARGET_LABEL, type MoveTarget, moveFromInbox } from '../mail/move.js';
import {
  addRule,
  defaultRulesFile,
  deleteRule,
  describeRule,
  loadRules,
  matchRule,
  type RuleAction,
} from '../mail/rules.js';
import { type ImapLike, imapFor, type ScannedMail, scanInbox } from '../mail/scan.js';
import { CATEGORY_LABEL, classifyByHeaders, domainOf, type MailCategory } from '../mail/triage.js';
import type { MailAccount } from '../mail/types.js';

const CATEGORIES = Object.keys(CATEGORY_LABEL) as MailCategory[];
const ACTIONS: RuleAction[] = ['archivar', 'limpieza', 'papelera', 'leido'];

const Params = Type.Object({
  action: Type.Union(
    [
      Type.Literal('resumen'),
      Type.Literal('reglas'),
      Type.Literal('crear'),
      Type.Literal('borrar'),
      Type.Literal('limpiar_vista'),
      Type.Literal('limpiar'),
    ],
    {
      description:
        'resumen: clasifica el correo reciente (no mueve nada). reglas: lista. crear/borrar: una regla. limpiar_vista: lista lo que se movería (no mueve). limpiar: mueve el lote aprobado.',
    },
  ),
  cuantos: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 300, description: 'resumen: correos a mirar (100).' }),
  ),
  texto: Type.Optional(Type.String({ description: 'crear: lo que dijo el dueño, tal cual.' })),
  remitente: Type.Optional(
    Type.String({ description: 'crear: trozo de la dirección/dominio («linkedin»).' }),
  ),
  asunto: Type.Optional(Type.String({ description: 'crear: trozo del asunto.' })),
  excepto: Type.Optional(
    Type.String({ description: 'crear: si el asunto dice esto, no aplica («pedido»).' }),
  ),
  categoria: Type.Optional(Type.Union(CATEGORIES.map((c) => Type.Literal(c)))),
  accion: Type.Optional(Type.Union(ACTIONS.map((a) => Type.Literal(a)))),
  id: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: 'borrar: número de la regla. limpiar_vista: usar esa regla.',
    }),
  ),
  destino: Type.Optional(
    Type.Union(
      (['limpieza', 'archivar', 'papelera'] as const).map((d) => Type.Literal(d)),
      {
        description:
          'limpiar_vista: limpieza (por defecto), archivar, o papelera solo si dijo «borrar».',
      },
    ),
  ),
  lote: Type.Optional(Type.String({ description: 'limpiar: el id del lote de la vista previa.' })),
});

export const NO_MAIL_ACCOUNT =
  'El correo no está configurado todavía: falta la cuenta de Gmail y su contraseña de aplicación.';

export interface MailRulesDeps {
  account: () => Promise<MailAccount | null>;
  imap?: (account: MailAccount) => ImapLike;
  rulesFile?: string;
  now?: () => number;
  mover?: (account: MailAccount) => ImapMover;
  batchFile?: string;
}

const errText = (err: unknown) => (err instanceof Error ? err.message.slice(0, 120) : 'error');

function top(list: ScannedMail[], n = 3): string {
  const counts = new Map<string, number>();
  for (const m of list)
    counts.set(domainOf(m.from) || m.from, (counts.get(domainOf(m.from) || m.from) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([d, c]) => `${d} ${c}`)
    .join(', ');
}

export function summarize(mails: ScannedMail[], rulesFile: string): string {
  const rules = loadRules(rulesFile);
  const by = new Map<MailCategory, ScannedMail[]>();
  const ruled = new Map<number, number>();
  const suspects: string[] = [];
  for (const m of mails) {
    const r = classifyByHeaders({ ...m, headers: m.headers }) ?? {
      category: 'importante' as const,
      reasons: [],
    };
    by.set(r.category, [...(by.get(r.category) ?? []), m]);
    if (r.category === 'spam' && suspects.length < 3)
      suspects.push(`«${m.subject.slice(0, 60)}» de ${m.from} (${r.reasons[0] ?? 'sospechoso'})`);
    const rule = matchRule(rules, { from: m.from, subject: m.subject, category: r.category });
    if (rule) ruled.set(rule.id, (ruled.get(rule.id) ?? 0) + 1);
  }
  const lines = [`He mirado ${mails.length} correos recientes:`];
  for (const c of ['publicidad', 'notificacion', 'spam', 'personal', 'importante'] as const) {
    const list = by.get(c) ?? [];
    if (list.length === 0) continue;
    lines.push(
      `• ${CATEGORY_LABEL[c]}: ${list.length}${c === 'importante' || c === 'personal' ? '' : ` (${top(list)})`}`,
    );
  }
  for (const s of suspects) lines.push(`⚠️ posible estafa: ${s}`);
  for (const rule of rules) {
    const n = ruled.get(rule.id);
    if (n) lines.push(`Regla ${describeRule(rule)}: ${n} correos.`);
  }
  lines.push('No he movido ni borrado nada.');
  return lines.join('\n');
}

/**
 * «Limpia el correo», «¿cuánta publicidad me llega?», «lo de LinkedIn a la papelera».
 * Clasifica por cabeceras y guarda reglas del dueño. No mueve ni borra correo: eso va
 * aparte, con la lista exacta enseñada antes y aprobada.
 */
export function createMailRulesTool(deps: MailRulesDeps): AgentTool<typeof Params> {
  const file = deps.rulesFile ?? defaultRulesFile();
  return {
    name: 'correo_reglas',
    label: 'Reglas de correo',
    description:
      'Mail triage and owner rules. resumen: classify recent inbox mail (importante/personal/notificación/publicidad/spam) by headers and show counts per sender plus suspected phishing; moves nothing. reglas: list saved rules. crear: save a rule from the owner\'s words (e.g. «lo de LinkedIn a la papelera» → remitente "linkedin", accion "papelera"; «lo de Amazon que no sea un pedido, archívalo» → remitente "amazon", excepto "pedido", accion "archivar"). borrar: delete rule by id. Rules never act alone. limpiar_vista («limpia lo no importante», «limpia lo de LinkedIn», «aplica la regla 2»): shows what would move (default: ads and notifications to Asistenta/Limpieza; destino archivar, or papelera ONLY if Nico said «borrar»), moves nothing, and returns a lote id. limpiar (lote): moves exactly that previewed batch; only after Nico says yes to that preview — he is asked again every time. Never permanent delete.',
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const text = async (): Promise<string> => {
        if (args.action === 'reglas') {
          const rules = loadRules(file);
          return rules.length
            ? `Reglas de correo:\n${rules.map(describeRule).join('\n')}`
            : 'No hay reglas de correo.';
        }
        if (args.action === 'crear') {
          if (!args.accion)
            return 'Falta qué hacer con esos correos (archivar, limpieza, papelera o leído).';
          const saved = addRule(
            {
              texto: args.texto ?? '',
              remitente: args.remitente,
              asunto: args.asunto,
              excepto: args.excepto,
              categoria: args.categoria,
              accion: args.accion,
            },
            file,
            new Date(deps.now?.() ?? Date.now()),
          );
          return typeof saved === 'string'
            ? saved
            : `Regla guardada: ${describeRule(saved)}. No se aplica sola: te enseñaré la lista antes.`;
        }
        if (args.action === 'borrar') {
          if (!args.id) return 'Dime el número de la regla.';
          const gone = deleteRule(args.id, file);
          return gone ? `Regla borrada: ${describeRule(gone)}` : `No hay regla ${args.id}.`;
        }
        const now = deps.now?.() ?? Date.now();
        const batches = deps.batchFile ?? defaultBatchFile();
        const account = await deps.account();
        if (!account) return NO_MAIL_ACCOUNT;
        if (args.action === 'limpiar') {
          const batch = args.lote ? takeBatch(args.lote, now, batches) : null;
          if (!batch || batch.account !== account.address)
            return 'Ese lote ya no vale (caducó o ya se usó). Pídeme otra vez la vista previa.';
          try {
            const mover = deps.mover ?? ((a: MailAccount) => imapFor(a) as unknown as ImapMover);
            const r = await moveFromInbox(
              mover(account),
              batch.uids,
              batch.accion,
              batch.uidValidity,
            );
            return `Hecho: ${r.moved} correos (${MOVE_TARGET_LABEL[batch.accion]}, carpeta «${r.folder}»). Nada se ha borrado para siempre.`;
          } catch (err) {
            return `No he movido nada: ${errText(err)}.`;
          }
        }
        if (args.action === 'limpiar_vista') {
          const rule = args.id ? loadRules(file).find((r) => r.id === args.id) : undefined;
          if (args.id && !rule) return `No hay regla ${args.id}.`;
          if (rule?.accion === 'leido' && !args.destino)
            return 'Esa regla marca como leído; limpiar solo mueve. Dime a dónde: limpieza, archivar o papelera.';
          try {
            const box = { uidValidity: '' };
            const mails = await scanInbox((deps.imap ?? imapFor)(account), {
              limit: args.cuantos ?? 200,
              since: now - 90 * 86_400_000,
              box,
            });
            const { picked, accion } = selectForCleanup(mails, {
              categoria: args.categoria,
              remitente: args.remitente,
              regla: rule,
              accion: args.destino as MoveTarget | undefined,
            });
            if (picked.length === 0)
              return `He mirado ${mails.length} correos: no hay nada que limpiar con eso.`;
            const resumen = describeSelection(picked, accion);
            const batch = saveBatch(
              {
                account: account.address,
                uidValidity: box.uidValidity,
                uids: picked.map((m) => m.uid).sort((a, b) => a - b),
                accion,
                resumen,
              },
              now,
              batches,
            );
            return `${resumen}\nNo he tocado nada. Si te parece bien, dime «sí» y lo hago (lote ${batch.id}).`;
          } catch (err) {
            return `No pude leer el correo ahora (${errText(err)}).`;
          }
        }
        try {
          const mails = await scanInbox((deps.imap ?? imapFor)(account), {
            limit: args.cuantos ?? 100,
            since: (deps.now?.() ?? Date.now()) - 30 * 86_400_000,
          });
          return mails.length ? summarize(mails, file) : 'No hay correos en los últimos 30 días.';
        } catch (err) {
          return `No pude leer el correo ahora (${errText(err)}).`;
        }
      };
      return { content: [{ type: 'text', text: await text() }], details: {} };
    },
  };
}
