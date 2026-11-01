/**
 * Catálogo de capacidades (paso P1 del plan de cohesión).
 *
 * Antes, lo que sabíamos de cada herramienta vivía en cuatro listas sueltas que tenían
 * que coincidir a mano:
 * - qué herramientas mueven la máquina (el mutex del daemon) — `core/tool-registry.ts`;
 * - cuáles solo existen con escritorio Windows — `platform.ts`;
 * - cuáles se pueden llamar en cualquier hilo sin preguntar — `core/toolset.ts`;
 * - cuáles se cargan bajo demanda y con qué palabras — `core/toolset.ts`.
 *
 * Ahora hay una entrada por herramienta aquí y esas cuatro listas se derivan de ella,
 * con los mismos nombres y en el mismo orden que antes (sin cambio de comportamiento:
 * `test/capabilities.test.ts` fija los valores exactos). Una herramienta nueva se
 * describe aquí una vez.
 *
 * Las reglas de «preguntar siempre» de `permissions.ts` NO viven aquí: son de la Gate y
 * dependen de la acción, no solo del nombre de la herramienta.
 *
 * Este módulo no importa nada de la app, para que cualquiera pueda importarlo sin ciclos.
 */

/** Carga bajo demanda: la herramienta se ofrece al modelo solo si el texto la pide. */
export interface DeferredSpec {
  pattern: RegExp;
  /** One line for the loader: what the tool is for. */
  purpose: string;
}

export interface Capability {
  /** Nombre de la herramienta tal y como la ve el modelo. */
  name: string;
  /** Mueve la máquina (ratón, teclado, ficheros, navegador, cobros, audio): pasa por el mutex del daemon. */
  machine?: boolean;
  /** Solo existe con el escritorio Windows (PA_DESKTOP); en modo servidor no se ofrece. */
  desktopOnly?: boolean;
  /** Se puede llamar en cualquier hilo sin aprobación (la Gate puede seguir preguntando por acción). */
  threadAllow?: boolean;
  /** Se carga bajo demanda cuando el texto del turno encaja con el patrón. */
  deferred?: DeferredSpec;
  /** Nota corta para humanos: por qué tiene estos metadatos. */
  note?: string;
}

/** Nombre de la herramienta que carga las diferidas. */
export const LOADER_TOOL_NAME = 'cargar_herramienta';

/**
 * Una entrada por herramienta con algún metadato. El orden importa: las listas
 * derivadas lo conservan (THREAD_ALLOW_TOOLS y el orden de carga de las diferidas).
 */
export const CAPABILITIES: readonly Capability[] = [
  { name: 'read', threadAllow: true },
  { name: 'list', threadAllow: true },
  { name: 'fetch', threadAllow: true },
  { name: 'done', threadAllow: true },
  { name: 'preguntar', threadAllow: true },
  { name: 'memory', threadAllow: true },
  { name: 'reminder', threadAllow: true },
  { name: 'tareas', threadAllow: true },
  {
    name: 'correo_reglas',
    note: 'Clasifica el correo y guarda reglas del dueño; no mueve ni borra correo. Sin threadAllow: en otros hilos pregunta.',
  },
  { name: 'agenda', threadAllow: true },
  {
    name: 'cuentas',
    threadAllow: true,
    note: 'listar/buscar del gestor de contraseñas: nunca devuelve la contraseña.',
  },
  { name: 'opengym', threadAllow: true },
  { name: 'book', threadAllow: true },
  { name: 'repartos', threadAllow: true },
  {
    name: 'objetivo',
    threadAllow: true,
    note: 'propose/list/pause/resume/cancel/avance libres; `activar` es always-ask en la propia Gate.',
  },
  {
    name: 'gestion',
    threadAllow: true,
    note: 'preparar/paso/completar/cancelar/listar/estado libres; `ejecutar` es always-ask en la propia Gate.',
  },
  {
    name: 'browser',
    machine: true,
    deferred: {
      pattern:
        /https?:\/\/|www\.|\b[\w-]+\.(com|es|org|net|io|eu|gob|cat)\b|web|p[áa]gina|navega|internet|google|youtube|amazon|booking|airbnb|wikipedia|busca en|mira en|reserva|compra|login|inicia(r)? sesi[óo]n|formulario|captcha|renfe|tren|vuelo|hotel|billete|cita|rellena|descarga/i,
      purpose: 'navegar por webs, rellenar formularios, elegir fechas y autocompletados',
    },
  },
  {
    name: 'delegate',
    threadAllow: true,
    note: 'subagentes de solo lectura: el hijo tiene su propia Gate sin approver.',
    deferred: {
      pattern: /delega|subagente|sub-agente|en paralelo|multi-?agente|varios agentes/i,
      purpose: 'delegar lectura/busqueda/planes a un subagente aislado (solo lectura)',
    },
  },
  { name: LOADER_TOOL_NAME, threadAllow: true },
  { name: 'computer', machine: true, desktopOnly: true },
  { name: 'shell', machine: true, desktopOnly: true },
  { name: 'checkout', machine: true },
  { name: 'write', machine: true },
  {
    name: 'media',
    machine: true,
    desktopOnly: true,
    deferred: {
      pattern:
        /audio|voz|foto|imagen|v[íi]deo|c[áa]mara|micr[óo]fono|graba|sonido|m[úu]sica|nota de voz|en vivo|live|sube el volumen|reproduce/i,
      purpose: 'audio, voz, fotos, vídeo, cámara y micrófono',
    },
  },
  { name: 'windows', desktopOnly: true },
  { name: 'ocr', desktopOnly: true },
  { name: 'system', desktopOnly: true },
  {
    name: 'tv',
    desktopOnly: true,
    note: 'hardware de la LAN (TV LG por SSAP): solo lo alcanza el PC de escritorio.',
  },
  {
    name: 'iphone',
    desktopOnly: true,
    note: 'puente ESP32 del iPhone en la LAN: solo lo alcanza el PC de escritorio.',
  },
  {
    name: 'ocr_local',
    note: 'OCR local opcional (PA_OCR_LOCAL=1): lee una imagen/PDF de las carpetas permitidas; la Gate decide.',
  },
  {
    name: 'tiempo',
    note: 'previsión del tiempo (Open-Meteo, sin clave): solo lectura por red; la Gate decide.',
  },
  {
    name: 'casa',
    note: 'Home Assistant de la red de casa (solo con PA_HA_URL): mirar es lectura; encender o apagar pregunta siempre.',
  },
  {
    name: 'luz',
    note: 'precio de la luz por horas (Red Eléctrica, sin clave): lectura por red; el aviso nocturno es una rutina local.',
  },
];

const names = (pick: (c: Capability) => boolean | undefined): string[] =>
  CAPABILITIES.filter((c) => pick(c)).map((c) => c.name);

/** Herramientas que mueven la máquina: en el daemon solo estas pasan por el mutex. */
export function machineToolNames(): string[] {
  return names((c) => c.machine);
}

/** Herramientas que requieren el escritorio Windows. */
export function desktopOnlyToolNames(): string[] {
  return names((c) => c.desktopOnly);
}

/** Herramientas libres en cualquier hilo, en el orden del catálogo. */
export function threadAllowToolNames(): string[] {
  return names((c) => c.threadAllow);
}

/** Specs de carga diferida, en el orden del catálogo (es el orden de carga). */
export function deferredSpecs(): Record<string, DeferredSpec> {
  const out: Record<string, DeferredSpec> = {};
  for (const c of CAPABILITIES) if (c.deferred) out[c.name] = c.deferred;
  return out;
}
