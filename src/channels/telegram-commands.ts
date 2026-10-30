/**
 * Canonical commands only; aliases stay accepted by the dispatcher.
 *
 * ORDENADO POR USO: Telegram enseña el menú en este orden y solo caben unas pocas
 * líneas en pantalla, así que lo diario (parar, recordatorios, agenda, correo…) va
 * primero y /start, que solo se usa la primera vez, al final. Todo comando de aquí
 * debe tener su línea en telegram-help.ts (test/telegram-help.test.ts).
 */
export const TELEGRAM_COMMANDS = [
  // Día a día: lo que más se usa va arriba (Telegram muestra el menú en este orden).
  {
    command: 'stop',
    description: 'Detener tareas, grabación y directo',
  },
  {
    command: 'recordatorios',
    description: 'Ver tus recordatorios y borrar uno',
  },
  {
    command: 'agenda',
    description: 'Calendario, pendientes, rutinas y objetivos',
  },
  {
    command: 'pendientes',
    description: 'Ver los recordatorios pendientes',
  },
  {
    command: 'correo',
    description: 'Correo: estado, últimos mensajes y responder',
  },
  {
    command: 'resolver',
    description: 'Marcar un pendiente como resuelto',
  },
  {
    command: 'resumen',
    description: 'Resumen de hoy (/resumen hoy) o de la semana',
  },
  {
    command: 'screen',
    description: 'Captura o foto en directo: /screen live',
  },
  {
    command: 'tv',
    description: 'Mando de la tele: /tv solo abre el mando; /tv apaga la tele (sin gastar)',
  },
  {
    command: 'buscar',
    description: 'Buscar en conversaciones pasadas',
  },
  {
    command: 'memoria',
    description: 'Ver, buscar, olvidar o exportar lo que recuerdo',
  },
  {
    command: 'help',
    description: 'Ver todos los comandos',
  },
  {
    command: 'funciones',
    description: 'Todo lo que sé hacer, por áreas y con ejemplos',
  },
  // Encargos: investigar, vigilar precios, rutinas.
  {
    command: 'investiga',
    description: 'Informe a fondo con citas; /investiga amplio compara varios elementos',
  },
  {
    command: 'vigila',
    description: 'Vigilar cambios de precio de una página',
  },
  {
    command: 'vigilando',
    description: 'Listar páginas vigiladas',
  },
  {
    command: 'vigilancias',
    description: 'Todo lo que vigilo: páginas, precios, rutinas y avisos',
  },
  {
    command: 'dejar_de_vigilar',
    description: 'Dejar de vigilar una página',
  },
  {
    command: 'precio',
    description: 'Histórico de precio de una página vigilada',
  },
  {
    command: 'compara',
    description: 'Comparar un producto entre las 7 tiendas',
  },
  {
    command: 'ocr',
    description: 'PDF o foto con texto seleccionable (escríbelo en el pie)',
  },
  {
    command: 'cron',
    description: 'Programar, pausar, probar o borrar rutinas',
  },
  {
    command: 'routines',
    description: 'Listar rutinas guardadas',
  },
  {
    command: 'routine',
    description: 'Ejecutar o programar una rutina',
  },
  {
    command: 'disparador',
    description: 'Crear o borrar un disparador por evento',
  },
  {
    command: 'disparadores',
    description: 'Listar disparadores por evento',
  },
  {
    command: 'deshacer',
    description: 'Reponer el último fichero escrito',
  },
  // El PC: cámara, grabaciones y avisos de pantalla.
  {
    command: 'camera',
    description: 'Foto, directo o vídeo de cámara',
  },
  {
    command: 'watch',
    description: 'Grabar un vídeo de pantalla: /watch 20 5',
  },
  {
    command: 'mic',
    description: 'Grabar unos segundos del micrófono',
  },
  {
    command: 'play',
    description: 'Reproducir el último audio en el PC',
  },
  {
    command: 'altavoz',
    description: 'Tus notas de voz suenan solas en el PC o la tele',
  },
  {
    command: 'ordenador',
    description: 'Apagar o encender el control del PC (/ordenador off lo para ya)',
  },
  {
    command: 'ojo',
    description: 'Ver, activar o parar avisos proactivos',
  },
  {
    command: 'avisos',
    description: 'Menos o más avisos del filtro de correo y citas',
  },
  {
    command: 'ignora',
    description: 'Ignorar un aviso por su número',
  },
  {
    command: 'ignorados',
    description: 'Ver reglas de avisos ignorados',
  },
  // Voz.
  {
    command: 'voice',
    description: 'Activar o desactivar respuestas habladas',
  },
  {
    command: 'wake',
    description: 'Activar o desactivar la escucha del nombre',
  },
  {
    command: 'conversacion',
    description: 'Controlar la conversación de voz',
  },
  {
    command: 'status',
    description: 'Activar o desactivar avisos de progreso',
  },
  // Conversaciones.
  {
    command: 'topic',
    description: 'Abrir o cambiar de conversación',
  },
  {
    command: 'topics',
    description: 'Listar conversaciones abiertas',
  },
  {
    command: 'steer',
    description: 'Corregir lo que estoy haciendo sin pararlo',
  },
  // Memoria y perfil.
  {
    command: 'memory',
    description: 'Ver lo que recuerdo de esta conversación',
  },
  {
    command: 'perfil',
    description: 'Ver y editar tu perfil estructurado',
  },
  {
    command: 'exportar',
    description: 'Exportar esta conversación como JSON',
  },
  {
    command: 'calendario',
    description: 'Añadir un evento al calendario local',
  },
  {
    command: 'skills',
    description: 'Instalar una skill desde una URL',
  },
  {
    command: 'learn',
    description: 'Aprender una rutina; /learn end para acabar',
  },
  // Ajustes y diagnóstico.
  {
    command: 'estado',
    description: 'Ver herramientas y errores de hoy',
  },
  {
    command: 'consumo',
    description: 'Ver tokens y coste estimado de hoy, la semana o el mes',
  },
  {
    command: 'permisos',
    description: 'Ver o revocar permisos permanentes',
  },
  {
    command: 'servicios',
    description: 'Herramientas externas adoptadas y su estado',
  },
  {
    command: 'evolucion',
    description: 'Ver la auto-mejora y proponer una idea',
  },
  // openGym; /start al final: solo se usa la primera vez.
  {
    command: 'entreno_hoy',
    description: 'Consultar el entreno de hoy en openGym',
  },
  {
    command: 'ultimo',
    description: 'Consultar el último entreno en openGym',
  },
  {
    command: 'peso',
    description: 'Consultar el peso en openGym',
  },
  {
    command: 'start',
    description: 'Saludar y ver la ayuda',
  },
] as const;
