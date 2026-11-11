/**
 * Uso de funciones y habilidades (hueco #10): qué usa Nico de verdad y qué lleva un mes
 * sin tocarse.
 *
 * - Funciones (herramientas): se cuentan del registro de auditoría de llamadas que ya
 *   existe (audit/calls.jsonl, solo las permitidas). Nada nuevo que escribir.
 * - Habilidades aprendidas: cada vez que el asistente lee una para seguirla (skills
 *   action=read) se apunta un uso en `<skills>/.uso.json` (empieza por punto: la lista de
 *   habilidades nunca lo toma por una).
 * - Archivar = desactivar (lo mismo que «quita la de X»): no se borra nada y vuelve con
 *   «activa la habilidad X». Solo las aprendidas (nunca las que trae el asistente), creadas
 *   hace más de 30 días y sin usar en 30 días, y siempre tras enseñar la lista al dueño.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CallAuditLine } from './audit/calls.js';
import { writeFileReplacing } from './fs-tmp.js';
import type { Skill } from './skills/types.js';
import { sliceSafe } from './text.js';

export const USO_VENTANA_MS = 30 * 24 * 3_600_000;

export interface UseCount {
  n: number;
  /** Epoch ms del último uso. */
  last: number;
}

/** Usos por herramienta desde `since` (solo llamadas que la Gate dejó pasar). */
export function toolUseCounts(
  lines: readonly Pick<CallAuditLine, 'tool' | 'verdict' | 'ts'>[],
  since: number,
): Map<string, UseCount> {
  const out = new Map<string, UseCount>();
  for (const l of lines) {
    if (l.verdict !== 'allow') continue;
    const at = Date.parse(l.ts);
    if (!Number.isFinite(at) || at < since) continue;
    const c = out.get(l.tool) ?? { n: 0, last: 0 };
    c.n += 1;
    c.last = Math.max(c.last, at);
    out.set(l.tool, c);
  }
  return out;
}

/** Usos de las habilidades aprendidas, en un JSON pequeño junto a ellas. */
export class SkillUsage {
  readonly #file: string;
  constructor(file: string) {
    this.#file = file;
  }

  all(): Record<string, UseCount> {
    try {
      const v = JSON.parse(readFileSync(this.#file, 'utf8')) as unknown;
      return v && typeof v === 'object' ? (v as Record<string, UseCount>) : {};
    } catch {
      return {};
    }
  }

  /** Apunta un uso. Nunca lanza: contar no puede romper la habilidad. */
  record(id: string, now: number = Date.now()): void {
    try {
      const all = this.all();
      const c = all[id] ?? { n: 0, last: 0 };
      all[id] = { n: (Number(c.n) || 0) + 1, last: now };
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileReplacing(this.#file, `${JSON.stringify(all)}\n`);
    } catch {}
  }
}

/** Aprendidas, activas, creadas hace más de 30 días y sin usar en 30 días. */
export function archiveCandidates(
  skills: readonly Skill[],
  use: Record<string, UseCount>,
  now: number,
): Skill[] {
  const cutoff = now - USO_VENTANA_MS;
  return skills.filter((s) => {
    if (s.disabled || s.pinned || s.trust === 'official') return false;
    if (s.createdAt > cutoff) return false;
    const last = Math.max(use[s.id]?.last ?? 0, s.updatedAt ?? 0);
    return last < cutoff;
  });
}

export interface UsoView {
  tools: Map<string, UseCount>;
  /** Texto de cada herramienta para el dueño (TOOL_ABILITIES); null = interna. */
  toolText: (tool: string) => string | null;
  skills: readonly Skill[];
  skillUse: Record<string, UseCount>;
  now: number;
}

const shorten = (s: string, max = 60): string => (s.length > max ? `${sliceSafe(s, max - 1)}…` : s);

/** «/funciones uso»: lo más usado, lo que no se usa y las habilidades que se pueden archivar. */
export function usoText(v: UsoView): string {
  const lines = ['📊 Lo que más usas (últimos 30 días):'];
  const ranked = [...v.tools.entries()]
    .map(([tool, c]) => ({ tool, c, text: v.toolText(tool) }))
    .filter((x) => x.text !== null)
    .sort((a, b) => b.c.n - a.c.n || a.tool.localeCompare(b.tool));
  if (ranked.length === 0) lines.push('Todavía nada apuntado en este mes.');
  for (const x of ranked.slice(0, 8)) lines.push(`• ${x.c.n}× ${shorten(x.text ?? x.tool)}`);

  const learned = v.skills.filter((s) => s.trust !== 'official' && !s.disabled);
  if (learned.length) {
    const used = learned
      .filter((s) => (v.skillUse[s.id]?.last ?? 0) >= v.now - USO_VENTANA_MS)
      .sort((a, b) => (v.skillUse[b.id]?.n ?? 0) - (v.skillUse[a.id]?.n ?? 0));
    lines.push('', `🧠 Habilidades aprendidas: ${learned.length}`);
    if (used.length)
      lines.push(
        `Más usadas: ${used
          .slice(0, 5)
          .map((s) => `${s.name} (${v.skillUse[s.id]?.n ?? 0})`)
          .join(', ')}`,
      );
    const pinned = learned.filter((s) => s.pinned);
    if (pinned.length)
      lines.push(`📌 Fijadas (nunca se archivan): ${pinned.map((s) => s.name).join(', ')}`);
    const stale = archiveCandidates(v.skills, v.skillUse, v.now);
    if (stale.length) {
      lines.push(
        `Sin usar en 30 días: ${stale.map((s) => s.name).join(', ')}`,
        'Para archivarlas (se desactivan, no se borran): /funciones archivar',
        'Para que una no se archive nunca: /funciones fijar <nombre>',
      );
    }
  }
  return lines.join('\n');
}

/** Lo que enseña el panel (tarjeta Funciones → «Lo que más usas»): solo textos y números. */
export interface UsoPanel {
  dias: number;
  masUsadas: { texto: string; veces: number }[];
  habilidades: { total: number; masUsadas: { nombre: string; veces: number }[]; sinUsar: string[] };
  /** Comando para archivar las que no se usan; null si no hay ninguna. */
  archivar: string | null;
}

/** Los mismos datos que «/funciones uso», para el panel. */
export function usoPanel(v: UsoView): UsoPanel {
  const masUsadas = [...v.tools.entries()]
    .map(([tool, c]) => ({ tool, c, text: v.toolText(tool) }))
    .filter((x) => x.text !== null)
    .sort((a, b) => b.c.n - a.c.n || a.tool.localeCompare(b.tool))
    .slice(0, 8)
    .map((x) => ({ texto: shorten(x.text ?? x.tool), veces: x.c.n }));
  const learned = v.skills.filter((s) => s.trust !== 'official' && !s.disabled);
  const usadas = learned
    .filter((s) => (v.skillUse[s.id]?.last ?? 0) >= v.now - USO_VENTANA_MS)
    .sort((a, b) => (v.skillUse[b.id]?.n ?? 0) - (v.skillUse[a.id]?.n ?? 0))
    .slice(0, 5)
    .map((s) => ({ nombre: s.name, veces: v.skillUse[s.id]?.n ?? 0 }));
  const sinUsar = archiveCandidates(v.skills, v.skillUse, v.now).map((s) => s.name);
  return {
    dias: Math.round(USO_VENTANA_MS / (24 * 3_600_000)),
    masUsadas,
    habilidades: { total: learned.length, masUsadas: usadas, sinUsar },
    archivar: sinUsar.length ? '/funciones archivar' : null,
  };
}

/**
 * «/funciones archivar»: primero enseña la lista; con «sí» las desactiva. Devuelve el
 * texto y, si se confirmó, los ids desactivados.
 */
export function archivarText(
  skills: readonly Skill[],
  use: Record<string, UseCount>,
  now: number,
  confirmed: boolean,
  disable: (id: string) => boolean,
): string {
  const stale = archiveCandidates(skills, use, now);
  if (stale.length === 0)
    return 'No hay habilidades aprendidas sin usar en 30 días. Nada que archivar.';
  if (!confirmed) {
    return [
      `Estas ${stale.length === 1 ? 'habilidad lleva' : `${stale.length} habilidades llevan`} más de 30 días sin usarse:`,
      ...stale.map((s) => `• ${s.name} — ${shorten(s.description || s.whenToUse, 80)}`),
      '',
      'Si te parece, /funciones archivar sí y las desactivo (no se borran; vuelven con «activa la habilidad …»).',
    ].join('\n');
  }
  const done = stale.filter((s) => disable(s.id));
  return done.length
    ? `🗄️ Archivadas: ${done.map((s) => s.name).join(', ')}. Si echas alguna de menos: «activa la habilidad …».`
    : 'No pude archivar ninguna.';
}

/** «sí», «si», «vale», «ok», «confirmo» tras /funciones archivar. */
export function isArchiveConfirm(rest: string): boolean {
  return /^(s[ií]|vale|ok|confirmo|adelante)(?=$|[\s,.!])/i.test(rest.trim());
}

/** Busca una habilidad aprendida por id o por nombre (sin acentos ni mayúsculas). */
export function findLearnedSkill(skills: readonly Skill[], query: string): Skill | null {
  const fold = (t: string) =>
    t
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[«»"'“”]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const q = fold(query);
  if (!q) return null;
  const learned = skills.filter((s) => s.trust !== 'official');
  const exact = learned.find(
    (s) => s.id === q || fold(s.name) === q || fold(s.id.replace(/-/g, ' ')) === q,
  );
  if (exact) return exact;
  const partial = learned.filter(
    (s) => fold(s.name).includes(q) || s.id.includes(q.replace(/ /g, '-')),
  );
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

/**
 * «/funciones fijar <nombre>» y «/funciones soltar <nombre>» (el «lock» del curador de
 * Hermes): una habilidad fijada nunca sale en «sin usar» ni la archiva /funciones archivar.
 * Sin nombre, lista las fijadas.
 */
export function fijarText(
  skills: readonly Skill[],
  query: string,
  pin: boolean,
  setPinned: (id: string, pinned: boolean) => boolean,
): string {
  const q = query.trim();
  if (!q) {
    const pinned = skills.filter((s) => s.pinned && s.trust !== 'official');
    return pinned.length
      ? [
          '📌 Habilidades fijadas (nunca se archivan):',
          ...pinned.map((s) => `• ${s.name}`),
          '',
          'Para soltar una: /funciones soltar <nombre>',
        ].join('\n')
      : 'No tienes ninguna habilidad fijada. Para fijar una: /funciones fijar <nombre> (las ves con /funciones uso).';
  }
  const s = findLearnedSkill(skills, q);
  if (!s) {
    const learned = skills.filter((x) => x.trust !== 'official');
    const hint = learned.length
      ? `Las que tengo: ${learned
          .slice(0, 10)
          .map((x) => x.name)
          .join(', ')}${learned.length > 10 ? '…' : ''}`
      : 'Todavía no he aprendido ninguna habilidad.';
    return `No encuentro ninguna habilidad aprendida que se llame «${shorten(q)}». ${hint}`;
  }
  if (Boolean(s.pinned) === pin)
    return pin
      ? `📌 «${s.name}» ya estaba fijada: no se archiva nunca.`
      : `«${s.name}» no estaba fijada.`;
  if (!setPinned(s.id, pin)) return `No pude ${pin ? 'fijar' : 'soltar'} «${s.name}».`;
  return pin
    ? `📌 Fijada «${s.name}»: aunque pase tiempo sin usarla, no te la propondré archivar.${s.disabled ? ' Ojo: ahora está desactivada; «activa la habilidad …» para volver a usarla.' : ''}`
    : `Soltada «${s.name}»: si pasa 30 días sin usarse, volverá a salir en /funciones archivar.`;
}

/** «fijar», «fija», «bloquear» → true; «soltar», «desfijar», «suelta» → false; si no, null. */
export function pinSubcommand(sub: string): boolean | null {
  const s = sub
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (/^(fijar|fija|fijala|bloquear|bloquea)$/.test(s)) return true;
  if (/^(soltar|suelta|desfijar|desfija|desbloquear|desbloquea)$/.test(s)) return false;
  return null;
}
