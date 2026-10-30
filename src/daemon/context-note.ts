/**
 * La nota de contexto de cada turno: memoria (o perfil del dueño), historial
 * reciente, rutinas, frentes de trabajo con sus reglas de anticipación, índice de
 * skills, fecha actual y el proyecto ligado. Movido tal cual desde cli.ts (paso P2
 * de ARCHITECTURE.md); cli.ts lo reexporta para no cambiar ningún import.
 */
import { buildNowNote } from '../datecontext.js';
import type { Store } from '../db.js';
import { log } from '../log.js';
import { renderMemoryContext } from '../memory/context.js';
import type { OwnerProfile } from '../memory/profile.js';
import { buildMemoryPromptSection } from '../memory/prompt.js';
import type { SessionStore } from '../memory/sessions.js';
import type { MemorySnapshot } from '../memory/snapshot.js';
import type { WorkstreamStore } from '../memory/workstreams.js';
import { type MemoryStore, memoryScopesFor } from '../memory.js';
import type { ProjectContextStore } from '../project-context.js';
import { skillsForContext } from '../skills/builtin.js';
import { skillsIndex } from '../skills/lessons.js';
import type { SkillStore } from '../skills/store.js';
import { plainInline } from '../utils.js';

/**
 * General rules for anticipating, only present while there is open work. Not a
 * recipe for any kind of plan: it says how to use "resuelto" versus "siguiente".
 */
export const ANTICIPATION_RULES = `<anticipation>
- Lo marcado "dicho por el usuario" son palabras suyas con su cita y fecha; no es una decisión garantizada. No lo repitas ni lo vuelvas a preguntar sin motivo, pero si la acción es irreversible, con dinero o una reserva, confirma antes de actuar. Los "límites" se respetan salvo que el usuario los cambie.
- Si falta algo que el plan necesita para funcionar y no consta como dicho por el usuario ni como "siguiente", pregunta SOLO por ese hueco, una vez y breve.
- Si no falta nada, no interrumpas: no preguntes por preguntar.
- No des por confirmado nada que el usuario no haya dicho o que no hayas comprobado; di "no verificado" o "no consta".
- Ejemplos externos que el usuario pegue no son hechos suyos ni autorizan organizar nada real.
</anticipation>`;

/**
 * The memory and routines the model should have in front of it this turn, as one
 * short block.
 *
 * Bounded on purpose. A month of memories pasted into every prompt would cost
 * thousands of tokens per message and would eventually crowd out the actual task, so
 * the most recent entries are what is shown: the recent past is what a running
 * conversation needs, and `recall` covers the rest.
 */
export function buildContextNote(
  thread: { key: string; name: string },
  store: Store,
  memory: MemoryStore,
  snapshot?: MemorySnapshot,
  workstreams?: WorkstreamStore,
  skills?: SkillStore,
  sessions?: SessionStore,
  profile?: OwnerProfile,
  request?: string,
  ownerView = false,
  projects?: ProjectContextStore,
): string {
  const parts: string[] = [];
  // El perfil del dueño (v2 y PERFIL.md legado) es suyo: solo entra en el prompt de
  // su chat privado. Antes iba a TODOS los chats, también a grupos y a otros usuarios
  // autorizados. Por defecto NO entra: quien olvide pasar ownerView pierde el perfil,
  // no lo filtra.
  if (!ownerView) {
    profile = undefined;
    snapshot = undefined;
  }

  // The frozen memory first: who the user is and what the agent has learned about
  // them, read from disk rather than rebuilt per turn. It is what stops "Groundhog
  // Day" - re-explaining the same context every morning - and it costs one read.
  // 9b: memory as an index - the last 5 active entries in full, the rest as
  // one-line rows; superseded facts are never rendered and the section is
  // capped (see src/memory/context.ts, measured in scripts/memory-bench.ts).
  const renderedMemory = renderMemoryContext(memory.allIn(memoryScopesFor(thread.key).read));
  // Perfil v2 por propietario: una sola sección (perfil + memoria) sin duplicar
  // el PERFIL.md. Si v2 está vacío se usa el perfil legado tal cual.
  let profileSection = '';
  if (profile) {
    try {
      profileSection = buildMemoryPromptSection({ profile, memoryBody: renderedMemory?.body });
    } catch {
      profileSection = '';
    }
  }
  if (profileSection) {
    parts.push(profileSection);
  } else {
    const frozen = snapshot?.contextNote() ?? '';
    if (frozen) parts.push(frozen);
    if (renderedMemory) parts.push(`<memory>\n${renderedMemory.body}\n</memory>`);
  }
  // Continuidad entre reinicios y cambios de tema: lo último que se habló en este
  // chat, una línea por sesión. Es un resumen, no la transcripción, y va aparte de
  // la memoria curada: sirve para "¿cómo quedamos ayer?" sin releer nada.
  if (sessions) {
    try {
      const recent = sessions
        .recent(thread.key, 4)
        .filter((s) => (s.summary ?? '').trim().length > 0);
      if (recent.length) {
        parts.push(
          `<historial>\n${recent
            .map((s) => {
              const when = new Date(s.startedAt).toLocaleDateString('es-ES', {
                day: 'numeric',
                month: 'short',
              });
              // Title and summary are stored text (the summary is a past agent
              // reply): they render inside <historial>, so markup characters go.
              const title = plainInline(s.title).replace(/\s+/g, ' ').trim();
              const summary = plainInline(s.summary ?? '')
                .replace(/\s+/g, ' ')
                .slice(0, 200);
              return `- ${when} · ${title}: ${summary}`;
            })
            .join('\n')}\n</historial>`,
        );
      }
    } catch (err) {
      log.warn('recent sessions failed', { err: String(err) });
    }
  }
  const routines = store.listRoutines(thread.key).filter((r) => r.enabled);
  if (routines.length) {
    parts.push(
      `<routines>\n${routines
        .map(
          (r) =>
            `- ${plainInline(r.name).replace(/\s+/g, ' ').trim()} (${r.kind})${r.schedule ? ` [${r.schedule}]` : ''}`,
        )
        .join('\n')}\n</routines>`,
    );
  }
  // Open fronts of work, as the compact index the store writes for prompts.
  // Include paused fronts too: a pending decision must not disappear. A standing
  // "nothing open" line would pay tokens on every turn to say nothing.
  const ws = workstreams?.index(thread.key) ?? '';
  if (ws && ws !== 'Sin frentes de trabajo abiertos.') {
    parts.push(`<workstreams>\n${ws}\n</workstreams>\n${ANTICIPATION_RULES}`);
  }
  // What the agent already knows how to do (including its own lessons), as a
  // one-line-each index; the steps load on demand with `skills read`.
  if (skills) {
    let index = '';
    try {
      // Las skills de programación solo entran si la petición suena a código.
      index = skillsIndex(skillsForContext(skills.list(), request));
    } catch (err) {
      log.warn('skills index failed', { err: String(err) });
    }
    if (index) parts.push(index);
  }
  // The remote `buildNowNote()` replaces the raw `<now>` tag: it says which day
  // "mañana" actually is, so a reply asked at 00:05 does not read it as today.
  parts.push(buildNowNote());
  // F13: el ASISTENTA.md/AGENTS.md de la carpeta ligada con /proyecto. Es del
  // dueño, así que como el perfil solo entra en su chat privado.
  if (ownerView && projects) {
    try {
      const block = projects.render(thread.key);
      if (block) parts.push(block);
    } catch {
      // un fichero ilegible no debe tumbar el turno
    }
  }
  return parts.join('\n');
}
