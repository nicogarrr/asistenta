/**
 * «Cuando hable de Indra, recuérdame mirar el dividendo»: un recordatorio que salta por un
 * TEMA, no por una hora. Es la «standing intent» de OpenClaw
 * (https://docs.openclaw.ai/concepts/standing-intents): memoria prospectiva que recuerda qué
 * hacer cuando aparece algo, y no a una hora. Va sin modelo: las palabras se buscan en lo que
 * Nico escribe en su chat privado, y el aviso sale aparte, delante de la respuesta normal.
 *
 * Con los mismos topes conservadores que OpenClaw: como mucho una vez al día (cooldown de
 * 24 h), 3 veces en total, y caduca a los 90 días. /intenciones las lista y las quita.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { foldAccents, sliceSafe } from './text.js';

export const INTENCION_COOLDOWN_MS = 24 * 3_600_000;
export const INTENCION_MAX_VECES = 3;
export const INTENCION_DIAS = 90;
export const INTENCIONES_MAX = 30;

export interface Intencion {
  id: number;
  chat: string;
  /** Las palabras que la disparan (cualquiera vale), tal cual las dijo. */
  claves: string[];
  /** Lo que hay que recordarle. */
  texto: string;
  creada: number;
  expira: number;
  veces: number;
  ultima: number | null;
}

const fold = (s: string): string => foldAccents(s).toLowerCase();

/**
 * «cuando hable de Indra, recuérdame mirar el dividendo», «si menciono a Ana, pregúntame por
 * su viaje», «cuando salga el tema de la hipoteca, dime que llame al banco». null si no lo es.
 * «cuando llegue/salga de casa» es otra cosa (llegada.ts) y no se toca.
 */
export function intencionIntent(text: string): { claves: string[]; texto: string } | null {
  const t = text.trim().replace(/[.!]+$/, '');
  const m =
    /^(?:cuando|cada\s+vez\s+que|si(?:\s+alguna\s+vez)?)\s+(?:yo\s+)?(?:te\s+)?(?:hable(?:s|mos)?|hablo|mencione(?:s|mos)?|menciono|nombre|nombro|saque|saco|salga\s+(?:el\s+)?tema|sale\s+(?:el\s+)?tema|escriba|escribo)\s+(?:de|sobre|del|a|con|el\s+tema\s+de)?\s*(.{2,80}?)\s*[,;:]?\s+(?:recu[eé]rdame|av[ií]same(?:\s+de)?|dime|preg[uú]ntame(?:\s+por)?)\s+(?:que\s+|de\s+)?(.{3,300})$/i.exec(
      t,
    );
  if (!m?.[1] || !m[2]) return null;
  const tema = m[1].replace(/^(?:el|la|los|las|mi|mis)\s+/i, '').trim();
  if (/^(?:casa|del?\s+trabajo|la\s+oficina)$/i.test(tema)) return null;
  const claves = tema
    .split(/\s*(?:,|\s+o\s+|\s+u\s+|\/)\s*/i)
    .map((c) => c.replace(/^(?:el|la|los|las|de|del|a)\s+/i, '').trim())
    .filter((c) => c.length >= 2)
    .slice(0, 5);
  if (!claves.length) return null;
  return { claves, texto: m[2].trim() };
}

/** ¿Sale la palabra (o la frase) en el texto? Sin tildes ni mayúsculas, palabra entera. */
export function mencionaClave(text: string, clave: string): boolean {
  const c = fold(clave)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  if (!c) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${c}(?:$|[^\\p{L}\\p{N}])`, 'u').test(fold(text));
}

export class IntencionesStore {
  readonly #file: string;
  constructor(file: string) {
    this.#file = file;
  }

  #leer(): Intencion[] {
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as unknown;
      return Array.isArray(raw)
        ? raw.filter(
            (x): x is Intencion =>
              !!x &&
              typeof x.id === 'number' &&
              typeof x.chat === 'string' &&
              Array.isArray(x.claves) &&
              typeof x.texto === 'string',
          )
        : [];
    } catch {
      return [];
    }
  }

  #guardar(l: Intencion[]): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(l, null, 2));
    renameSync(tmp, this.#file);
  }

  /** Las vivas de un chat (sin caducadas ni gastadas), en orden de creación. */
  lista(chat: string, now: number): Intencion[] {
    return this.#leer().filter(
      (i) => i.chat === chat && i.expira > now && i.veces < INTENCION_MAX_VECES,
    );
  }

  crear(chat: string, claves: string[], texto: string, now: number): Intencion | 'lleno' {
    const vivas = this.#leer().filter((i) => i.expira > now && i.veces < INTENCION_MAX_VECES);
    if (vivas.filter((i) => i.chat === chat).length >= INTENCIONES_MAX) return 'lleno';
    const igual = vivas.find(
      (i) =>
        i.chat === chat &&
        fold(i.texto) === fold(texto) &&
        fold(i.claves.join('|')) === fold(claves.join('|')),
    );
    if (igual) return igual;
    const id = Math.max(0, ...this.#leer().map((i) => i.id)) + 1;
    const nueva: Intencion = {
      id,
      chat,
      claves,
      texto: sliceSafe(texto, 300),
      creada: now,
      expira: now + INTENCION_DIAS * 86_400_000,
      veces: 0,
      ultima: null,
    };
    // Las caducadas o gastadas se limpian al escribir.
    this.#guardar([...vivas, nueva]);
    return nueva;
  }

  /** Quita la N de la lista (1 = la primera de /intenciones). */
  quitar(chat: string, n: number, now: number): Intencion | null {
    const l = this.lista(chat, now);
    const i = l[n - 1];
    if (!i) return null;
    this.#guardar(this.#leer().filter((x) => x.id !== i.id));
    return i;
  }

  /**
   * Las que dispara este mensaje (y las apunta: una vez al día como mucho, 3 en total).
   * Nada si el mensaje es el que la creó.
   */
  disparar(chat: string, text: string, now: number): Intencion[] {
    const todas = this.#leer();
    const out: Intencion[] = [];
    for (const i of todas) {
      if (i.chat !== chat || i.expira <= now || i.veces >= INTENCION_MAX_VECES) continue;
      if (i.ultima !== null && now - i.ultima < INTENCION_COOLDOWN_MS) continue;
      if (now - i.creada < 60_000) continue;
      if (!i.claves.some((c) => mencionaClave(text, c))) continue;
      i.veces++;
      i.ultima = now;
      out.push(i);
    }
    if (out.length) this.#guardar(todas);
    return out;
  }
}

const lista = (claves: readonly string[]): string =>
  claves.length === 1
    ? `«${claves[0]}»`
    : `${claves
        .slice(0, -1)
        .map((c) => `«${c}»`)
        .join(', ')} o «${claves.at(-1)}»`;

export function textoCreada(i: Intencion | 'lleno'): string {
  if (i === 'lleno')
    return `Ya tienes ${INTENCIONES_MAX} recordatorios por tema, que es el tope. Quita alguno con «/intenciones quitar N».`;
  return `💡 Hecho: cuando hables de ${lista(i.claves)} te recuerdo «${i.texto}». Como mucho una vez al día y ${INTENCION_MAX_VECES} veces; caduca en ${INTENCION_DIAS} días. /intenciones para verlas.`;
}

export function textoAviso(i: Intencion): string {
  const quedan = INTENCION_MAX_VECES - i.veces;
  return `💡 Has nombrado ${lista(i.claves)}. Me pediste que te recordara: ${i.texto}${quedan > 0 ? '' : ' (era la última vez; ya no te lo recuerdo más)'}.`;
}

export function intencionesVista(l: readonly Intencion[], now: number): string {
  if (!l.length)
    return '💡 No tienes recordatorios por tema. Dime, por ejemplo, «cuando hable de Indra, recuérdame mirar el dividendo».';
  const dias = (ms: number) => Math.max(1, Math.ceil(ms / 86_400_000));
  return [
    '💡 Recordatorios por tema:',
    ...l.map(
      (i, n) =>
        `${n + 1}. ${lista(i.claves)} → ${i.texto} · ${i.veces}/${INTENCION_MAX_VECES} veces · caduca en ${dias(i.expira - now)} días`,
    ),
    '',
    '«/intenciones quitar N» para quitar una.',
  ].join('\n');
}

/** «/intenciones», «/intenciones quitar 2». */
export function intencionesOrden(
  args: string,
): { kind: 'lista' } | { kind: 'quitar'; n: number } | null {
  const a = args.trim();
  if (!a || /^(?:lista|ver)$/i.test(a)) return { kind: 'lista' };
  const m = /^(?:quitar|quita|borrar|borra|olvida)\s+(\d{1,2})$/i.exec(a);
  return m ? { kind: 'quitar', n: Number(m[1]) } : null;
}
