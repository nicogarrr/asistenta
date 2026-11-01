/**
 * Qué hay configurado en este PC para el auto-chequeo de las habilidades.
 *
 * Sin esto el chequeo respondía «sin comprobar» para todo, aunque el correo o el
 * calendario estuvieran puestos. Aquí solo se mira si existe la configuración
 * (claves del vault, el calendario local, las herramientas cargadas); no se
 * conecta a nada ni se lee ningún secreto en voz alta: solo «hay» o «no hay».
 *
 * Los nombres son los de `needs` en las habilidades (general.ts): correo,
 * calendario, navegador, casa, notas-voz.
 */
import type { SelfCheckEnv } from './selfcheck.js';

export interface SkillEnvProbes {
  /** Lee una clave del vault; un fallo cuenta como «no configurado». */
  vault: (key: string) => Promise<string | null | undefined>;
  /** Hay un calendario local (local.ics). */
  hasLocalCalendar: () => boolean;
  /** Herramientas que el modelo tiene ahora, incluidas las fab_* instaladas. */
  toolNames: () => readonly string[] | Promise<readonly string[]>;
}

/** Nombre de la herramienta de Home Assistant cuando exista; sin ella, «casa» falta. */
export const HOME_TOOL_NAME = 'casa';

async function has(probes: SkillEnvProbes, key: string): Promise<boolean> {
  try {
    return Boolean((await probes.vault(key))?.trim());
  } catch {
    return false;
  }
}

async function both(probes: SkillEnvProbes, a: string, b: string): Promise<boolean> {
  return (await has(probes, a)) && (await has(probes, b));
}

export async function detectSkillEnv(probes: SkillEnvProbes): Promise<SelfCheckEnv> {
  let toolNames: readonly string[] = [];
  try {
    toolNames = [...(await probes.toolNames())];
  } catch {
    toolNames = [];
  }
  const capabilities = new Set<string>();
  // Correo: la cuenta de lectura (mailRead) o la antigua (mail).
  if (
    (await both(probes, 'mailRead:address', 'mailRead:password')) ||
    (await both(probes, 'mail:address', 'mail:password'))
  ) {
    capabilities.add('correo');
  }
  let localCalendar = false;
  try {
    localCalendar = probes.hasLocalCalendar();
  } catch {
    localCalendar = false;
  }
  if (localCalendar || (await has(probes, 'calendar:icsUrl'))) capabilities.add('calendario');
  if (toolNames.includes('browser')) capabilities.add('navegador');
  if (toolNames.includes(HOME_TOOL_NAME)) capabilities.add('casa');
  // La transcripción es local (Whisper en el PC, sin clave): siempre está.
  capabilities.add('notas-voz');
  return { toolNames, capabilities };
}
