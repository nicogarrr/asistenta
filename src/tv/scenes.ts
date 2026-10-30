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
 */

export type SceneStep =
  | { action: 'power'; on: true }
  | { action: 'mute'; on: false }
  | { action: 'volume'; level: number }
  | { action: 'launch'; appId: string }
  | { action: 'toast'; message: string };

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
};

const SCENE_ALIASES: Record<string, string> = {
  cine: 'cine',
  'modo cine': 'cine',
  pelicula: 'cine',
  peli: 'cine',
  movie: 'cine',
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
      return 'encender la tele';
    case 'mute':
      return 'quitar el silencio';
    case 'volume':
      return `volumen a ${step.level}`;
    case 'launch':
      return `abrir ${step.appId}`;
    case 'toast':
      return 'aviso en pantalla';
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
  for (const step of steps) {
    if (step.action === 'power') {
      const on = deps.isOn ? await deps.isOn().catch(() => false) : false;
      if (on) {
        out.push({ step, status: 'omitido', text: 'ya estaba encendida' });
        continue;
      }
    }
    if ((step.action === 'mute' || step.action === 'volume') && !deps.hasGlasshouse) {
      out.push({ step, status: 'omitido', text: 'sin Glasshouse configurado' });
      continue;
    }
    try {
      out.push({ step, status: 'hecho', text: await deps.exec(step) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.push({ step, status: 'fallo', text: msg });
      // Sin tele encendida no tiene sentido seguir mandando ordenes.
      if (step.action === 'power') break;
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
