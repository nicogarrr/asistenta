/**
 * La herramienta `rutina`: el modelo programa una tarea que Asistenta HACE sola a su
 * hora («cada lunes a las 9 revisa el gasto») y cuyo resultado avisa en el chat. No
 * es un recordatorio (eso avisa al dueño para que lo haga él): las rutinas que crea
 * son kind 'schedule' con prompt, las mismas de /cron add, visibles con /cron.
 * Guardas: la tarea cabe en 300 caracteres, ninguna rutina dispara más de una vez
 * por hora (cada ejecución habla con el modelo) y hay tope por chat.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import {
  checkRoutineFrequency,
  createRoutineTool,
  MAX_AGENT_ROUTINES_PER_CHAT,
} from '../src/tools/rutina.js';

let dir = '';
let store: Store;
let syncs = 0;
// Lunes 5 de octubre de 2026, 10:00 local.
const NOW = new Date(2026, 9, 5, 10, 0, 0).getTime();

function tool() {
  return createRoutineTool({
    store,
    scopeOf: () => 'tg:1:2',
    sync: () => {
      syncs++;
    },
    now: () => NOW,
  });
}

async function run(args: Record<string, unknown>) {
  const res = await tool().execute('id', args as never);
  const first = res.content[0];
  return { text: first && first.type === 'text' ? first.text : '', isError: res.isError === true };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rutina-'));
  store = new Store(join(dir, 'db.sqlite'));
  syncs = 0;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('rutina: create', () => {
  it('programa «cada lunes a las 9 revisar el gasto» y confirma que avisará aquí', async () => {
    const r = await run({ action: 'create', said: 'cada lunes a las 9 revisar el gasto' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Rutina "');
    expect(r.text).toContain('revisar el gasto');
    expect(r.text).toContain('Próxima ejecución:');
    expect(r.text).toContain('avisará en este chat');
    expect(syncs).toBe(1);
    const rows = store.listRoutines('tg:1:2');
    expect(rows).toHaveLength(1);
    const [saved] = rows;
    expect(saved?.kind).toBe('schedule');
    expect(saved?.schedule).toBe('0 9 * * 1');
    expect(saved?.prompt).toBe('cada lunes a las 9 revisar el gasto');
    expect(saved?.enabled).toBe(true);
  });

  it('acepta el formato con barra «0 8 * * 1-5 | resumen del día»', async () => {
    const r = await run({ action: 'create', said: '0 8 * * 1-5 | resumen del día' });
    expect(r.isError).toBe(false);
    const rows = store.listRoutines('tg:1:2');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.schedule).toBe('0 8 * * 1-5');
    expect(rows[0]?.prompt).toBe('resumen del día');
  });

  it('rechaza lo que no se entiende y pide otra redacción', async () => {
    const r = await run({ action: 'create', said: 'cuando puedas mira eso' });
    expect(r.isError).toBe(true);
    expect(store.listRoutines('tg:1:2')).toHaveLength(0);
    expect(syncs).toBe(0);
  });

  it('sin said, error claro', async () => {
    const r = await run({ action: 'create' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('said');
  });

  it('no admite disparar más de una vez por hora (gasto de modelo)', async () => {
    const r = await run({ action: 'create', said: '*/30 * * * * | mira el gasto' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('una vez por hora');
    expect(store.listRoutines('tg:1:2')).toHaveLength(0);
  });

  it('respeta el tope por chat', async () => {
    for (let i = 0; i < MAX_AGENT_ROUTINES_PER_CHAT; i++) {
      store.saveRoutine({
        scope: 'tg:1:2',
        name: `rutina-${i}`,
        kind: 'schedule',
        prompt: `tarea ${i}`,
        schedule: '0 9 * * 1',
      });
    }
    const r = await run({ action: 'create', said: 'cada lunes a las 9 revisar el gasto' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(String(MAX_AGENT_ROUTINES_PER_CHAT));
    expect(
      store.listRoutines('tg:1:2').filter((x) => !x.name.startsWith('recordatorio')),
    ).toHaveLength(MAX_AGENT_ROUTINES_PER_CHAT);
  });
});

describe('rutina: list', () => {
  it('sin rutinas, invita a crear una', async () => {
    const r = await run({ action: 'list' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('No tienes rutinas programadas');
  });

  it('enseña nombre, horario y próxima ejecución; los recordatorios NO salen', async () => {
    await run({ action: 'create', said: 'cada lunes a las 9 revisar el gasto' });
    store.saveRoutine({
      scope: 'tg:1:2',
      name: 'recordatorio:tomar-pastilla',
      kind: 'schedule',
      prompt: 'tomar la pastilla',
      schedule: '0 8 * * *',
    });
    const r = await run({ action: 'list' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('revisar el gasto');
    expect(r.text).toContain('próxima:');
    expect(r.text).not.toContain('pastilla');
  });
});

describe('rutina: pause / resume / cancel', () => {
  beforeEach(async () => {
    await run({ action: 'create', said: 'cada lunes a las 9 revisar el gasto' });
    syncs = 0;
  });

  it('pause la detiene y resume la devuelve a su horario', async () => {
    const p = await run({ action: 'pause', said: 'gasto' });
    expect(p.isError).toBe(false);
    expect(p.text).toContain('en pausa');
    expect(store.listRoutines('tg:1:2')[0]?.enabled).toBe(false);
    expect(syncs).toBe(1);

    const p2 = await run({ action: 'pause', said: 'gasto' });
    expect(p2.isError).toBe(false);
    expect(p2.text).toContain('ya estaba en pausa');

    const res = await run({ action: 'resume', said: 'gasto' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('otra vez en marcha');
    expect(store.listRoutines('tg:1:2')[0]?.enabled).toBe(true);
  });

  it('cancel la quita; la segunda vez ya no está', async () => {
    const c = await run({ action: 'cancel', said: 'gasto' });
    expect(c.isError).toBe(false);
    expect(c.text).toContain('quitada');
    expect(store.listRoutines('tg:1:2')).toHaveLength(0);
    const c2 = await run({ action: 'cancel', said: 'gasto' });
    expect(c2.isError).toBe(true);
    expect(c2.text).toContain('No encuentro');
  });

  it('no toca un recordatorio aunque la palabra coincida', async () => {
    store.saveRoutine({
      scope: 'tg:1:2',
      name: 'recordatorio:revisar-gasto',
      kind: 'schedule',
      prompt: 'revisar el gasto',
      schedule: '0 9 * * *',
    });
    // «gasto» coincide con la rutina y no con el recordatorio: borra la rutina…
    const c = await run({ action: 'cancel', said: 'gasto' });
    expect(c.isError).toBe(false);
    expect(store.getRoutine('tg:1:2', 'recordatorio:revisar-gasto')).not.toBeNull();
    // …y con la rutina ya quitada, el recordatorio sigue sin ser alcanzable aquí.
    const c2 = await run({ action: 'cancel', said: 'gasto' });
    expect(c2.isError).toBe(true);
    expect(store.getRoutine('tg:1:2', 'recordatorio:revisar-gasto')).not.toBeNull();
  });

  it('ambigüedad: pide cuál de las rutinas', async () => {
    await run({ action: 'create', said: 'cada viernes a las 9 revisar el gasto grande' });
    const p = await run({ action: 'pause', said: 'gasto' });
    expect(p.isError).toBe(true);
    expect(p.text).toContain('Dime cuál');
  });
});

describe('checkRoutineFrequency', () => {
  it('acepta una vez por hora justa, rechaza menos', () => {
    expect(checkRoutineFrequency('0 9 * * 1')).toBeNull();
    expect(checkRoutineFrequency('0 * * * *')).toBeNull();
    expect(checkRoutineFrequency('*/30 * * * *')).not.toBeNull();
    expect(checkRoutineFrequency('*/5 9-18 * * *')).not.toBeNull();
  });
});
