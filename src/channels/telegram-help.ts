/**
 * Textos de /start y /help del bot de Telegram.
 *
 * Antes /help era una lista plana de 40 líneas sin orden, repetía «/screen live» y se
 * olvidaba de comandos que el bot sí atiende y que el propio menú ofrecía (/memoria,
 * /exportar, /perfil, /skills, /calendario, /precio, /compara, /correo…). /start
 * mandaba exactamente lo mismo, así que el primer mensaje del bot era un muro.
 *
 * Ahora hay un único catálogo agrupado por temas: /help lo pinta por secciones y
 * /start da una bienvenida corta con ejemplos. Un test exige que todo comando del menú
 * de Telegram salga en /help y que todo comando de /help exista en el despachador.
 *
 * Texto plano a propósito: el canal envía sin parse_mode, así que nada aquí necesita
 * escape y nada se rompe si una descripción lleva «_» o «*».
 */

export interface HelpEntry {
  /** Comando sin barra, tal y como lo atiende el despachador. */
  command: string;
  /** Argumentos opcionales, ya con su notación ([opcional], <obligatorio>). */
  args?: string;
  description: string;
}

export interface HelpSection {
  title: string;
  entries: HelpEntry[];
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    title: '⚡ Lo básico',
    entries: [
      { command: 'stop', description: 'para todo lo que esté en marcha' },
      {
        command: 'steer',
        args: '<instrucción>',
        description: 'corrige lo que estoy haciendo sin pararlo',
      },
      {
        command: 'btw',
        args: '<pregunta>',
        description: 'pregunta rápida sin parar lo que hago',
      },
      {
        command: 'compra',
        args: '[cosas]',
        description: 'lista de la compra con botones para tachar',
      },
      { command: 'estado', description: 'cómo estoy: herramientas y errores de hoy' },
      {
        command: 'funciones',
        args: '[área]',
        description: 'todo lo que sé hacer, por áreas y con ejemplos',
      },
      { command: 'status', args: 'on|off', description: 'avisos de cómo voy mientras trabajo' },
      { command: 'topic', args: '<nombre>', description: 'abre o cambia de conversación' },
      { command: 'topics', description: 'conversaciones abiertas' },
      { command: 'reintentar', description: 'repite tu último mensaje sin la respuesta anterior' },
      { command: 'compactar', description: 'resume ya el historial de esta conversación' },
      {
        command: 'modelo',
        args: '[número|nombre|normal]',
        description: 've o cambia el modelo',
      },
      {
        command: 'borrar_chat',
        description: 'borra memoria, historial y perfil (pide escribir BORRAR)',
      },
      {
        command: 'proyecto',
        args: '<carpeta>|quitar',
        description: 'liga una carpeta (su ASISTENTA.md)',
      },
    ],
  },
  {
    title: '⏰ Recordatorios y agenda',
    entries: [
      {
        command: 'recordatorios',
        args: '[borrar <n>]',
        description: 'tus recordatorios y cuándo suenan',
      },
      { command: 'pendientes', description: 'lo que te tengo que recordar' },
      { command: 'resolver', args: '<id>', description: 'marca un pendiente como resuelto' },
      { command: 'agenda', description: 'calendario, pendientes, rutinas y objetivos' },
      {
        command: 'previsto',
        args: '[hoy|semana]',
        description: 'lo que haré por ti, por hora: recordatorios, rutinas y la bandeja',
      },
      {
        command: 'calendario',
        args: 'add <fecha> <hora> | <título>',
        description: 'añade un evento',
      },
      { command: 'resumen', args: '[hoy]', description: 'lo que he hecho esta semana o hoy' },
    ],
  },
  {
    title: '🔁 Rutinas y automatización',
    entries: [
      {
        command: 'learn',
        args: '<nombre> · /learn end',
        description: 'aprende una rutina de lo que hagamos',
      },
      { command: 'routine', args: '<nombre>', description: 'repite o programa una rutina' },
      { command: 'routines', description: 'rutinas guardadas' },
      {
        command: 'cron',
        args: '[add|del|entrega]',
        description: 'programa, pausa, prueba o borra rutinas',
      },
      {
        command: 'disparador',
        args: '<mensaje|archivo|precio> …',
        description: 'lanza una rutina cuando pasa algo',
      },
      { command: 'disparadores', description: 'disparadores activos' },
      { command: 'scripts', args: '[aprobar]', description: 'tus scripts del PC en eventos' },
    ],
  },
  {
    title: '🖥️ Tu PC',
    entries: [
      {
        command: 'tv',
        args: '[orden]',
        description: 'orden a la tele; sin orden, mando con botones',
      },
      {
        command: 'ordenador',
        args: '[on|off]',
        description: 'encender o apagar el control del PC',
      },
      { command: 'screen', args: '[live|off]', description: 'captura ahora o foto en directo' },
      {
        command: 'watch',
        args: '[segundos [fps]]',
        description: 'graba la pantalla y te mando el vídeo',
      },
      {
        command: 'camera',
        args: '[on|off|clip|av]',
        description: 'foto, directo o vídeo de la cámara',
      },
      { command: 'mic', args: '[segundos]', description: 'graba lo que oye el micrófono' },
      {
        command: 'play',
        args: '[volumen]',
        description: 'suena en el PC el último audio que me mandaste',
      },
      {
        command: 'altavoz',
        args: '[pc|tele|off]',
        description: 'tus notas de voz suenan solas al llegar',
      },
      { command: 'spotify', args: '[conectar]', description: 'tu Spotify; o «pon …»' },
      { command: 'deshacer', description: 'repone el último fichero que escribí' },
    ],
  },
  {
    title: '🧠 Memoria',
    entries: [
      { command: 'memory', description: 'lo que recuerdo de esta conversación' },
      {
        command: 'memoria',
        args: '[buscar|olvidar|exportar|importar]',
        description: 'tus recuerdos',
      },
      { command: 'buscar', args: '<texto>', description: 'busca en conversaciones pasadas' },
      { command: 'perfil', args: '[guardar|olvidar]', description: 'tu perfil estructurado' },
      { command: 'aprendido', description: 'lo aprendido de tus correcciones' },
      { command: 'obsidian', description: 'ver y editar mi memoria en Obsidian (PC e iPhone)' },
      { command: 'olvida', args: '<n>', description: 'borra una' },
      { command: 'exportar', description: 'esta conversación en JSON' },
    ],
  },
  {
    title: '🔎 Investigar, precios y documentos',
    entries: [
      {
        command: 'bandeja',
        args: '[enlace|ver N|resumen|hora 22:00]',
        description: 'lo que guardas a secas: cada noche 🔴 entero · 🟡 basta el resumen · ⚪ paja',
      },
      {
        command: 'kindle',
        args: '<N|enlace> [pdf]',
        description: 'el texto entero de algo para leer, en EPUB/AZW3 para el Kindle',
      },
      {
        command: 'investiga',
        args: '[amplio] <pregunta> [| a, b, c]',
        description: 'informe a fondo con fuentes; «amplio» = tabla',
      },
      { command: 'vigila', args: '<enlace> [nombre]', description: 'te aviso si cambia el precio' },
      { command: 'vigilando', description: 'lo que estoy vigilando' },
      { command: 'vigilancias', description: 'todo lo que vigilo: páginas, precios, rutinas' },
      { command: 'dejar_de_vigilar', args: '<id>', description: 'deja de vigilar una página' },
      { command: 'precio', description: 'histórico de precio de algo vigilado' },
      { command: 'precios', args: '[on|off]', description: 'errores de precio en Amazon.es' },
      { command: 'compara', args: '<enlace>', description: 'el mismo producto en 7 tiendas' },
      {
        command: 'ocr',
        args: '[md|todo]',
        description: 'pie de un PDF o foto: texto seleccionable',
      },
      { command: 'expertos', description: 'apuntes por tema' },
      {
        command: 'biblioteca',
        args: '[pdf|excel|word|graficas] [N]',
        description: 'lo que te he hecho (gráficas, Excel, PDF…): te lo vuelvo a mandar',
      },
    ],
  },
  {
    title: '🔔 Avisos y correo',
    entries: [
      { command: 'ojo', args: '[on|off]', description: 'avisos proactivos' },
      {
        command: 'avisos',
        args: '[menos|minimo|normal]',
        description: 'ritmo de avisos del filtro',
      },
      { command: 'ignora', args: '<n>', description: 'descarta un aviso' },
      { command: 'ignorados', description: 'reglas de avisos ignorados' },
      {
        command: 'correo',
        args: '[estado|lista|responder]',
        description: 'últimos correos y responder',
      },
    ],
  },
  {
    title: '🎙️ Voz',
    entries: [
      { command: 'voice', args: 'on|off', description: 'contestarte con voz' },
      { command: 'wake', args: 'on|off', description: 'escuchar mi nombre en el micrófono' },
      {
        command: 'conversacion',
        args: 'on|off|estado|corte',
        description: 'hablar sin repetir mi nombre',
      },
    ],
  },
  {
    title: '⚙️ Ajustes y sistema',
    entries: [
      {
        command: 'permisos',
        args: '[lista|revocar …]',
        description: 'los permisos «siempre» que me diste',
      },
      { command: 'consumo', args: '[hoy|semana|mes]', description: 'tokens y coste estimado' },
      { command: 'servicios', description: 'herramientas externas adoptadas y su estado' },
      { command: 'mcp', description: 'recursos MCP' },
      {
        command: 'skills',
        args: 'buscar <texto> | instalar <url>',
        description: 'busca o instala una skill',
      },
      {
        command: 'evolucion',
        args: '[idea <texto>|ahora|revisar]',
        description: 'la auto-mejora semanal',
      },
      {
        command: 'actualizacion',
        description: 'si me actualizo sola desde main',
      },
      {
        command: 'actualizar',
        description: 'me actualizo ahora a la última versión (y vuelvo atrás si falla)',
      },
      {
        command: 'pausa_pc',
        description: 'paro todo lo del PC (menos este chat) hasta que pulses Levantar',
      },
      {
        command: 'levantar',
        description: 'vuelvo a arrancar todo lo del PC tras /pausa_pc',
      },
      {
        command: 'google',
        args: '[conectar]',
        description: 'tu Google: calendario, contactos y Drive',
      },
      { command: 'tailscale', description: 'si el panel y la voz van desde el móvil' },
      { command: 'panel', description: 'el panel dentro de Telegram (con Tailscale)' },
      { command: 'voz', description: 'hablar conmigo desde el móvil (con Tailscale)' },
      { command: 'atajos', description: 'Siri, botón de acción y Compartir en el iPhone' },
      {
        command: 'iphone',
        args: 'diagnostico',
        description: 'si puedo ver y tocar tu iPhone (experimental)',
      },
    ],
  },
  {
    title: '🏋️ Gimnasio (openGym)',
    entries: [
      { command: 'entreno_hoy', description: 'el entreno de hoy' },
      { command: 'ultimo', description: 'el último entreno' },
      { command: 'peso', description: 'tu peso' },
    ],
  },
];

/** Todos los comandos que /help documenta, sin barra. */
export function helpCommands(): string[] {
  return HELP_SECTIONS.flatMap((section) => section.entries.map((entry) => entry.command));
}

const HELP_INTRO =
  'Háblame normal: entiendo frases como «recuérdame mañana a las 9 llamar al médico» o «apaga la tele». Los comandos son atajos.';

function sectionBlock(section: HelpSection, bold: boolean): string {
  const lines = section.entries.map((entry) => {
    const usage = entry.args ? `/${entry.command} ${entry.args}` : `/${entry.command}`;
    return `${usage} — ${entry.description}`;
  });
  return [bold ? `**${section.title}**` : section.title, ...lines].join('\n');
}

/**
 * /help entera, en un solo texto: secciones con título y una línea por comando. Con `bold`,
 * los títulos van entre `**` para enviarse con format 'marks' (negrita real en Telegram); el
 * resto no lleva marcas, así que nada más cambia de aspecto. Lo que se envía es `helpPages`.
 */
export function helpText(opts: { bold?: boolean } = {}): string {
  return [HELP_INTRO, ...HELP_SECTIONS.map((s) => sectionBlock(s, opts.bold === true))].join(
    '\n\n',
  );
}

/** Caracteres por página de /help (Telegram corta a 4096; queda sitio para el pie). */
export const HELP_PAGE_CHARS = 3600;

const len = (s: string): number => Array.from(s).length;

/**
 * /help en páginas que caben en un mensaje de Telegram. Antes era un solo mensaje y estaba a
 * 3987 de 4000 caracteres: un comando nuevo (/latido, /temas, /expertos…) ya no cabía. Las
 * secciones van enteras y en orden; cada página menos la última acaba con «/help 2» (o el
 * número que toque) para seguir.
 */
export function helpPages(opts: { bold?: boolean } = {}): string[] {
  const bold = opts.bold === true;
  // Los cortes se miden sobre el texto SIN marcas: así /help con negritas y sin ellas se
  // parten igual (antes, una sección más hacía que las «**» movieran el corte de página).
  const pages: string[][] = [[HELP_INTRO]];
  const plain: string[][] = [[HELP_INTRO]];
  for (const section of HELP_SECTIONS) {
    const block = sectionBlock(section, bold);
    const plainBlock = sectionBlock(section, false);
    const page = pages[pages.length - 1] as string[];
    const plainPage = plain[plain.length - 1] as string[];
    if (plainPage.length > 0 && len([...plainPage, plainBlock].join('\n\n')) > HELP_PAGE_CHARS) {
      pages.push([block]);
      plain.push([plainBlock]);
    } else {
      page.push(block);
      plainPage.push(plainBlock);
    }
  }
  const total = pages.length;
  return pages.map((blocks, i) => {
    const head = i === 0 ? [] : [`Ayuda (${i + 1}/${total})`];
    const foot = i < total - 1 ? [`Más comandos: /help ${i + 2}`] : [];
    return [...head, ...blocks, ...foot].join('\n\n');
  });
}

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/**
 * Lo que contesta «/help <algo>»: «/help 2», «/help más» (la página siguiente) o «/help
 * vigila» (los comandos que hablan de eso, con su sección). Sin nada, la primera página.
 */
export function helpReply(args: string, opts: { bold?: boolean } = {}): string {
  const pages = helpPages(opts);
  const want = fold(args).replace(/^\/+/, '');
  if (!want) return pages[0] as string;
  if (/^(?:mas|\+|siguiente|sigue|resto)$/.test(want))
    return pages[Math.min(1, pages.length - 1)] as string;
  if (/^\d{1,2}$/.test(want)) {
    const n = Math.min(Math.max(Number(want), 1), pages.length);
    return pages[n - 1] as string;
  }
  const hits: string[] = [];
  for (const section of HELP_SECTIONS) {
    const found = section.entries.filter(
      (e) => fold(e.command).includes(want) || fold(e.description).includes(want),
    );
    if (found.length)
      hits.push(sectionBlock({ title: section.title, entries: found }, opts.bold === true));
  }
  if (!hits.length)
    return `No tengo comandos con «${args.trim()}». Pídemelo con tus palabras, o mira /funciones para ver lo que sé hacer. Todos los comandos: /help`;
  return hits.join('\n\n');
}

/** /start: bienvenida corta (saludo, cómo usarla, permisos), en vez del muro de /help. */
export function startText(displayName?: string): string {
  const name = displayName?.trim().split(/\s+/)[0];
  return [
    name ? `¡Hola, ${name}! Soy tu asistente.` : '¡Hola! Soy tu asistente.',
    'Escríbeme o mándame una nota de voz como a una persona; /help tiene todo lo que sé hacer.',
    'Antes de hacer algo importante (enviar, comprar, borrar) te pido permiso.',
  ].join('\n');
}

/** Un /start repetido en menos de esto (o que llega tarde, al arrancar) no se vuelve a contestar. */
export const START_REPEAT_WINDOW_MS = 5 * 60_000;
const START_STALE_MS = 2 * 60_000;
const lastStartAt = new Map<string, number>();

/**
 * ¿Toca mandar la bienvenida? No si ya se mandó a este chat hace menos de 5 min ni
 * si el /start es de hace más de 2 min (Telegram lo guardó con Asistenta apagada y
 * lo entrega al arrancar). Así la bienvenida no sale dos veces seguidas.
 */
export function startWelcomeDue(chatKey: string, now: number, sentAt?: string): boolean {
  const sent = sentAt ? Date.parse(sentAt) : Number.NaN;
  if (Number.isFinite(sent) && now - sent > START_STALE_MS) return false;
  const last = lastStartAt.get(chatKey);
  if (last !== undefined && now - last >= 0 && now - last < START_REPEAT_WINDOW_MS) return false;
  lastStartAt.set(chatKey, now);
  if (lastStartAt.size > 100) lastStartAt.delete(lastStartAt.keys().next().value as string);
  return true;
}
