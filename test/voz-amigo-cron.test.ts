import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCronAdd } from '../src/cron/scheduler.js';
import { deliveryWords, runCronCommand } from '../src/daemon/cron-command.js';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { Store } from '../src/db.js';
import { RoutineRunner, validateSchedule } from '../src/routines.js';

// Nico (1 nov, 00:47 y 01:20): «natural, como estamos hablando nosotros», sin
// «/cron del resumen» de ejemplo. /cron pregunta como un amigo, nombra sus rutinas
// y la siguiente respuesta normal del chat completa la orden.
describe('/cron habla como un amigo', () => {
  const CHAT = 'telegram:42';
  const THREAD = `${CHAT}#main`;
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  let preguntas: PreguntasPendientes;
  const deps = () => ({
    store,
    routineRunner: runner,
    threadKey: THREAD,
    chatKey: CHAT,
    ask: (opts: Parameters<PreguntasPendientes['ask']>[2]) => preguntas.ask(CHAT, 'cron', opts),
  });
  /** Lo que haría el daemon con la respuesta normal: completar el /cron. */
  const contesta = (text: string): string | null => {
    const cmd = preguntas.consume(CHAT, text);
    return cmd ? runCronCommand(deps(), cmd.args) : null;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-cron-amigo-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.start();
    preguntas = new PreguntasPendientes(() => 0);
  });

  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ninguna respuesta de /cron enseña un comando con barra', () => {
    const replies = [
      runCronCommand(deps(), ''),
      runCronCommand(deps(), 'add'),
      runCronCommand(deps(), 'del'),
      runCronCommand(deps(), 'pausa'),
      runCronCommand(deps(), 'probar'),
      runCronCommand(deps(), 'add cuando puedas gracias'),
      runCronCommand(deps(), 'add 0 8 * * * |'),
    ];
    for (const r of replies) expect(r).not.toMatch(/\/cron|<[a-z]/);
  });

  it('sin rutinas: pregunta qué y cuándo, y la respuesta la programa', () => {
    expect(runCronCommand(deps(), '')).toBe(
      'No hay rutinas programadas. Dime qué hago y cuándo, por ejemplo «cada mañana a las 8 el resumen del día», y la programo.',
    );
    expect(contesta('cada mañana a las 8 el resumen del día')).toContain(
      'programada: cada día a las 08:00',
    );
    expect(store.listRoutines().map((r) => r.schedule)).toEqual(['0 8 * * *']);
  });

  it('«/cron del» nombra las rutinas y «la de resumen» la borra', () => {
    runCronCommand(deps(), 'add cada mañana a las 8 resumen');
    runCronCommand(deps(), 'add cada lunes a las 9 revisar el correo');
    const names = store.listRoutines().map((r) => r.name);
    const pregunta = runCronCommand(deps(), 'del');
    expect(pregunta).toMatch(/^¿Qué rutina borro\? Tienes estas: /);
    for (const n of names) expect(pregunta).toContain(n);
    const first = names[0] ?? '';
    expect(contesta(`la rutina de ${first.toUpperCase()}`)).toContain(`Rutina "${first}" borrada`);
    expect(store.listRoutines().map((r) => r.name)).toEqual(names.slice(1));
  });

  it('un nombre que no existe no se usa: el mensaje sigue su camino', () => {
    runCronCommand(deps(), 'add cada mañana a las 8 resumen');
    runCronCommand(deps(), 'del');
    expect(contesta('¿qué tiempo hace mañana?')).toBeNull();
    expect(store.listRoutines()).toHaveLength(1);
  });

  it('pausa y reanudar preguntan solo por las que tiene sentido', () => {
    runCronCommand(deps(), 'add cada mañana a las 8 resumen');
    const name = store.listRoutines()[0]?.name ?? '';
    expect(runCronCommand(deps(), 'reanudar')).toBe('No tienes ninguna rutina en pausa.');
    expect(runCronCommand(deps(), 'pausa')).toBe(`¿Qué rutina pauso? Tienes: ${name}.`);
    const hecho = contesta(name) ?? '';
    expect(hecho).toContain('en pausa');
    expect(hecho).not.toContain('/cron');
    // Probar una en pausa: ofrece reanudarla y «sí» lo hace.
    expect(runCronCommand(deps(), `probar ${name}`)).toBe(
      `La rutina "${name}" está en pausa. ¿La reanudo? Dime «sí» y vuelve a su horario.`,
    );
    expect(contesta('sí')).toContain(`Rutina "${name}" reanudada`);
  });

  it('entrega: entiende «al chat, solo si cambia»', () => {
    expect(deliveryWords('resumen al chat, solo si cambia')).toBe('resumen chat solo-si-cambia');
    expect(deliveryWords('copia a un fichero siempre')).toBe('copia fichero siempre');
    expect(deliveryWords('copia a ningún sitio')).toBe('copia ninguno');
    expect(deliveryWords('resumen')).toBe('resumen');
  });

  it('los errores de horario hablan normal', () => {
    for (const body of ['cuando puedas gracias', '0 8 * * * |']) {
      const r = parseCronAdd(body, validateSchedule);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).not.toContain('/cron');
        expect(r.error).toContain('«cada mañana a las 8 el resumen del día»');
      }
    }
    expect(parseCronAdd('cada lunes a las 9 revisar el correo', validateSchedule).ok).toBe(true);
  });

  it('aprobar un comando: basta con contestar el código', () => {
    const src = readFileSync('src/daemon/cron-command.ts', 'utf8');
    expect(src).toContain('Para aprobar exactamente este comando, contéstame con el código ');
    expect(src).not.toContain('confirmar copia 123456');
    expect(src).not.toContain('/cron entrega ');
  });
});

describe('pregunta pendiente: answer convierte la respuesta', () => {
  it('answer manda sobre el prefijo y null la descarta', () => {
    const p = new PreguntasPendientes(() => 0);
    p.ask('c', 'cron', { answer: (t) => (t === 'sí' ? 'reanudar resumen' : null) });
    expect(p.consume('c', 'sí')).toEqual({ name: 'cron', args: 'reanudar resumen' });
    p.ask('c', 'cron', { answer: () => null });
    expect(p.consume('c', 'sí')).toBeNull();
  });
});
