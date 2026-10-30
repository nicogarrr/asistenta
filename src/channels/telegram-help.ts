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
      { command: 'estado', description: 'cómo estoy: herramientas y errores de hoy' },
      { command: 'status', args: 'on|off', description: 'avisos de cómo voy mientras trabajo' },
      { command: 'topic', args: '<nombre>', description: 'abre o cambia de conversación' },
      { command: 'topics', description: 'conversaciones abiertas' },
      { command: 'reintentar', description: 'repite tu último mensaje sin la respuesta anterior' },
      { command: 'compactar', description: 'resume ya el historial de esta conversación' },
      {
        command: 'proyecto',
        args: '<carpeta>|quitar',
        description: 'liga una carpeta: su ASISTENTA.md entra en el contexto',
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
        description:
          'programa, pausa, prueba o borra rutinas; «entrega» decide si su salida va al chat, a un fichero o a ninguno',
      },
      {
        command: 'disparador',
        args: '<mensaje|archivo|precio> …',
        description: 'lanza una rutina cuando pasa algo',
      },
      { command: 'disparadores', description: 'disparadores activos' },
    ],
  },
  {
    title: '🖥️ Tu PC',
    entries: [
      { command: 'tv', args: '<orden>', description: 'orden directa a la tele, sin gastar tokens' },
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
      { command: 'deshacer', description: 'repone el último fichero que escribí' },
    ],
  },
  {
    title: '🧠 Memoria',
    entries: [
      { command: 'memory', description: 'lo que recuerdo de esta conversación' },
      {
        command: 'memoria',
        args: '[buscar|olvidar|exportar]',
        description: 'ver, buscar u olvidar recuerdos',
      },
      { command: 'buscar', args: '<texto>', description: 'busca en conversaciones pasadas' },
      { command: 'perfil', args: '[guardar|olvidar]', description: 'tu perfil estructurado' },
      { command: 'exportar', description: 'esta conversación en JSON' },
    ],
  },
  {
    title: '🔎 Investigar, precios y documentos',
    entries: [
      {
        command: 'investiga',
        args: '[amplio] <pregunta> [| a, b, c]',
        description: 'informe a fondo con fuentes citadas; «amplio» = tabla por elemento',
      },
      { command: 'vigila', args: '<enlace> [nombre]', description: 'te aviso si cambia el precio' },
      { command: 'vigilando', description: 'lo que estoy vigilando' },
      { command: 'dejar_de_vigilar', args: '<id>', description: 'deja de vigilar una página' },
      { command: 'precio', description: 'histórico de precio de algo vigilado' },
      { command: 'compara', args: '<enlace>', description: 'el mismo producto en 7 tiendas' },
      {
        command: 'ocr',
        args: '[md|todo]',
        description: 'como pie de un PDF o foto: texto seleccionable',
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
        description: 'estado del correo, últimos mensajes y responder',
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
        args: '[revocar <herramienta>|todo]',
        description: 'los permisos «siempre» que me diste',
      },
      { command: 'consumo', args: '[hoy|semana|mes]', description: 'tokens y coste estimado' },
      { command: 'servicios', description: 'herramientas externas adoptadas y su estado' },
      { command: 'skills', args: 'instalar <url>', description: 'instala una skill' },
      { command: 'evolucion', args: '[idea <texto>|ahora]', description: 'la auto-mejora semanal' },
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

/** /help: secciones con título y una línea por comando. */
export function helpText(): string {
  const blocks = HELP_SECTIONS.map((section) => {
    const lines = section.entries.map((entry) => {
      const usage = entry.args ? `/${entry.command} ${entry.args}` : `/${entry.command}`;
      return `${usage} — ${entry.description}`;
    });
    return [section.title, ...lines].join('\n');
  });
  return [
    'Háblame normal: entiendo frases como «recuérdame mañana a las 9 llamar al médico» o «apaga la tele». Los comandos son atajos.',
    ...blocks,
  ].join('\n\n');
}

/** /start: bienvenida corta, con ejemplos, en vez del muro de /help. */
export function startText(displayName?: string): string {
  const name = displayName?.trim().split(/\s+/)[0];
  return [
    name ? `¡Hola, ${name}! Soy tu asistente.` : '¡Hola! Soy tu asistente.',
    'Escríbeme o mándame una nota de voz como a una persona. Por ejemplo:',
    '• «Recuérdame el viernes a las 10 pagar el alquiler»',
    '• «Mira el precio de esta tele y avísame si baja» + enlace',
    '• «Hazme una captura de la pantalla»',
    'Antes de hacer algo importante (enviar, comprar, borrar) te pido permiso con botones.',
    'Toca el botón Menú o escribe /help para ver todos los comandos.',
  ].join('\n');
}
