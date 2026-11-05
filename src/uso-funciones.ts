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
    if (s.disabled || s.trust === 'official') return false;
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
    const stale = archiveCandidates(v.skills, v.skillUse, v.now);
    if (stale.length) {
      lines.push(
        `Sin usar en 30 días: ${stale.map((s) => s.name).join(', ')}`,
        'Para archivarlas (se desactivan, no se borran): /funciones archivar',
      );
    }
  }
  return lines.join('\n');
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
