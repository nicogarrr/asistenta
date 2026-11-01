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
import { threadAllowToolNames } from './core/capabilities.js';

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
  | 'casa'
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
    id: 'casa',
    title: '🏠 Casa',
    summary: 'luces, enchufes y ventiladores de tu Home Assistant (encender pregunta)',
    example: '«enciende la luz del salón» · «¿qué luces hay encendidas?»',
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
  [/casa|hogar|domótica|luces/, 'casa'],
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

/**
 * Lo que sé hacer sin comando, en palabras llanas: una línea por herramienta
 * real del asistente (el nombre que ve el modelo). `null` = herramienta interna
 * que no es una función para el usuario (terminar un turno, cargar otras…).
 * `test/funciones-capacidades.test.ts` exige una entrada por cada herramienta de
 * src/tools y del catálogo de capacidades, y ninguna de más.
 */
export const TOOL_ABILITIES: Readonly<
  Record<string, { area: FuncionAreaId; text: string } | null>
> = {
  tv: {
    area: 'tele',
    text: 'enciendo, apago, cambio de canal, subo el volumen o abro apps de la tele',
  },
  computer: { area: 'pc', text: 'uso el ratón y el teclado de tu PC por ti, con tu permiso' },
  windows: { area: 'pc', text: 'miro qué ventanas tienes abiertas y dónde pulsar' },
  system: { area: 'pc', text: 'bloqueo, suspendo o ajusto el volumen y el brillo del PC' },
  ocr: { area: 'pc', text: 'leo el texto que hay en la pantalla o en una imagen' },
  shell: { area: 'pc', text: 'ejecuto comandos en tu PC, con tu permiso' },
  read: { area: 'pc', text: 'leo ficheros de tu PC' },
  list: { area: 'pc', text: 'te digo qué hay en una carpeta' },
  write: { area: 'pc', text: 'creo o cambio ficheros, con tu permiso' },
  iphone: { area: 'pc', text: 'hago cosas en tu iPhone a través del puente de casa' },
  ocr_local: {
    area: 'pc',
    text: 'leo el texto de fotos y PDF escaneados con el OCR local, si lo activas',
  },
  media: { area: 'audio', text: 'grabo y reproduzco audio, hago fotos y uso la cámara o el micro' },
  download: { area: 'audio', text: 'descargo un vídeo, un PDF o solo el audio de un enlace' },
  reminder: { area: 'agenda', text: 'te recuerdo cosas a la hora que digas' },
  agenda: { area: 'agenda', text: 'te digo qué tienes hoy: recordatorios, rutinas y seguimientos' },
  calendar: { area: 'agenda', text: 'leo tu calendario (no lo cambio)' },
  correo: {
    area: 'correo',
    text: 'busco y leo tus correos; respondo, reenvío o escribo solo si apruebas el borrador exacto',
  },
  tareas: { area: 'agenda', text: 'apunto tus tareas de la semana y te digo qué tienes' },
  repartos: {
    area: 'agenda',
    text: 'te digo dónde están tus paquetes leyendo los correos de envío',
  },
  tiempo: { area: 'agenda', text: 'te digo el tiempo de hoy a 7 días donde vives' },
  luz: { area: 'agenda', text: 'te digo las horas más baratas de la luz, hoy y mañana' },
  cuentas: {
    area: 'agenda',
    text: 'guardo tus cuentas y contraseñas fuertes en un gestor cifrado',
  },
  correo_reglas: {
    area: 'correo',
    text: 'resumo tu correo por tipos (publicidad, avisos, estafas) y guardo tus reglas de correo',
  },
  objetivo: { area: 'agenda', text: 'persigo un objetivo varios días y te aviso de los avances' },
  gestion: {
    area: 'agenda',
    text: 'llevo un trámite paso a paso y te pregunto antes de ejecutarlo',
  },
  web: { area: 'investigar', text: 'busco en internet' },
  fetch: { area: 'investigar', text: 'leo la página que me pases' },
  browser: { area: 'investigar', text: 'navego por webs y relleno formularios' },
  delegate: { area: 'investigar', text: 'reparto búsquedas largas entre ayudantes que solo leen' },
  book: { area: 'investigar', text: 'busco y descargo libros de dominio público' },
  documents: { area: 'investigar', text: 'guardo tus documentos y busco dentro de ellos' },
  renfe: { area: 'investigar', text: 'busco trenes de Renfe con horario y precio' },
  casa: {
    area: 'casa',
    text: 'enciendo, apago o miro luces, enchufes y ventiladores de tu Home Assistant',
  },
  vigilar_precio: { area: 'compras', text: 'vigilo el precio de un producto y te aviso si baja' },
  checkout: { area: 'compras', text: 'preparo una compra y te pido permiso antes de pagar' },
  memory: { area: 'memoria', text: 'recuerdo datos tuyos y los uso cuando hacen falta' },
  decision: { area: 'memoria', text: 'apunto lo que decides en cada proyecto' },
  opengym: { area: 'gimnasio', text: 'miro tu rutina, tu último entreno y tu peso' },
  skills: { area: 'sistema', text: 'aprendo procedimientos nuevos y los mejoro' },
  fabrica: { area: 'sistema', text: 'me fabrico herramientas nuevas, que tú apruebas' },
  servicio: {
    area: 'sistema',
    text: 'propongo instalar programas de código abierto, con tu permiso',
  },
  done: null,
  preguntar: null,
  cargar_herramienta: null,
};

/**
 * Líneas «sin comando» de un área. Fuera del chat privado del dueño solo salen
 * las herramientas que funcionan en cualquier conversación sin aprobación.
 */
export function areaAbilities(view: FuncionesView, area: FuncionAreaId): string[] {
  const open = view.owner ? undefined : new Set(threadAllowToolNames());
  const seen = new Set<string>();
  for (const [tool, ability] of Object.entries(TOOL_ABILITIES)) {
    if (!ability || ability.area !== area) continue;
    if (open && !open.has(tool)) continue;
    seen.add(ability.text);
  }
  return [...seen];
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
  return FUNCION_AREAS.filter((a) => used.has(a.id) || areaAbilities(view, a.id).length > 0);
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
/** Solo el dueño, en «⚙️ Sistema»: qué mirar si Asistenta no arranca en el PC. */
const ARRANQUE_TIPS = [
  '¿No arranca o va rara?',
  '• En el PC: «pa iniciar --solo-comprobar» repasa todo en verde/rojo con el arreglo de cada fallo',
  '• «pa autostart status»: cómo fue el último arranque y qué hizo el vigilante',
  '• Desde aquí: /estado',
];

export function funcionesText(view: FuncionesView, areaQuery = ''): string {
  const areas = visibleAreas(view);
  const query = areaQuery.trim();
  if (query) {
    const area = findArea(query);
    if (!area || !areas.some((a) => a.id === area.id)) {
      return [
        `No conozco el área «${query.slice(0, 40)}». Tengo estas:`,
        ...areas.map((a) => a.title),
      ].join('\n');
    }
    const lines = visibleCommands(view)
      .filter((c) => c.area === area.id)
      .map((c) => `${usage(c)} — ${c.description}`);
    const abilities = areaAbilities(view, area.id).map((t) => `• ${t}`);
    const out = [`${area.title}: ${area.summary}`, `Ejemplo: ${area.example}`];
    if (abilities.length > 0) out.push('', 'Pídemelo con tus palabras:', ...abilities);
    if (lines.length > 0) out.push('', 'Comandos:', ...lines);
    if (area.id === 'sistema' && view.owner) out.push('', ...ARRANQUE_TIPS);
    return out.join('\n');
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
