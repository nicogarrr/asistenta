/**
 * «Pregúntame antes de …» (idea de Grok Bot: Auto Review con reglas propias «Ask first»).
 *
 * Grok Bot deja escribir reglas en palabras normales («ask first before sending any external
 * email») que hacen que el Bot pida permiso para esa acción aunque normalmente la haría solo.
 * Aquí, solo la mitad que es MÁS estricta (nunca se afloja nada): Nico dice «pregúntame antes
 * de usar el navegador» o `/permisos preguntar comandos` y, desde entonces, esa clase de
 * acciones le pide permiso en Telegram por encima de los «Siempre», del control total y de la
 * ventana de confianza. Lo que solo mira (una captura, leer un correo, el estado de Spotify)
 * no pregunta. Las reglas se guardan en disco y valen en todos sus chats.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setAsideCorrupt, writeFileReplacing } from './fs-tmp.js';

export type AreaId =
  | 'comandos'
  | 'navegador'
  | 'ordenador'
  | 'tele'
  | 'musica'
  | 'calendario'
  | 'correo'
  | 'archivos';

interface CallLike {
  tool: string;
  args: Record<string, unknown>;
}

const actionOf = (c: CallLike): string =>
  typeof c.args.action === 'string' ? c.args.action.toLowerCase() : '';

interface Area {
  /** Cómo se dice en la respuesta: «usar comandos en el PC». */
  label: string;
  words: RegExp;
  /** ¿Esta llamada es de esa clase y hace algo (no solo mira)? */
  match: (c: CallLike) => boolean;
}

/** Lo que solo mira: nunca pregunta, haya regla o no. */
const READS: Record<string, ReadonlySet<string>> = {
  browser: new Set(['snapshot', 'screenshot']),
  computer: new Set(['screenshot', 'move']),
  windows: new Set(['list', 'listar', 'estado']),
  tv: new Set(['estado', 'status', 'apps']),
  spotify: new Set(['estado', 'dispositivos']),
  google: new Set(['eventos_buscar', 'contacto', 'drive_buscar', 'drive_leer']),
  correo: new Set(['buscar', 'leer']),
};
const isRead = (c: CallLike): boolean => READS[c.tool]?.has(actionOf(c)) ?? false;

export const AREAS: Record<AreaId, Area> = {
  comandos: {
    label: 'ejecutar comandos o scripts en el PC',
    words: /\b(?:comandos?|[oó]rdenes|terminal|consola|shell|powershell|cmd|scripts?)\b/,
    match: (c) => c.tool === 'shell' || c.tool === 'scripts',
  },
  navegador: {
    label: 'usar el navegador (abrir, pulsar, rellenar)',
    words: /\b(?:navegador|navegar|chrome|edge|browser|formularios?|webs?|p[aá]ginas?)\b/,
    match: (c) => c.tool === 'browser' && !isRead(c),
  },
  ordenador: {
    label: 'mover el ratón o teclear en el PC',
    words:
      /\b(?:rat[oó]n|teclado|teclear|clics?|pinchar|escritorio|computer use|control del (?:pc|ordenador)|ventanas?)\b/,
    match: (c) => (c.tool === 'computer' || c.tool === 'windows') && !isRead(c),
  },
  tele: {
    label: 'tocar la tele',
    words: /\b(?:tele|televisi[oó]n|tv)\b/,
    match: (c) => c.tool === 'tv' && !isRead(c),
  },
  musica: {
    label: 'poner o cambiar música en Spotify',
    words: /\b(?:spotify|m[uú]sica|canci[oó]n(?:es)?|playlists?)\b/,
    match: (c) => c.tool === 'spotify' && !isRead(c),
  },
  calendario: {
    label: 'crear o cambiar cosas en tu calendario',
    words: /\b(?:calendario|agenda|eventos?|citas?|reuniones?)\b/,
    match: (c) => (c.tool === 'google' && !isRead(c)) || c.tool === 'agenda',
  },
  correo: {
    label: 'hacer algo con tu correo',
    words: /\b(?:correos?|e-?mails?|mails?|gmail)\b/,
    match: (c) => c.tool === 'correo' && !isRead(c),
  },
  archivos: {
    label: 'escribir o cambiar archivos',
    words: /\b(?:archivos?|ficheros?|carpetas?)\b/,
    match: (c) => c.tool === 'write' || c.tool === 'edit',
  },
};

export interface AskFirstRule {
  id: number;
  area: AreaId;
  /** Lo que dijo Nico, tal cual (para enseñárselo y en la pregunta). */
  dicho: string;
  createdAt: string;
  /**
   * Solo en este chat (su chatKey). Sin él vale en todos los hilos, como hasta ahora.
   * Dicha en un grupo, la regla es de ese grupo salvo «en todos los chats».
   */
  chat?: string;
}

/** Dónde se pidió la regla: el chat y si es un grupo (en un grupo la regla es de ese grupo). */
export interface AskFirstWhere {
  chat: string;
  group: boolean;
}

/** «… aquí», «… en este grupo», «… en todos los chats»: lo que dice dónde vale. */
const SCOPE_HERE =
  /[,\s]+(?:(?:solo|s[oó]lo|solamente|[uú]nicamente)\s+)?(?:aqu[ií]|ac[aá]|en este (?:chat|grupo|hilo)|en esta conversaci[oó]n)$/iu;
const SCOPE_ALL =
  /[,\s]+(?:en todos (?:los )?(?:chats|grupos|sitios|lados)|en todas partes|en cualquier (?:chat|sitio|lado)|siempre y en todos lados)$/iu;

/**
 * Separa «usar el navegador en este grupo» en lo que es («usar el navegador») y dónde vale:
 * 'aqui' (este chat), 'todos' (todos los hilos) o null (lo de por defecto).
 */
export function splitAskFirstScope(what: string): { what: string; where: 'aqui' | 'todos' | null } {
  const t = what.trim().replace(/[.!¡]+$/u, '');
  if (SCOPE_HERE.test(t)) return { what: t.replace(SCOPE_HERE, '').trim(), where: 'aqui' };
  if (SCOPE_ALL.test(t)) return { what: t.replace(SCOPE_ALL, '').trim(), where: 'todos' };
  return { what: t, where: null };
}

/** La regla vale en esta llamada: es de todos los hilos o de este chat. */
const appliesIn = (r: AskFirstRule, chat: string | undefined): boolean =>
  r.chat === undefined || (chat !== undefined && r.chat === chat);

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Qué clases de acciones nombra la frase («antes de usar el navegador o la tele»). */
export function areasOf(text: string): AreaId[] {
  const t = fold(text);
  return (Object.keys(AREAS) as AreaId[]).filter((id) => AREAS[id].words.test(t));
}

/**
 * «pregúntame antes de usar el navegador», «pídeme permiso antes de tocar la tele», «a partir
 * de ahora consúltame antes de ejecutar comandos» → lo que va tras «antes de». null si no es eso.
 */
export function askFirstRequest(text: string): string | null {
  // En un grupo el bot solo atiende si lo mencionan, y la mención llega en el texto
  // («@asistenta_bot pregúntame antes de …»): fuera, al principio o al final (bugs-35).
  const t = text
    .trim()
    .replace(/[.!¡]+$/u, '')
    .replace(/^@[A-Za-z0-9_]{3,32}[\s,:]+/u, '')
    .replace(/[\s,]+@[A-Za-z0-9_]{3,32}$/u, '')
    .replace(/[.!¡]+$/u, '');
  const m =
    /^(?:(?:a partir de ahora|desde ahora|de ahora en adelante|siempre)[,\s]+)?(?:preg[uú]ntame|p[ií]deme permiso|cons[uú]ltame)(?:\s+siempre)?\s+antes\s+de\s+(.{3,120})$/iu.exec(
      t,
    );
  return m?.[1]?.trim() ?? null;
}

const MAX_RULES = 20;

export class AskFirstStore {
  readonly #path: string;
  readonly #now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  list(): AskFirstRule[] {
    if (!existsSync(this.#path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as unknown;
      return Array.isArray(raw)
        ? raw.filter(
            (r): r is AskFirstRule =>
              Boolean(r) &&
              typeof (r as AskFirstRule).id === 'number' &&
              typeof (r as AskFirstRule).area === 'string' &&
              (r as AskFirstRule).area in AREAS,
          )
        : [];
    } catch {
      setAsideCorrupt(this.#path);
      return [];
    }
  }

  #write(rules: AskFirstRule[]): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileReplacing(this.#path, `${JSON.stringify(rules, null, 2)}\n`);
  }

  /**
   * Añade una regla por cada clase que nombra la frase; devuelve las nuevas y las que ya había.
   * Con `chat`, solo vale en ese chat; una regla de todos los hilos ya lo cubre.
   */
  add(
    dicho: string,
    chat?: string,
  ): { added: AskFirstRule[]; already: AreaId[]; unknown: boolean } {
    const areas = areasOf(dicho);
    if (!areas.length) return { added: [], already: [], unknown: true };
    const rules = this.list();
    const added: AskFirstRule[] = [];
    const already: AreaId[] = [];
    let next = rules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    for (const area of areas) {
      if (rules.some((r) => r.area === area && (r.chat === undefined || r.chat === chat))) {
        already.push(area);
        continue;
      }
      if (rules.length >= MAX_RULES) break;
      const rule: AskFirstRule = {
        id: next++,
        area,
        dicho: dicho.trim().slice(0, 120),
        createdAt: new Date(this.#now()).toISOString(),
        ...(chat === undefined ? {} : { chat }),
      };
      // Pasa a valer en todos los hilos: las de un solo chat de esa clase sobran.
      if (chat === undefined) {
        for (let k = rules.length - 1; k >= 0; k--) {
          const old = rules[k];
          if (old && old.area === area && old.chat !== undefined) rules.splice(k, 1);
        }
      }
      rules.push(rule);
      added.push(rule);
    }
    if (added.length) this.#write(rules);
    return { added, already, unknown: false };
  }

  /**
   * Quita por número, por palabras («el navegador») o todas («todo»). Con `visible`, solo
   * entre las que se ven desde ese chat (en un grupo, las suyas y las de todos los hilos).
   */
  remove(what: string, visible?: (r: AskFirstRule) => boolean): AskFirstRule[] {
    const rules = this.list();
    const w = fold(what);
    const n = Number(w);
    const areas = areasOf(w);
    const gone = rules.filter(
      (r) =>
        (visible?.(r) ?? true) &&
        (w === 'todo' || w === 'todas'
          ? true
          : Number.isInteger(n) && n > 0
            ? r.id === n
            : areas.includes(r.area)),
    );
    if (gone.length) this.#write(rules.filter((r) => !gone.includes(r)));
    return gone;
  }

  /**
   * El motivo de la pregunta si alguna regla cubre la llamada; null si no. `chat` es el chat
   * del hilo: las reglas de otro chat no cuentan (sin él, solo las de todos los hilos).
   */
  reasonFor(call: CallLike, chat?: string): string | null {
    for (const r of this.list()) {
      if (appliesIn(r, chat) && AREAS[r.area].match(call))
        // Como el «Edit rule» de Grok Bot en su tarjeta: la pregunta dice qué regla la hizo
        // saltar y cómo quitarla, para no tener que buscarla en /permisos preguntar lista.
        return `Me pediste que te preguntara antes de ${AREAS[r.area].label}${r.chat === undefined ? '' : ' en este chat'} («${r.dicho}»). Si ya no quieres que te lo pregunte: /permisos preguntar quitar ${r.id}.`;
    }
    return null;
  }
}

const AREA_HINT =
  'comandos, navegador, ratón y teclado, tele, música, calendario, correo o archivos';

/** Dónde vale una regla, dicho para Nico desde el chat en que mira la lista. */
function scopeNote(r: AskFirstRule, where: AskFirstWhere | undefined): string {
  if (r.chat === undefined) return '';
  if (where && r.chat === where.chat) return where.group ? ' (solo en este grupo)' : ' (solo aquí)';
  return /:-\d+/.test(r.chat) ? ' (solo en un grupo)' : ' (solo en otro chat)';
}

/** Desde un grupo se ven las reglas de todos los hilos y las de ese grupo; desde el privado, todas. */
const visibleFrom =
  (where: AskFirstWhere | undefined) =>
  (r: AskFirstRule): boolean =>
    !where?.group || r.chat === undefined || r.chat === where.chat;

/**
 * La respuesta de `/permisos preguntar …` y de «pregúntame antes de …». `where` es el chat en
 * que se dice: «… aquí» / «… en este grupo» la deja solo para ese chat, y dicha en un grupo
 * es de ese grupo salvo «… en todos los chats». Sin `where`, todo vale en todos los hilos.
 */
export function runAskFirstCommand(
  store: AskFirstStore,
  args: string,
  where?: AskFirstWhere,
): string {
  const raw = args.trim();
  const sub = fold(raw.split(/\s+/)[0] ?? '');
  if (!raw || sub === 'lista' || sub === 'ver') {
    const rules = store.list().filter(visibleFrom(where));
    if (!rules.length)
      return `No tienes reglas de «pregúntame antes». Ejemplo: «pregúntame antes de usar el navegador» (o «… en este grupo» para que valga solo ahí) o /permisos preguntar comandos. Valen: ${AREA_HINT}.`;
    return [
      `Te pregunto siempre antes de (${rules.length}):`,
      ...rules.map((r) => `${r.id}. ${AREAS[r.area].label}${scopeNote(r, where)} — «${r.dicho}»`),
      'Para quitar una: /permisos preguntar quitar <número> (o «todo»).',
    ].join('\n');
  }
  if (sub === 'quitar' || sub === 'borrar' || sub === 'elimina' || sub === 'quita') {
    const what = raw.slice(raw.split(/\s+/)[0]?.length ?? 0).trim();
    if (!what) return 'Dime cuál: /permisos preguntar quitar <número> (o «todo»).';
    const gone = store.remove(what, visibleFrom(where));
    return gone.length
      ? `Vale, ya no te pregunto de más para: ${gone.map((r) => AREAS[r.area].label).join('; ')}. Lo de siempre (dinero, enviar correos, instalar) te lo sigo preguntando.`
      : 'No tengo esa regla. Las tuyas: /permisos preguntar lista.';
  }
  return askFirstAdd(store, raw, where);
}

/**
 * Apunta «pregúntame antes de <raw>». Lo que se dijo hablando entra siempre por aquí: antes
 * pasaba por runAskFirstCommand y «pregúntame antes de borrar archivos» empezaba por
 * «borrar», así que QUITABA la regla de archivos en vez de ponerla (y «antes de ver la
 * tele» enseñaba la lista).
 */
export function askFirstAdd(store: AskFirstStore, raw: string, where?: AskFirstWhere): string {
  const scope = splitAskFirstScope(raw);
  const soloAqui =
    where !== undefined && (scope.where === 'aqui' || (scope.where === null && where.group));
  const r = store.add(scope.what, soloAqui ? where.chat : undefined);
  if (r.unknown)
    return `No sé a qué acciones te refieres con «${raw}». Puedo preguntarte antes de: ${AREA_HINT}.`;
  const lines: string[] = [];
  const dondeVale = !soloAqui
    ? ''
    : where.group
      ? ' en este grupo (para todos los chats: «… en todos los chats»)'
      : ' en este chat';
  if (r.added.length)
    lines.push(
      `✅ Hecho: desde ahora te pido permiso antes de ${r.added.map((x) => AREAS[x.area].label).join(' y de ')}${dondeVale}, aunque antes me hubieras dicho «Siempre». Lo que solo mira (capturas, leer) no pregunta.`,
    );
  if (r.already.length)
    lines.push(
      `Ya te lo preguntaba antes de ${r.already.map((a) => AREAS[a].label).join(' y de ')}.`,
    );
  lines.push('Tus reglas: /permisos preguntar lista.');
  return lines.join('\n');
}

/**
 * «pregúntame antes de …» dicho hablando: la respuesta si lo apunta, null si no es eso o no
 * nombra nada que se sepa vigilar (entonces lo lleva el modelo como siempre).
 */
export function askFirstFromText(
  store: AskFirstStore,
  text: string,
  where?: AskFirstWhere,
): string | null {
  const what = askFirstRequest(text);
  if (what === null || areasOf(splitAskFirstScope(what).what).length === 0) return null;
  return askFirstAdd(store, what, where);
}
