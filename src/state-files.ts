/**
 * Registro único de todo lo que Asistenta guarda en su directorio de estado.
 *
 * Cada nombre de primer nivel de `<estado>/` que el código crea está aquí, con lo que
 * hace con él la copia de seguridad nocturna (`backup.ts`) y quién lo poda
 * (`maintenance.ts`). Antes la copia tenía su propia lista a mano y se quedaban fuera
 * cosas que solo existen aquí (las salidas de rutinas en fichero, el registro de
 * auditoría…). `test/state-files.test.ts` falla si el código usa un nombre nuevo de
 * estado que no está en este registro, o si la copia no cubre lo que dice cubrir.
 *
 * - `backup: 'db'`   base SQLite: se copia con VACUUM INTO (coherente aunque esté abierta).
 * - `backup: 'file'` fichero suelto: se copia tal cual.
 * - `backup: 'dir'`  carpeta: se copia entera.
 * - `backup: 'docs'` docs/: docs.sqlite con VACUUM INTO más el mirror de texto.
 * - `backup: false`  no se copia; `why` dice por qué.
 */

export type StateEntry = {
  /** Nombre de primer nivel dentro del directorio de estado. */
  readonly name: string;
  /** Qué es, en una línea. */
  readonly what: string;
  /** Quién lo poda y con qué ajuste; ausente = crece sin poda. */
  readonly retention?: string;
} & (
  | { readonly backup: 'db' | 'file' | 'dir' | 'docs' }
  | { readonly backup: false; readonly why: string }
);

export const STATE_ENTRIES: readonly StateEntry[] = [
  // Bases de datos de la raíz (backup.ts además copia cualquier otro *.db / *.sqlite).
  {
    name: 'agent.db',
    what: 'sesiones, recordatorios, rutinas, vigilancias, ojo de águila',
    backup: 'db',
    retention: 'sesiones: PA_SESSION_RETENTION_DAYS (maintenance.ts, 04:00)',
  },
  { name: 'memory.db', what: 'memoria semántica', backup: 'db' },
  { name: 'goals.db', what: 'objetivos', backup: 'db' },
  { name: 'voice.db', what: 'estado de voz', backup: 'db' },
  { name: 'approvals.db', what: 'aprobaciones guardadas', backup: 'db' },
  { name: 'pricewatch.sqlite', what: 'historial de precios vigilados', backup: 'db' },
  // Ficheros sueltos (backup.ts además copia cualquier otro *.json de la raíz).
  { name: 'pricewatch.json', what: 'tus alertas de precio', backup: 'file' },
  { name: 'routine-delivery.json', what: 'a dónde va la salida de cada rutina', backup: 'file' },
  { name: 'command-routines.json', what: 'rutinas de comando aprobadas', backup: 'file' },
  { name: 'proyectos.json', what: 'proyectos conocidos', backup: 'file' },
  { name: 'alerts-seen.json', what: 'alertas ya entregadas (evita repetidas)', backup: 'file' },
  {
    name: 'altavoz.json',
    what: 'modo /altavoz por chat (notas de voz suenan al llegar)',
    backup: 'file',
  },
  { name: 'actions.jsonl', what: 'registro de acciones hechas por el agente', backup: 'file' },
  {
    name: 'dropped-reminders.jsonl',
    what: 'recordatorios que no se pudieron entregar y se descartaron',
    backup: 'file',
  },
  // Carpetas que solo existen aquí.
  { name: 'memory', what: 'memoria a largo plazo (markdown por ámbito)', backup: 'dir' },
  { name: 'snapshot', what: 'instantáneas de memoria', backup: 'dir' },
  { name: 'skills', what: 'habilidades aprendidas', backup: 'dir' },
  { name: 'playbooks', what: 'playbooks', backup: 'dir' },
  { name: 'undo', what: 'deshacer de memoria', backup: 'dir' },
  { name: 'calendar', what: 'agenda local (sin Google)', backup: 'dir' },
  { name: 'profile', what: 'tu perfil', backup: 'dir' },
  { name: 'services', what: 'servicios registrados', backup: 'dir' },
  { name: 'salidas', what: 'salidas de rutinas entregadas «a fichero»', backup: 'dir' },
  { name: 'audit', what: 'registro de auditoría de llamadas a herramientas', backup: 'dir' },
  { name: 'factory', what: 'herramientas de la fábrica (TOOL.md editables)', backup: 'dir' },
  { name: 'evolve', what: 'historial de intentos de auto-mejora', backup: 'dir' },
  {
    name: 'docs',
    what: 'memoria de documentos (índice FTS + mirror de texto)',
    backup: 'docs',
    retention: 'PA_DOCUMENT_RETENTION_DAYS (maintenance.ts, 04:00; apagada por defecto)',
  },
  // Lo que no se copia.
  {
    name: 'vault.enc',
    what: 'secretos cifrados',
    backup: false,
    why: 'un duplicado en la misma máquina no protege nada y multiplica dónde viven los secretos',
  },
  { name: 'agent.pid', what: 'pid del daemon', backup: false, why: 'estado de ejecución' },
  { name: 'agent.heartbeat', what: 'latido del daemon', backup: false, why: 'estado de ejecución' },
  {
    name: 'control',
    what: 'canal de control del daemon',
    backup: false,
    why: 'estado de ejecución',
  },
  {
    name: 'control-win',
    what: 'canal de control del daemon en Windows',
    backup: false,
    why: 'estado de ejecución',
  },
  {
    name: 'log',
    what: 'registros y consumo',
    backup: false,
    why: 'diagnóstico; crece y se regenera',
  },
  { name: 'screenshots', what: 'capturas de pantalla', backup: false, why: 'pesan y se regeneran' },
  {
    name: 'browser',
    what: 'perfil del navegador',
    backup: false,
    why: 'pesa y lleva cookies de sesión',
  },
  {
    name: 'models',
    what: 'modelos descargados',
    backup: false,
    why: 'pesan y se vuelven a descargar',
  },
  { name: 'voice', what: 'temporales de voz y grabaciones', backup: false, why: 'temporales' },
  {
    name: 'sessions',
    what: 'temporales de sesión',
    backup: false,
    why: 'las sesiones viven en agent.db',
  },
  {
    name: 'media',
    what: 'audios recibidos (para «reprodúcelo»)',
    backup: false,
    why: 'pesan; el original sigue en el chat',
  },
  {
    name: 'memory-consolidation',
    what: 'copias previas a consolidar la memoria',
    backup: false,
    why: 'ya es una copia de seguridad',
  },
  { name: 'qa', what: 'canal de pruebas QA', backup: false, why: 'solo pruebas' },
  {
    name: 'backups',
    what: 'las propias copias de seguridad',
    backup: false,
    why: 'es el destino',
    retention: 'se guardan las últimas 7 (backup.ts)',
  },
];

/** Entradas que la copia nocturna debe llevar. */
export function backedUp(kind: 'db' | 'file' | 'dir' | 'docs'): string[] {
  return STATE_ENTRIES.filter((e) => e.backup === kind).map((e) => e.name);
}

export function stateEntry(name: string): StateEntry | undefined {
  return STATE_ENTRIES.find((e) => e.name === name);
}
