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
 * «hable de», «mencione a», «salga el tema de»… (lo que dispara: decir, no llegar). Solo en 1ª
 * persona: «cuando hables con el banco, dime qué te dicen» es un encargo para Asistenta, no un
 * recordatorio que salte cuando Nico hable del banco.
 */
const HABLAR = String.raw`(?:yo\s+)?(?:te\s+)?(?:hable(?:mos)?|hablo|mencione(?:mos)?|menciono|nombre|nombro|saque|saco|salga\s+(?:el\s+)?tema|sale\s+(?:el\s+)?tema|escriba|escribo)\s+(?:de|sobre|del|a|con|el\s+tema\s+de)?\s*`;
const CUANDO = String.raw`(?:cuando|cada\s+vez\s+que|si(?:\s+alguna\s+vez)?)\s+`;
const PIDE = String.raw`(?:recu[eé]rdame|av[ií]same(?:\s+de)?|dime|preg[uú]ntame(?:\s+por)?)\s+(?:que\s+|de\s+)?`;
/** «cuando hable de Indra, recuérdame mirar el dividendo». */
const TEMA_PRIMERO = new RegExp(
  String.raw`^${CUANDO}${HABLAR}(.{2,80}?)\s*[,;:]?\s+${PIDE}(.{3,300})$`,
  'i',
);
/** Al revés: «recuérdame mirar el dividendo cuando hable de Indra». */
const TEMA_DESPUES = new RegExp(
  String.raw`^${PIDE}(.{3,300}?)\s*[,;:]?\s+${CUANDO}${HABLAR}(.{2,80})$`,
  'i',
);

/**
 * Lo de cuándo o cómo al final del tema («con Marta mañana», «con el banco el lunes», «con Ana
 * por teléfono») no es parte del tema: «Marta mañana» no sale nunca en lo que escribe y el
 * recordatorio no saltaría (bugs-38).
 */
const CUANDO_FINAL =
  /\s+(?:hoy|mañana|manana|pasado\s+mañana|luego|después|despues|otra\s+vez|de\s+nuevo|pronto|esta\s+(?:mañana|manana|tarde|noche|semana)|este\s+(?:mes|finde|fin\s+de\s+semana)|(?:el|este|el\s+próximo|el\s+proximo)\s+(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)|la\s+(?:semana|próxima\s+semana|proxima\s+semana)(?:\s+que\s+viene)?|por\s+(?:teléfono|telefono|whatsapp|correo|mail|email)|en\s+persona)$/i;
function sinCuando(tema: string): string {
  let t = tema.trim();
  for (let i = 0; i < 3; i++) {
    const s = t.replace(CUANDO_FINAL, '').trim();
    if (s === t || s.length < 2) break;
    t = s;
  }
  return t;
}

/**
 * «cuando hable de Indra, recuérdame mirar el dividendo», «si menciono a Ana, pregúntame por
 * su viaje», «cuando salga el tema de la hipoteca, dime que llame al banco», y al revés
 * («recuérdame mirar el dividendo cuando hable de Indra»). null si no lo es.
 * «cuando llegue/salga de casa» es otra cosa (llegada.ts) y no se toca.
 */
export function intencionIntent(text: string): { claves: string[]; texto: string } | null {
  const t = text.trim().replace(/[.!]+$/, '');
  const a = TEMA_PRIMERO.exec(t);
  const b = a ? null : TEMA_DESPUES.exec(t);
  // Al revés, el tema va hasta el final: corto (un nombre, «la hipoteca del piso»), para no
  // tragarse una frase entera («…cuando hable con Pedro le pida el libro»).
  const temaCrudo = a ? a[1] : b?.[2] && b[2].trim().split(/\s+/).length <= 5 ? b[2] : undefined;
  const textoCrudo = a ? a[2] : b?.[1];
  if (!temaCrudo || !textoCrudo) return null;
  const tema = sinCuando(temaCrudo)
    .replace(/^(?:el|la|los|las|mi|mis)\s+/i, '')
    .trim();
  if (/^(?:casa|del?\s+trabajo|la\s+oficina)$/i.test(tema)) return null;
  const claves = tema
    .split(/\s*(?:,|\s+o\s+|\s+u\s+|\/)\s*/i)
    .map((c) => c.replace(/^(?:el|la|los|las|de|del|a)\s+/i, '').trim())
    .filter((c) => c.length >= 2)
    .slice(0, 5);
  if (!claves.length) return null;
  return { claves, texto: textoCrudo.trim() };
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

  /** Quita la de ese id («🔕 No me lo recuerdes más» del aviso). null si ya no estaba. */
  quitarId(chat: string, id: number): Intencion | null {
    const todas = this.#leer();
    const i = todas.find((x) => x.id === id && x.chat === chat);
    if (!i) return null;
    this.#guardar(todas.filter((x) => x !== i));
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

export function textoAviso(
  i: Intencion,
  donde?: { guardado: string } | { correo: { de: string; asunto: string } },
): string {
  const quedan = INTENCION_MAX_VECES - i.veces;
  const que = !donde
    ? `Has nombrado ${lista(i.claves)}`
    : 'guardado' in donde
      ? `Lo que acabas de guardar («${sliceSafe(donde.guardado, 80)}») habla de ${lista(i.claves)}`
      : `Te ha llegado un correo de ${sliceSafe(donde.correo.de, 60)} («${sliceSafe(donde.correo.asunto || 'sin asunto', 80)}») que habla de ${lista(i.claves)}`;
  return `💡 ${que}. Me pediste que te recordara: ${i.texto}${quedan > 0 ? '' : ' (era la última vez; ya no te lo recuerdo más)'}.`;
}

/**
 * El texto de un correo nuevo en el que se buscan los temas: quién lo manda (así «cuando hable
 * con Marta» salta con un correo de Marta), el asunto y el principio del cuerpo, sin lo citado
 * («> …», que es lo que escribió Nico antes).
 */
export function textoDeCorreo(m: { from: string; subject: string; text: string }): string {
  const cuerpo = m.text
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .slice(0, 3000);
  return [m.from, m.subject, cuerpo].filter((x) => x.trim() !== '').join('\n');
}

/** Solo el nombre de «Marta López <marta@x.es>» (o la dirección si no hay nombre). */
export function remitenteCorto(from: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from);
  return (m?.[1]?.trim() || m?.[2]?.trim() || from.trim()).slice(0, 60);
}
/**
 * El texto de una cosa de la bandeja en el que se buscan los temas: lo que Nico guarda (el
 * artículo de Indra, el vídeo de la hipoteca) también es «hablar de» ese tema. Título, nota,
 * por qué importa, ideas, autor y temas; sin la URL (un dominio no es un tema).
 */
export function textoDeGuardado(item: {
  title: string | null;
  note: string | null;
  reason: string | null;
  ideas: readonly string[];
  extra: { author?: string; tags?: readonly string[] };
}): string {
  return [
    item.title,
    item.note,
    item.reason,
    ...item.ideas,
    item.extra.author,
    ...(item.extra.tags ?? []),
  ]
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .join('\n')
    .slice(0, 8000);
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

/**
 * «/intenciones», «/intenciones quitar 2», y «/intenciones olvidar 7» (el botón 🔕 del aviso:
 * el número es el id de ESA intención, no su puesto en la lista, que cambia).
 */
export function intencionesOrden(
  args: string,
): { kind: 'lista' } | { kind: 'quitar'; n: number } | { kind: 'olvidar'; id: number } | null {
  const a = args.trim();
  if (!a || /^(?:lista|ver)$/i.test(a)) return { kind: 'lista' };
  const o = /^olvidar\s+(\d{1,6})$/i.exec(a);
  if (o) return { kind: 'olvidar', id: Number(o[1]) };
  const m = /^(?:quitar|quita|borrar|borra|olvida)\s+(\d{1,2})$/i.exec(a);
  return m ? { kind: 'quitar', n: Number(m[1]) } : null;
}

/** Etiqueta del botón del aviso que la quita para siempre. */
export const OLVIDAR_LABEL = '🔕 No me lo recuerdes más';

/**
 * Lo que hace un mensaje del dueño (escrito o la transcripción de su nota de voz) con los
 * recordatorios por tema: si ES uno nuevo, lo apunta (y no hay que contestar nada más); si
 * no, devuelve los que nombra para avisarle. `crear: false` (algo reenviado: no lo dijo él)
 * solo avisa.
 */
export function atenderIntenciones(
  store: IntencionesStore,
  chat: string,
  text: string,
  now: number,
  opts: { crear?: boolean } = {},
): { creada: Intencion | 'lleno' | null; avisos: Intencion[] } {
  const nueva = opts.crear === false ? null : intencionIntent(text);
  if (nueva) return { creada: store.crear(chat, nueva.claves, nueva.texto, now), avisos: [] };
  return { creada: null, avisos: store.disparar(chat, text, now) };
}
