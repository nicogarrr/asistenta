/**
 * /funciones: todo lo que sabe hacer Asistenta, agrupado por áreas y con un
 * ejemplo en español de cada una.
 *
 * No es una lista escrita a mano aparte: los comandos y sus descripciones salen
 * del catálogo único de /help (HELP_SECTIONS, que un test ata al menú de
 * Telegram y a la tabla de comandos del daemon). Aquí solo se decide a qué área
 * va cada sección del catálogo (por palabras clave del título, con unas pocas
 * excepciones por comando) y qué comandos son solo del dueño. Un comando nuevo
 * en /help aparece en /funciones sin tocar este fichero.
 *
 * Quién ve qué: el dueño en su chat privado ve todo; en otro chat (o otro
 * usuario autorizado) solo salen los comandos que ahí funcionan, y las áreas que
 * se quedan sin ninguno no se enseñan.
 */
import { HELP_SECTIONS, type HelpEntry } from './channels/telegram-help.js';

export type FuncionAreaId =
  | 'tele'
  | 'pc'
  | 'audio'
  | 'agenda'
  | 'correo'
  | 'investigar'
  | 'compras'
  | 'memoria'
  | 'modelo'
  | 'sistema'
  | 'gimnasio';

export interface FuncionArea {
  id: FuncionAreaId;
  /** Título con emoji, también etiqueta del botón. */
  title: string;
  /** Qué hace el área, en una frase. */
  summary: string;
  /** Un ejemplo de cómo pedirlo, en español y en una línea. */
  example: string;
}

/** Orden de las áreas en /funciones y en los botones. */
export const FUNCION_AREAS: readonly FuncionArea[] = [
  {
    id: 'tele',
    title: '📺 Tele',
    summary: 'enciende, apaga, volumen, canales y apps de la tele',
    example: '«pon la uno» · «baja a la mitad» · «abre Netflix»',
  },
  {
    id: 'pc',
    title: '🖥️ PC',
    summary: 've tu pantalla y usa el ordenador por ti (pide permiso antes de tocar)',
    example: '«hazme una captura» · «abre el Excel de gastos y súmame la columna B»',
  },
  {
    id: 'audio',
    title: '🔊 Audio y voz',
    summary: 'notas de voz, altavoz del PC o de la tele y palabra de activación',
    example: '«reprodúcelo en la tele» · mándame una nota de voz',
  },
  {
    id: 'agenda',
    title: '⏰ Agenda y recordatorios',
    summary: 'recordatorios, calendario, rutinas y resumen del día',
    example: '«recuérdame el viernes a las 10 pagar el alquiler»',
  },
  {
    id: 'correo',
    title: '✉️ Correo y avisos',
    summary: 'lee y resume el correo, avisa de lo importante',
    example: '«¿tengo algo importante en el correo?»',
  },
  {
    id: 'investigar',
    title: '🔎 Investigar',
    summary: 'busca, compara y lee documentos por ti',
    example: '/investiga mejor robot aspirador por menos de 300 €',
  },
  {
    id: 'compras',
    title: '🛒 Compras y vigilantes',
    summary: 'precios, comparativas y avisos cuando algo baja',
    example: '«avísame si esta tele baja de 500 €» + enlace',
  },
  {
    id: 'memoria',
    title: '🧠 Memoria y proyectos',
    summary: 'lo que recuerdo de ti, temas y carpetas de proyecto',
    example: '«recuerda que mi talla de camiseta es la M»',
  },
  {
    id: 'modelo',
    title: '🤖 Modelo',
    summary: 'qué modelo responde, repetir o resumir la conversación',
    example: '/reintentar · /compactar',
  },
  {
    id: 'sistema',
    title: '⚙️ Sistema',
    summary: 'estado, permisos, consumo y parar lo que esté en marcha',
    example: '/estado · /stop',
  },
  {
    id: 'gimnasio',
    title: '🏋️ Gimnasio',
    summary: 'tu entreno y tu peso desde openGym',
    example: '/entreno_hoy',
  },
];

/**
 * Sección de /help → área, por palabras del título (sin emoji ni mayúsculas).
 * Va en orden: gana la primera que encaja. Una sección nueva que no encaje cae
 * en «Sistema», nunca desaparece.
 */
const SECTION_RULES: ReadonlyArray<readonly [RegExp, FuncionAreaId]> = [
  [/recordatorio|agenda|rutina|automatiz/, 'agenda'],
  [/\bpc\b|ordenador|pantalla/, 'pc'],
  [/memoria/, 'memoria'],
  [/investigar|precio|documento/, 'investigar'],
  [/correo|aviso/, 'correo'],
  [/\bvoz\b|audio/, 'audio'],
  [/gimnasio|opengym/, 'gimnasio'],
];

/** Excepciones por comando: van a otra área que la de su sección. */
const COMMAND_AREA: Readonly<Record<string, FuncionAreaId>> = {
  tv: 'tele',
  altavoz: 'audio',
  mic: 'audio',
  play: 'audio',
  vigila: 'compras',
  vigilando: 'compras',
  dejar_de_vigilar: 'compras',
  precio: 'compras',
  compara: 'compras',
  modelo: 'modelo',
  reintentar: 'modelo',
  compactar: 'modelo',
  proyecto: 'memoria',
  borrar_chat: 'memoria',
  topic: 'memoria',
  topics: 'memoria',
};

/**
 * Comandos que solo atiende el dueño en su chat privado (en cli.ts empiezan con
 * `if (!isOwnerDm(...)) { …; return; }` o delegan con `isOwner`). A los demás no
 * se les enseñan. test/funciones.test.ts exige que todo handler con esa guarda
 * esté aquí.
 */
export const OWNER_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'tv',
  'ordenador',
  'altavoz',
  'modelo',
  'proyecto',
  'borrar_chat',
  'calendario',
  'perfil',
  'permisos',
  'avisos',
  'ignora',
  'ignorados',
]);

export interface FuncionCommand extends HelpEntry {
  area: FuncionAreaId;
  ownerOnly: boolean;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function areaForSection(title: string): FuncionAreaId {
  const t = normalize(title);
  for (const [re, area] of SECTION_RULES) if (re.test(t)) return area;
  return 'sistema';
}

/** Todos los comandos del catálogo de /help con su área, en el orden del catálogo. */
export function funcionCommands(): FuncionCommand[] {
  return HELP_SECTIONS.flatMap((section) => {
    const sectionArea = areaForSection(section.title);
    return section.entries.map((entry) => ({
      ...entry,
      area: COMMAND_AREA[entry.command] ?? sectionArea,
      ownerOnly: OWNER_ONLY_COMMANDS.has(entry.command),
    }));
  });
}

export interface FuncionesView {
  /** Dueño en su chat privado: lo ve todo. */
  owner: boolean;
}

function visibleCommands(view: FuncionesView): FuncionCommand[] {
  return funcionCommands().filter((c) => view.owner || !c.ownerOnly);
}

/** Áreas con al menos un comando visible para quien pregunta, en orden. */
export function visibleAreas(view: FuncionesView): FuncionArea[] {
  const used = new Set(visibleCommands(view).map((c) => c.area));
  return FUNCION_AREAS.filter((a) => used.has(a.id));
}

/** Busca un área por id, título o palabra suelta («tele», «pc», «correo»…). */
export function findArea(query: string): FuncionArea | undefined {
  const q = normalize(query.trim());
  if (!q) return undefined;
  const aliases: Readonly<Record<string, FuncionAreaId>> = {
    tv: 'tele',
    television: 'tele',
    ordenador: 'pc',
    computer: 'pc',
    pantalla: 'pc',
    voz: 'audio',
    altavoz: 'audio',
    recordatorios: 'agenda',
    calendario: 'agenda',
    mail: 'correo',
    email: 'correo',
    buscar: 'investigar',
    precios: 'compras',
    vigilantes: 'compras',
    proyectos: 'memoria',
    modelos: 'modelo',
    ajustes: 'sistema',
    gym: 'gimnasio',
  };
  const id = aliases[q] ?? q;
  return (
    FUNCION_AREAS.find((a) => a.id === id) ??
    FUNCION_AREAS.find((a) => normalize(a.title).includes(q))
  );
}

function usage(entry: HelpEntry): string {
  return entry.args ? `/${entry.command} ${entry.args}` : `/${entry.command}`;
}

export const FUNCIONES_CALLBACK_PREFIX = 'fn:';

/** Botones: uno por área visible (y «Todas» cuando se está dentro de una). */
export function funcionesButtons(
  view: FuncionesView,
  current?: FuncionAreaId,
): Array<{ label: string; action: string }> {
  const buttons = visibleAreas(view)
    .filter((a) => a.id !== current)
    .map((a) => ({ label: a.title, action: `${FUNCIONES_CALLBACK_PREFIX}${a.id}` }));
  if (current) buttons.unshift({ label: '◀ Todas', action: FUNCIONES_CALLBACK_PREFIX });
  return buttons;
}

/**
 * Texto de /funciones. Sin área: una línea por área con su ejemplo (cabe en un
 * mensaje). Con área: sus comandos con la descripción de /help.
 */
export function funcionesText(view: FuncionesView, areaQuery = ''): string {
  const areas = visibleAreas(view);
  const query = areaQuery.trim();
  if (query) {
    const area = findArea(query);
    if (!area || !areas.some((a) => a.id === area.id)) {
      return `No conozco el área «${query.slice(0, 40)}». Prueba /funciones a secas para ver todas.`;
    }
    const lines = visibleCommands(view)
      .filter((c) => c.area === area.id)
      .map((c) => `${usage(c)} — ${c.description}`);
    return [`${area.title}: ${area.summary}`, `Ejemplo: ${area.example}`, '', ...lines].join('\n');
  }
  const blocks = areas.map((a) => `${a.title} — ${a.summary}\n   Ej.: ${a.example}`);
  return [
    'Esto es lo que sé hacer. Háblame normal o usa los comandos; toca un área para ver sus comandos.',
    '',
    ...blocks,
    '',
    view.owner
      ? 'Antes de algo importante (enviar, comprar, borrar) te pido permiso con botones.'
      : 'Algunas funciones solo las usa el dueño en su chat privado.',
  ].join('\n');
}

/** Pulsación de un botón `fn:<área>` (vacío = todas). */
export function funcionesButtonText(data: string, view: FuncionesView): string {
  const id = data.startsWith(FUNCIONES_CALLBACK_PREFIX)
    ? data.slice(FUNCIONES_CALLBACK_PREFIX.length)
    : '';
  return funcionesText(view, id);
}
