/**
 * El comando /cron (y sus ayudantes de rutinas: nombre, ámbito del chat, próxima
 * ejecución, marca de rutina de comando), sin E/S: devuelve el texto exacto de la
 * respuesta y quien llama se encarga de enviarlo. Salió tal cual de cli.ts (paso P2
 * de ARCHITECTURE.md); cli.ts lo reexporta para no cambiar ningún import.
 */

import {
  approvalCode,
  COMMAND_ADD_USAGE,
  COMMAND_PROMPT_PREFIX,
  type CommandRoutineStore,
  commandRoutinesEnabled,
  displayArgv,
  isApproved,
  isCommandRoutine,
  looksLikeCommandAdd,
  parseCommandAdd,
} from '../command-routine.js';
import { programadaEs, scheduleEs } from '../cron/describe-es.js';
import { parseCronAdd, parseNatural } from '../cron/scheduler.js';
import { localDay } from '../datecontext.js';
import type { Routine, Store } from '../db.js';
import { GOAL_ROUTINE_PREFIX, goalIdOf, isGoalRoutine } from '../goals/runner.js';
import type { GoalStore } from '../goals/store.js';
import {
  describeDelivery,
  parseDeliveryArgs,
  type RoutineDeliveryStore,
} from '../routine-delivery.js';
import { type RoutineRunner, validateSchedule } from '../routines.js';
import { foldAccents, sliceSafe } from '../text.js';
import { isReminder } from '../tools/reminder.js';
import type { PreguntaOpts } from './pregunta-pendiente.js';

const DAY_MS = 86_400_000;

/**
 * Words that carry the schedule rather than the task. Stripped before naming, so
 * "cada mañana a las 8 resumen del día" becomes the routine "resumen" - the name
 * the user then types back in /routine.
 */
const SCHEDULE_WORDS = new Set([
  'a',
  'al',
  'cada',
  'con',
  'de',
  'del',
  'dia',
  'dias',
  'domingo',
  'el',
  'en',
  'hora',
  'horas',
  'jueves',
  'la',
  'las',
  'lo',
  'los',
  'lunes',
  'manana',
  'martes',
  'mes',
  'meses',
  'miercoles',
  'minuto',
  'minutos',
  'noche',
  'para',
  'por',
  'proxima',
  'que',
  'sabado',
  'semana',
  'semanas',
  'tarde',
  'todos',
  'un',
  'una',
  'viernes',
  'y',
]);

export function routineNameFromPrompt(prompt: string): string {
  const words = foldAccents(prompt)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !SCHEDULE_WORDS.has(w) && !/^\d+$/.test(w));
  const slug = words
    .slice(0, 6)
    .join('-')
    .replace(/[^a-z0-9-]/g, '');
  return slug || 'rutina';
}

/** A local stamp with a rough distance, for the agenda and the creation reply. */
export function formatNextRun(at: number, now = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const delta = at - now;
  if (delta <= 0) return `${stamp} (ya)`;
  // Whole units chosen before rounding, so half an hour never rounds up into
  // "en 1 h" and reads wrong for the next thirty minutes.
  if (delta >= 2 * DAY_MS) {
    // Días del calendario, no horas redondeadas: 60 h que caen pasado mañana son «en 2 d».
    const utc = (t: number): number => {
      const [y, m, dd] = localDay(t).split('-').map(Number);
      return Date.UTC(y ?? 0, (m ?? 1) - 1, dd ?? 1);
    };
    return `${stamp} (en ${Math.round((utc(at) - utc(now)) / DAY_MS)} d)`;
  }
  if (delta >= 3_600_000) return `${stamp} (en ${Math.round(delta / 3_600_000)} h)`;
  return `${stamp} (en ${Math.max(1, Math.round(delta / 60_000))} min)`;
}

/**
 * When a scheduled routine next fires, as text for the user. The live runner
 * answers first because it knows about held first fires; a routine that never
 * registered still gets an answer from its own cron expression.
 */
/**
 * Scope model: a thread's routines live at `chatKey#thread`, so a chat owns
 * exactly the scopes with that prefix — a bare startsWith(chatKey) would leak
 * telegram:123's routines into telegram:12 (auditor #135 ronda 2).
 */
export function inChatScope(scope: string, chatKey: string): boolean {
  return scope.startsWith(`${chatKey}#`);
}

/**
 * First free name in the scope, any kind: saveRoutine UPSERTS by (scope,name)
 * — steps and params included — so an implicit `/cron add` must never reuse an
 * existing name (auditor #135 ronda 2).
 */
export function uniqueRoutineName(store: Store, scope: string, base: string): string {
  if (!store.getRoutine(scope, base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!store.getRoutine(scope, candidate)) return candidate;
  }
}

export interface CronCommandDeps {
  store: Store;
  routineRunner: RoutineRunner;
  /** thread.key of the conversation the command runs in (`chatKey#thread`). */
  threadKey: string;
  /** chatKey without the `#thread` suffix. */
  chatKey: string;
  /** Where each routine's output goes (F6); absent = `/cron entrega` unavailable. */
  delivery?: RoutineDeliveryStore;
  /** F4: comandos propuestos/aprobados; absent = `/cron comando` unavailable. */
  commands?: CommandRoutineStore;
  /** F4: solo el dueño en su chat privado programa comandos. */
  isOwner?: boolean;
  /** F4: carpeta fija donde corre cada comando. */
  commandCwd?: string;
  /** F4: PA_CRON_COMANDOS; inyectable para los tests. */
  commandsEnabled?: boolean;
  /** Para que `/cron probar objetivo:<id>` sepa si el objetivo puede avanzar. */
  goals?: Pick<GoalStore, 'read'>;
  /**
   * Nico (1 nov): «como estamos hablando nosotros». Cuando la respuesta hace una
   * pregunta, la siguiente respuesta normal del chat completa el /cron sin
   * reescribirlo (pregunta-pendiente.ts: una vez, 10 minutos).
   */
  ask?: (opts: PreguntaOpts) => void;
}

const SI = /^(?:s[ií]|vale|venga|ok|okay|claro|dale|hazlo|porfa|por favor)[.!]*$/i;

const EJEMPLO_RUTINA = '«cada mañana a las 8 el resumen del día»';

/** Las rutinas sueltas que este chat puede nombrar (sin las de un objetivo). */
function routineNames(deps: CronCommandDeps, keep: (r: Routine) => boolean = () => true): string[] {
  return deps.store
    .listRoutines()
    .filter(
      (r) =>
        (r.scope === deps.threadKey || r.scope === `${deps.chatKey}#main`) &&
        r.kind === 'schedule' &&
        Boolean(r.schedule) &&
        !isGoalRoutine(r) &&
        keep(r),
    )
    .map((r) => r.name);
}

/** «la rutina de resumen», «Resumen.» → «resumen» si existe. */
function pickName(names: string[], text: string): string | null {
  const said = foldAccents(text.toLowerCase())
    .replace(/[«»"'.!?]/g, '')
    .trim()
    .replace(/^(?:la\s+rutina\s+(?:de\s+)?|la\s+de\s+|rutina\s+|la\s+|el\s+)/, '')
    .trim();
  return names.find((n) => foldAccents(n.toLowerCase()) === said) ?? null;
}

function nameList(names: string[]): string {
  const shown = names.slice(0, 8).join(', ');
  return names.length > 8 ? `${shown} y ${names.length - 8} más` : shown;
}

/** Pregunta qué rutina, con sus nombres, y deja la respuesta lista para `sub`. */
function askRoutine(deps: CronCommandDeps, verb: string, sub: string, names: string[]): string {
  deps.ask?.({
    answer: (t) => {
      const name = pickName(names, t);
      return name ? `${sub} ${name}` : null;
    },
  });
  return `¿Qué rutina ${verb}? ${names.length === 1 ? 'Tienes' : 'Tienes estas'}: ${nameList(names)}.`;
}

/** «resumen al chat, solo si cambia» → «resumen chat solo-si-cambia». */
export function deliveryWords(text: string): string {
  return text
    .replace(/[,;]/g, ' ')
    .replace(/\b(?:al|en el|por el|a este|en este)\s+chat\b/gi, 'chat')
    .replace(/\b(?:a|en)\s+(?:un\s+)?fichero\b/gi, 'fichero')
    .replace(/(?:\ba\s+)?\bning[uú]n\s+sitio\b|\ba\s+ninguno\b/gi, 'ninguno')
    .replace(/\bs(?:o|ó)lo\s+si\s+cambia\b/gi, 'solo-si-cambia')
    .replace(/\s+/g, ' ')
    .trim();
}

function askNewRoutine(deps: CronCommandDeps): void {
  deps.ask?.({
    answer: (t) => (parseCronAdd(t, validateSchedule).ok ? `add ${t}` : null),
  });
}

/**
 * `objetivo:<id>` is the schedule a goal rides, not a loose routine. Deleting
 * or pausing it through /cron left the goal `active` with no ticks, forever
 * and silently (and /cron reanudar ticked a paused goal behind its back): the
 * goal's state and its timer must move together, which only the goal actions
 * do. So /cron refuses and says which words do it.
 */
function goalRoutineCronRefusal(name: string, verb: 'borrar' | 'pausar' | 'reanudar'): string {
  const id = name.slice(GOAL_ROUTINE_PREFIX.length).trim();
  const action = verb === 'borrar' ? 'cancela' : verb === 'pausar' ? 'pausa' : 'reanuda';
  return [
    `"${name}" es la programación de un objetivo, no una rutina suelta: no la puedo ${verb} desde las rutinas, porque el objetivo seguiría ${verb === 'reanudar' ? 'en pausa pero avanzando' : 'activo pero sin avanzar'}.`,
    `Para eso dime «${action} el objetivo ${id}» (o pídeme la lista de objetivos).`,
  ].join('\n');
}

/**
 * The whole /cron command, free of I/O so its canaries run against a real
 * Store and RoutineRunner without a daemon (auditor #135 ronda 2). Returns
 * the exact reply text; the caller owns delivery.
 */
export function runCronCommand(deps: CronCommandDeps, args: string): string {
  const [subRaw, ...restParts] = args.trim().split(/\s+/).filter(Boolean);
  const sub = (subRaw ?? '').toLowerCase();
  const rest = restParts.join(' ');

  if (sub === 'entrega') {
    if (!deps.delivery) return 'Ahora mismo no puedo cambiar cómo se entregan las rutinas.';
    const parsed = parseDeliveryArgs(deliveryWords(rest));
    if (!parsed) {
      deps.ask?.({
        answer: (t) => {
          const words = deliveryWords(t);
          const p = parseDeliveryArgs(words);
          return p && (p.setting.target !== undefined || p.setting.soloSiCambia !== undefined)
            ? `entrega ${words}`
            : null;
        },
      });
      return '¿Qué rutina y cómo te la entrego? Puede llegar al chat, a un fichero o a ningún sitio, siempre o solo si cambia. Dímelo tal cual, por ejemplo: «resumen al chat, solo si cambia».';
    }
    const routine =
      deps.store.getRoutine(deps.threadKey, parsed.name) ??
      deps.store.getRoutine(`${deps.chatKey}#main`, parsed.name);
    if (!routine || routine.kind !== 'schedule' || isReminder(routine)) {
      return `No tengo ninguna rutina programada llamada "${parsed.name}".`;
    }
    const current = deps.delivery.get(routine.scope, routine.name);
    if (parsed.setting.target === undefined && parsed.setting.soloSiCambia === undefined) {
      return `La rutina "${routine.name}" entrega ${describeDelivery(current)}.`;
    }
    const next = {
      target: parsed.setting.target ?? current.target,
      soloSiCambia: parsed.setting.soloSiCambia ?? current.soloSiCambia,
    };
    deps.delivery.set(routine.scope, routine.name, next);
    return `Hecho: la rutina "${routine.name}" entregará ${describeDelivery(next)}.`;
  }

  if (sub === 'comando' || sub === 'comandos') {
    const enabled = deps.commandsEnabled ?? commandRoutinesEnabled();
    if (!enabled) {
      return 'Las rutinas de comando están desactivadas. Actívalas con PA_CRON_COMANDOS=1 y reinicia Asistenta.';
    }
    if (!deps.commands || !deps.isOwner) {
      return 'Solo el dueño, en su chat privado, puede programar comandos.';
    }
    if ((restParts[0] ?? '').toLowerCase() === 'confirmar') {
      const name = restParts[1] ?? '';
      const code = restParts[2] ?? '';
      if (!name || !code) {
        deps.ask?.({ prefix: 'comando confirmar ', accepts: (t) => /^\S+\s+\S+$/.test(t) });
        return 'Me falta el nombre de la rutina o el código de aprobación. Dímelos los dos, por ejemplo «copia 1a2b3c4d».';
      }
      if (deps.store.getRoutine(deps.threadKey, name)) {
        return `Ya hay una rutina llamada "${name}". Proponme el comando otra vez y le pongo otro nombre.`;
      }
      const spec = deps.commands.approve(deps.threadKey, name, code);
      if (!spec) {
        return 'Ese código no corresponde al comando propuesto (o ya no existe). No se ha programado nada.';
      }
      const created = deps.store.saveRoutine({
        scope: deps.threadKey,
        name,
        kind: 'schedule',
        prompt: `${COMMAND_PROMPT_PREFIX}${displayArgv(spec.argv)}`,
        schedule: spec.schedule,
      });
      deps.routineRunner.sync();
      const live = deps.routineRunner
        .status()
        .find((st) => st.scope === created.scope && st.name === created.name);
      if (deps.delivery) {
        deps.ask?.({ answer: (t) => (SI.test(t) ? `entrega ${name} chat solo-si-cambia` : null) });
      }
      return [
        `Rutina de comando "${name}" ${programadaEs(spec.schedule)}. No usa el modelo.`,
        `Comando: ${displayArgv(spec.argv)}`,
        `Próxima ejecución: ${nextRunLabel(created.schedule, live?.next)}.`,
        ...(deps.delivery
          ? ['¿Quieres que solo te avise cuando cambie la salida? Dime «sí».']
          : []),
      ].join('\n');
    }
    const parsed = parseCommandAdd(
      restParts.join(' '),
      validateSchedule,
      (words) => parseNatural(words)?.schedule ?? null,
    );
    if (!parsed.ok) {
      // La respuesta normal («cada día a las 8 ejecuta node saldo.js») completa la orden.
      if (parsed.error === COMMAND_ADD_USAGE) {
        deps.ask?.({ answer: (t) => (looksLikeCommandAdd(t) ? `comando ${t.trim()}` : null) });
      }
      return parsed.error;
    }
    const program = (parsed.value.argv[0] ?? '').split(/[\\/]/).pop() ?? '';
    const name = uniqueRoutineName(
      deps.store,
      deps.threadKey,
      routineNameFromPrompt(`comando ${program}`),
    );
    const spec = deps.commands.propose(deps.threadKey, name, {
      argv: parsed.value.argv,
      cwd: deps.commandCwd ?? process.cwd(),
      timeoutMs: parsed.value.timeoutMs,
      schedule: parsed.value.schedule,
      createdAt: new Date().toISOString(),
    });
    const code = approvalCode(spec);
    deps.ask?.({
      answer: (t) =>
        t
          .replace(/[«»"'.]/g, '')
          .trim()
          .toLowerCase() === code.toLowerCase()
          ? `comando confirmar ${name} ${code}`
          : null,
    });
    return [
      'Revisa el comando exacto antes de aprobarlo (se ejecuta sin shell y sin preguntarte cada vez):',
      `Programa y argumentos: ${displayArgv(spec.argv)}`,
      `Carpeta: ${spec.cwd}`,
      `Horario: ${scheduleEs(spec.schedule) ?? spec.schedule} · tope: ${Math.round(spec.timeoutMs / 1000)} s`,
      `Para aprobar exactamente este comando, contéstame con el código ${code}.`,
      'Si cambia algo del comando, hará falta una aprobación nueva.',
    ].join('\n');
  }

  if (sub === 'del' || sub === 'borra' || sub === 'rm') {
    const name = rest.trim();
    if (!name) {
      const names = routineNames(deps);
      return names.length
        ? askRoutine(deps, 'borro', 'del', names)
        : 'No tienes rutinas programadas que borrar.';
    }
    const routine =
      deps.store.getRoutine(deps.threadKey, name) ??
      deps.store.getRoutine(`${deps.chatKey}#main`, name);
    if (!routine || routine.kind !== 'schedule') {
      return `No tengo ninguna rutina programada llamada "${name}".`;
    }
    if (isGoalRoutine(routine)) return goalRoutineCronRefusal(routine.name, 'borrar');
    deps.store.deleteRoutine(routine.scope, routine.name);
    deps.commands?.remove(routine.scope, routine.name);
    // Live without restart: the runner drops the timer on this sync. An
    // execution already in flight is NOT cancelled (the runner awaits its
    // in-flight set, it does not interrupt it), so the confirmation only
    // promises what it delivers (auditor #135 ronda 2).
    deps.routineRunner.sync();
    return `Rutina "${name}" borrada: no habrá nuevas ejecuciones. Si hay una en marcha ahora mismo, puede terminar y llegar su mensaje.`;
  }

  if (sub === 'pausa' || sub === 'pause' || sub === 'reanuda' || sub === 'reanudar') {
    const resuming = sub === 'reanuda' || sub === 'reanudar';
    const name = rest.trim();
    if (!name) {
      const names = routineNames(deps, (r) => r.enabled !== resuming);
      if (names.length) {
        return askRoutine(
          deps,
          resuming ? 'reanudo' : 'pauso',
          resuming ? 'reanudar' : 'pausa',
          names,
        );
      }
      return resuming
        ? 'No tienes ninguna rutina en pausa.'
        : 'No tienes ninguna rutina activa que pausar.';
    }
    const routine =
      deps.store.getRoutine(deps.threadKey, name) ??
      deps.store.getRoutine(`${deps.chatKey}#main`, name);
    if (!routine || routine.kind !== 'schedule') {
      return `No tengo ninguna rutina programada llamada "${name}".`;
    }
    if (isGoalRoutine(routine)) {
      return goalRoutineCronRefusal(routine.name, resuming ? 'reanudar' : 'pausar');
    }
    if (routine.enabled === resuming) {
      return resuming
        ? `La rutina "${name}" ya estaba activa.`
        : `La rutina "${name}" ya estaba en pausa.`;
    }
    deps.store.setRoutineEnabled(routine.scope, routine.name, resuming);
    deps.routineRunner.sync();
    if (!resuming) {
      return `Rutina "${name}" en pausa: no se ejecutará hasta que la reanudes desde la lista de rutinas. Si hay una en marcha ahora mismo, puede terminar.`;
    }
    const live = deps.routineRunner
      .status()
      .find((st) => st.scope === routine.scope && st.name === routine.name);
    return `Rutina "${name}" reanudada. Próxima ejecución: ${nextRunLabel(routine.schedule, live?.next)}.`;
  }

  if (sub === 'probar' || sub === 'test' || sub === 'ahora') {
    const name = rest.trim();
    if (!name) {
      const names = routineNames(deps);
      return names.length
        ? askRoutine(deps, 'pruebo', 'probar', names)
        : 'No tienes rutinas programadas que probar.';
    }
    const routine =
      deps.store.getRoutine(deps.threadKey, name) ??
      deps.store.getRoutine(`${deps.chatKey}#main`, name);
    if (!routine || routine.kind !== 'schedule') {
      return `No tengo ninguna rutina programada llamada "${name}".`;
    }
    if (!routine.enabled) {
      deps.ask?.({ answer: (t) => (SI.test(t) ? `reanudar ${routine.name}` : null) });
      return `La rutina "${name}" está en pausa. ¿La reanudo? Dime «sí» y vuelve a su horario.`;
    }
    if (isGoalRoutine(routine) && deps.goals) {
      // El tick de un objetivo que no está activo no hace nada (runner.ts: «silent
      // skips»): decir «Lanzo… el resultado llegará» y luego callar era mentir.
      const id = goalIdOf(routine.name) ?? '';
      const goal = id ? deps.goals.read(id) : null;
      if (!goal) return 'Ese objetivo ya no existe: no hay nada que probar.';
      if (goal.status !== 'active') {
        const nombre = `«${goal.title?.trim() || id}»`;
        const estado =
          goal.status === 'paused'
            ? 'en pausa'
            : goal.status === 'blocked'
              ? 'bloqueado esperando tu respuesta'
              : goal.status === 'proposed'
                ? 'pendiente de tu aprobación'
                : goal.status === 'done'
                  ? 'terminado'
                  : 'cancelado';
        const hint =
          goal.status === 'paused'
            ? ` Dime «reanuda el objetivo ${nombre}» y vuelve a probar.`
            : goal.status === 'proposed'
              ? ` Apruébalo primero.`
              : goal.status === 'blocked'
                ? ' Respóndele primero.'
                : '';
        return `El objetivo ${nombre} está ${estado}: probarlo ahora no haría nada.${hint}`;
      }
    }
    if (deps.routineRunner.isRunning(routine.scope, routine.name)) {
      return `La rutina "${name}" ya se está ejecutando ahora mismo.`;
    }
    // A test is a real run: same approvals, same tools, same purchase cap. Say so,
    // so nobody expects a dry run.
    void deps.routineRunner.fire(routine.scope, routine.name);
    return `Lanzo "${name}" ahora como prueba. Es una ejecución real (mismos permisos y aprobaciones que a su hora); el resultado llegará a este chat. Su horario no cambia.`;
  }

  if (sub === 'add') {
    if (!rest.trim()) {
      askNewRoutine(deps);
      return `¿Qué hago y cuándo? Dímelo normal, por ejemplo: ${EJEMPLO_RUTINA}.`;
    }
    const parsed = parseCronAdd(rest, validateSchedule);
    if (!parsed.ok) return parsed.error;
    const base = routineNameFromPrompt(parsed.prompt);
    const name = uniqueRoutineName(deps.store, deps.threadKey, base);
    const created = deps.store.saveRoutine({
      scope: deps.threadKey,
      name,
      kind: 'schedule',
      prompt: parsed.prompt,
      schedule: parsed.schedule,
    });
    // Live at once, igual que /routine: una rutina que solo dispara tras
    // reiniciar es una que el usuario tiene que recordar que pidió.
    deps.routineRunner.sync();
    const live = deps.routineRunner
      .status()
      .find((st) => st.scope === created.scope && st.name === created.name);
    return [
      name !== base
        ? `Ya tenías una rutina llamada "${base}"; esta se guarda como "${name}" sin tocar la anterior. Horario: ${scheduleEs(created.schedule ?? '') ?? created.schedule}.`
        : `Rutina "${created.name}" ${programadaEs(created.schedule)}.`,
      `Tarea: ${created.prompt}`,
      `Próxima ejecución: ${nextRunLabel(created.schedule, live?.next)}.`,
    ].join('\n');
  }

  // /cron (o cualquier otro subcomando desconocido): la lista.
  const list = deps.store
    .listRoutines()
    .filter((r) => inChatScope(r.scope, deps.chatKey) && r.kind === 'schedule' && r.schedule);
  if (!list.length) {
    askNewRoutine(deps);
    return `No hay rutinas programadas. Dime qué hago y cuándo, por ejemplo ${EJEMPLO_RUTINA}, y la programo.`;
  }
  const live = deps.routineRunner.status();
  const commandsOn = deps.commandsEnabled ?? commandRoutinesEnabled();
  return [
    `Rutinas programadas: ${list.length}`,
    ...list.map(
      (r) =>
        `- ${r.name}${commandRoutineTag(r, deps.commands, commandsOn)} [${r.schedule}] — ${
          r.enabled
            ? `próxima: ${nextRunLabel(
                r.schedule ?? null,
                live.find((st) => st.scope === r.scope && st.name === r.name)?.next,
              )}`
            : 'EN PAUSA'
        }${r.lastRunAt ? `; última: ${r.lastRunAt}` : ''}`,
    ),
  ].join('\n');
}

/**
 * F4: en la lista de /cron una rutina de comando no se confunde con una que
 * habla con el modelo, y se ve si de verdad va a correr (aprobada y con
 * PA_CRON_COMANDOS=1) o se quedará parada en el aviso.
 */
export function commandRoutineTag(
  r: { scope: string; name: string; prompt: string | null },
  commands: Pick<CommandRoutineStore, 'get'> | undefined,
  enabled: boolean,
): string {
  if (!isCommandRoutine(r)) return '';
  const spec = commands?.get(r.scope, r.name) ?? null;
  if (!spec || !isApproved(spec)) return ' ⚙️ comando, sin aprobar (no se ejecuta)';
  if (!enabled) return ' ⚙️ comando, apagado (PA_CRON_COMANDOS=1 para activarlo)';
  const shown = displayArgv(spec.argv);
  return ` ⚙️ comando: ${shown.length > 60 ? `${sliceSafe(shown, 59)}…` : shown}`;
}

export function nextRunLabel(
  schedule: string | null,
  liveNext: string | null | undefined,
  now = Date.now(),
): string {
  if (liveNext) {
    const at = Date.parse(liveNext);
    if (Number.isFinite(at)) return formatNextRun(at, now);
  }
  const check = schedule ? validateSchedule(schedule) : null;
  return check?.ok ? check.next : 'sin próxima ejecución';
}

/**
 * /agenda (y la parte de rutinas de la agenda del dueño): las rutinas
 * programadas de este chat. Una rutina de comando lleva la misma marca que en
 * /cron, para que no parezca que habla con el modelo ni que va a correr si
 * está sin aprobar o con PA_CRON_COMANDOS apagado.
 */
export function scheduledAgendaText(deps: {
  store: Pick<Store, 'listRoutines'>;
  routineRunner: Pick<RoutineRunner, 'status'>;
  chatKey: string;
  commands?: Pick<CommandRoutineStore, 'get'>;
  commandsEnabled?: boolean;
}): string {
  const scheduled = deps.store
    .listRoutines()
    .filter((r) => inChatScope(r.scope, deps.chatKey) && r.kind === 'schedule');
  if (!scheduled.length) {
    return 'No hay rutinas programadas. Si quieres una, dime qué hago y cuándo, por ejemplo «cada mañana a las 8 el resumen del día».';
  }
  const commandsOn = deps.commandsEnabled ?? commandRoutinesEnabled();
  const live = new Map(deps.routineRunner.status().map((s) => [`${s.scope}\u0000${s.name}`, s]));
  const lines = scheduled.map((r) => {
    const held = live.get(`${r.scope}\u0000${r.name}`);
    const state = r.enabled ? '' : ' (desactivada)';
    const running = held?.running ? ' [en curso]' : '';
    const tag = commandRoutineTag(r, deps.commands, commandsOn);
    return `- ${r.name}${tag}${state} [${r.schedule ?? 'sin horario'}] — próxima: ${nextRunLabel(
      r.schedule,
      held?.next ?? null,
    )}${running}`;
  });
  return [`Rutinas programadas: ${scheduled.length}`, ...lines].join('\n');
}
