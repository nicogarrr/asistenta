/**
 * Rutinas de la tele ("modo cine"): una secuencia de acciones normales de la
 * tool `tv`, en orden, cada una con su resultado. No hay nada nuevo que pueda
 * hacer la tele: solo se encadenan ordenes que ya existian, por la misma cola.
 *
 * Reglas:
 * - Si la tele ya esta encendida (action=status), no se reenvia el encendido.
 * - Si encender falla, se para: el resto no puede llegar a una tele apagada.
 * - Un paso que necesita Glasshouse sin Glasshouse configurado se OMITE (no
 *   es un fallo de la rutina, la tele de Nico puede no tenerlo).
 * - Cualquier otro fallo se informa y la rutina sigue con el siguiente paso.
 * - Si la tele consta APAGADA (status) y la rutina no la ha encendido, el
 *   resto de pasos se omiten («la tele esta apagada»): el modo noche no
 *   enciende una tele apagada, y apagar todo no la apaga dos veces.
 * - Extras de Glasshouse (decision de Nico 30-oct-2026, «las opciones con mas
 *   logica»): apagar todo cierra antes la app que este abierta, y modo noche
 *   pone la imagen oscura (modo de imagen NOCHE_PICTURE_MODE). Son pasos
 *   OPCIONALES: sin Glasshouse se omiten y si fallan se ignoran (la rutina
 *   sigue: apagar todo apaga igual). Volver a la imagen de antes: «pon la
 *   imagen en estandar» (tool tv action=picture) o el menu de la tele. Ver
 *   docs/tv-ordenes.md.
 */

export type SceneStep =
  | { action: 'power'; on: boolean }
  | { action: 'mute'; on: false }
  | { action: 'volume'; level: number }
  | { action: 'launch'; appId: string }
  | { action: 'toast'; message: string }
  /** Cierra la app en primer plano, si hay una abierta (opcional, Glasshouse). */
  | { action: 'closeForeground' }
  /** Modo de imagen de la tele (opcional, Glasshouse). */
  | { action: 'picture'; mode: string };

/** Pasos que solo existen con Glasshouse: sin el se omiten. */
const GLASSHOUSE_STEPS = new Set<SceneStep['action']>([
  'mute',
  'volume',
  'closeForeground',
  'picture',
]);
/** Pasos opcionales: si fallan se ignoran (omitido), no son un fallo de la rutina. */
const OPTIONAL_STEPS = new Set<SceneStep['action']>(['closeForeground', 'picture']);

export interface SceneOptions {
  /** App a abrir al final (nombre o id: "Netflix", "youtube"...). */
  appId?: string;
  /** Volumen absoluto 0-100 (por defecto el de la rutina). */
  level?: number;
}

export interface SceneDef {
  label: string;
  build: (opts: SceneOptions) => SceneStep[];
}

/** Volumen por defecto del modo cine: audible sin sobresaltos. */
export const CINE_DEFAULT_LEVEL = 20;
/** Volumen por defecto del modo noche: bajo, para no despertar a nadie. */
export const NOCHE_DEFAULT_LEVEL = 8;
/** Modo de imagen del modo noche: «eco», el mas oscuro de LG (ahorro de energia). */
export const NOCHE_PICTURE_MODE = 'eco';

export const TV_SCENES: Record<string, SceneDef> = {
  cine: {
    label: 'modo cine',
    build: ({ appId, level }) => [
      { action: 'power', on: true },
      { action: 'mute', on: false },
      { action: 'volume', level: level ?? CINE_DEFAULT_LEVEL },
      ...(appId ? [{ action: 'launch' as const, appId }] : []),
      { action: 'toast', message: 'Modo cine activado. Disfruta de la peli.' },
    ],
  },
  noche: {
    label: 'modo noche',
    // No enciende: es para bajar el volumen con la tele ya puesta.
    build: ({ appId, level }) => [
      { action: 'volume', level: level ?? NOCHE_DEFAULT_LEVEL },
      { action: 'picture', mode: NOCHE_PICTURE_MODE },
      ...(appId ? [{ action: 'launch' as const, appId }] : []),
      { action: 'toast', message: 'Modo noche: volumen bajo e imagen oscura.' },
    ],
  },
  'apagar-todo': {
    label: 'apagado',
    build: () => [
      { action: 'toast', message: 'Apagando. Buenas noches.' },
      { action: 'closeForeground' },
      { action: 'power', on: false },
    ],
  },
};

const SCENE_ALIASES: Record<string, string> = {
  cine: 'cine',
  'modo cine': 'cine',
  pelicula: 'cine',
  peli: 'cine',
  movie: 'cine',
  noche: 'noche',
  'modo noche': 'noche',
  nocturno: 'noche',
  'modo nocturno': 'noche',
  night: 'noche',
  'apagar-todo': 'apagar-todo',
  'apagar todo': 'apagar-todo',
  'apaga todo': 'apagar-todo',
  apagado: 'apagar-todo',
};

export function resolveScene(name: string): string | null {
  const n = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  return SCENE_ALIASES[n] ?? null;
}

export interface SceneStepResult {
  step: SceneStep;
  status: 'hecho' | 'omitido' | 'fallo';
  text: string;
}

/** Texto corto de cada paso, para el resumen. */
export function describeStep(step: SceneStep): string {
  switch (step.action) {
    case 'power':
      return step.on ? 'encender la tele' : 'apagar la tele';
    case 'mute':
      return 'quitar el silencio';
    case 'volume':
      return `volumen a ${step.level}`;
    case 'launch':
      return `abrir ${step.appId}`;
    case 'toast':
      return 'aviso en pantalla';
    case 'closeForeground':
      return 'cerrar la app abierta';
    case 'picture':
      return `imagen ${step.mode}`;
  }
}

export interface RunSceneDeps {
  /** Ejecuta un paso con la accion normal de la tool (misma cola y reglas). */
  exec: (step: SceneStep) => Promise<string>;
  /** ¿Ya esta encendida? (status en vivo). Ausente = no se sabe: se envia el encendido. */
  isOn?: () => Promise<boolean>;
  /** ¿Hay Glasshouse? Sin el, mute/volume se omiten. */
  hasGlasshouse: boolean;
}

export async function runScene(steps: SceneStep[], deps: RunSceneDeps): Promise<SceneStepResult[]> {
  const out: SceneStepResult[] = [];
  // Estado en vivo, leido una sola vez: true/false, o undefined si no se sabe
  // (sin status o status fallido: se actua como antes, sin omitir nada).
  let known: boolean | undefined;
  let read = false;
  const isOn = async (): Promise<boolean | undefined> => {
    if (!read) {
      read = true;
      known = deps.isOn ? await deps.isOn().catch(() => undefined) : undefined;
    }
    return known;
  };
  let poweredOn = false;
  for (const step of steps) {
    if (step.action === 'power' && step.on) {
      if ((await isOn()) === true) {
        out.push({ step, status: 'omitido', text: 'ya estaba encendida' });
        poweredOn = true;
        continue;
      }
    } else if (!poweredOn && (await isOn()) === false) {
      const text = step.action === 'power' ? 'ya estaba apagada' : 'la tele esta apagada';
      out.push({ step, status: 'omitido', text });
      continue;
    }
    if (GLASSHOUSE_STEPS.has(step.action) && !deps.hasGlasshouse) {
      out.push({ step, status: 'omitido', text: 'sin Glasshouse configurado' });
      continue;
    }
    try {
      out.push({ step, status: 'hecho', text: await deps.exec(step) });
      if (step.action === 'power') poweredOn = step.on;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Un extra opcional que falla se ignora: la rutina sigue igual.
      out.push({ step, status: OPTIONAL_STEPS.has(step.action) ? 'omitido' : 'fallo', text: msg });
      // Sin tele encendida no tiene sentido seguir mandando ordenes.
      if (step.action === 'power' && step.on) break;
    }
  }
  return out;
}

export function summarizeScene(label: string, results: SceneStepResult[], total: number): string {
  const lines = results.map((r) => {
    const mark = r.status === 'hecho' ? 'hecho' : r.status === 'omitido' ? 'omitido' : 'FALLO';
    const extra = r.status === 'hecho' ? '' : ` (${r.text})`;
    return `- ${describeStep(r.step)}: ${mark}${extra}`;
  });
  const failed = results.filter((r) => r.status === 'fallo').length;
  const stopped = results.length < total;
  const head = stopped
    ? `No he podido completar el ${label}: la tele no se encendio, asi que no he seguido.`
    : failed
      ? `${label[0]?.toUpperCase()}${label.slice(1)} listo con ${failed} paso${failed === 1 ? '' : 's'} fallido${failed === 1 ? '' : 's'}:`
      : `${label[0]?.toUpperCase()}${label.slice(1)} listo:`;
  return [head, ...lines].join('\n');
}
