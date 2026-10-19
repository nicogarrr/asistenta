/** Canonical commands only; aliases stay accepted by the dispatcher. */
export const TELEGRAM_COMMANDS = [
  {
    command: 'start',
    description: 'Saludar y ver la ayuda',
  },
  {
    command: 'help',
    description: 'Ver todos los comandos',
  },
  {
    command: 'stop',
    description: 'Detener tareas, grabación y directo',
  },
  {
    command: 'estado',
    description: 'Ver herramientas y errores de hoy',
  },
  {
    command: 'permisos',
    description: 'Ver o revocar permisos permanentes',
  },
  {
    command: 'screen',
    description: 'Captura o foto en directo: /screen live',
  },
  {
    command: 'watch',
    description: 'Grabar un vídeo de pantalla: /watch 20 5',
  },
  {
    command: 'camera',
    description: 'Foto, directo o vídeo de cámara',
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
    command: 'topic',
    description: 'Abrir o cambiar de conversación',
  },
  {
    command: 'topics',
    description: 'Listar conversaciones abiertas',
  },
  {
    command: 'learn',
    description: 'Aprender una rutina; /learn end para acabar',
  },
  {
    command: 'routine',
    description: 'Ejecutar o programar una rutina',
  },
  {
    command: 'routines',
    description: 'Listar rutinas guardadas',
  },
  {
    command: 'agenda',
    description: 'Ver rutinas programadas y próxima ejecución',
  },
  {
    command: 'cron',
    description: 'Programar, listar o borrar rutinas',
  },
  {
    command: 'memory',
    description: 'Ver lo que recuerdo de esta conversación',
  },
  {
    command: 'buscar',
    description: 'Buscar en conversaciones pasadas',
  },
  {
    command: 'steer',
    description: 'Corregir lo que estoy haciendo sin pararlo',
  },
  {
    command: 'pendientes',
    description: 'Ver los recordatorios pendientes',
  },
  {
    command: 'resolver',
    description: 'Marcar un pendiente como resuelto',
  },
  {
    command: 'deshacer',
    description: 'Reponer el último fichero escrito',
  },
  {
    command: 'ojo',
    description: 'Ver, activar o parar avisos proactivos',
  },
  {
    command: 'ignora',
    description: 'Ignorar un aviso por su número',
  },
  {
    command: 'avisos',
    description: 'Menos o más avisos del filtro de correo y citas',
  },
  {
    command: 'ignorados',
    description: 'Ver reglas de avisos ignorados',
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
    command: 'investiga',
    description: 'Investigar a fondo y dar un informe con citas',
  },
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
  {
    command: 'resumen',
    description: 'Ver el resumen semanal de actividad',
  },
  {
    command: 'evolucion',
    description: 'Ver la auto-mejora y proponer una idea',
  },
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
] as const;
