import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCronCommand, scheduledAgendaText } from '../src/cli.js';
import { horarioEnLista } from '../src/cron/cadencia.js';
import { Store } from '../src/db.js';
import { RoutineRunner } from '../src/routines.js';
import { panelRoutines } from '../src/webui/next-up.js';

// bugs30: /cron, /agenda y el panel decían el horario en cron crudo («[0 9 * * 1-5]»).
describe('el horario de las rutinas en palabras en /cron, /agenda y el panel (bugs30)', () => {
  const CHAT = 'telegram:42';
  const THREAD = `${CHAT}#main`;
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-bugs30-horario-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    store.saveRoutine({
      scope: THREAD,
      name: 'persiana',
      kind: 'schedule',
      prompt: 'abre la persiana excepto festivos',
      schedule: '0 8 * * 1-5',
    });
    store.saveRoutine({
      scope: THREAD,
      name: 'riego cada 2 días',
      kind: 'schedule',
      prompt: 'riega las plantas',
      schedule: '30 7 * * *',
    });
  });
  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('/cron: «de lunes a viernes a las 08:00, excepto festivos» y «cada 2 días a las 07:30»', () => {
    const out = runCronCommand(
      { store, routineRunner: runner, threadKey: THREAD, chatKey: CHAT },
      '',
    );
    expect(out).toContain('- persiana [de lunes a viernes a las 08:00, excepto festivos] — ');
    expect(out).toContain('- riego cada 2 días [cada 2 días a las 07:30] — ');
    expect(out).not.toMatch(/\[\d+ \d+ \*/);
  });

  it('/agenda igual', () => {
    const out = scheduledAgendaText({ store, routineRunner: runner, chatKey: CHAT });
    expect(out).toContain(
      '- persiana [de lunes a viernes a las 08:00, excepto festivos] — próxima: ',
    );
    expect(out).not.toMatch(/\[\d+ \d+ \*/);
  });

  it('panel: la tarjeta Rutinas dice el horario en palabras', () => {
    const filas = panelRoutines(
      [
        {
          scope: 'local',
          name: 'copia',
          kind: 'schedule',
          schedule: '0 3 * * 0,6',
          enabled: true,
          prompt: 'haz la copia',
        },
      ],
      [],
      () => '',
    );
    expect(filas[0]?.horario).toBe('los fines de semana a las 03:00');
  });

  it('un cron que no se sabe decir se enseña tal cual', () => {
    expect(horarioEnLista({ name: 'x', prompt: null, schedule: '0 9 1-7 * 1' })).toBe(
      '0 9 1-7 * 1',
    );
    expect(horarioEnLista({ name: 'x', prompt: null, schedule: null })).toBe('sin horario');
  });
});
