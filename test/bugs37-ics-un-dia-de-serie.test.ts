import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand, icsAviso } from '../src/bandeja/comando.js';
import { BandejaQueue, processItem } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import type { EventoArgs } from '../src/google/workspace.js';
import { parseIcs } from '../src/ics.js';

// Outlook: «se cancela solo la del jueves 26» de una reunión semanal (solo el VEVENT con
// RECURRENCE-ID, sin la serie).
const SERIE = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:040000008200E00074C5B7101A82E008@outlook',
  'DTSTART;TZID=Europe/Madrid:20261119T100000',
  'DTEND;TZID=Europe/Madrid:20261119T110000',
  'RRULE:FREQ=WEEKLY;BYDAY=TH',
  'SUMMARY:Comité de inversiones',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const UNO = (metodo: string, dia: string) =>
  [
    'BEGIN:VCALENDAR',
    `METHOD:${metodo}`,
    'BEGIN:VEVENT',
    'UID:040000008200E00074C5B7101A82E008@outlook',
    `RECURRENCE-ID;TZID=Europe/Madrid:${dia}T100000`,
    `DTSTART;TZID=Europe/Madrid:${dia}T100000`,
    `DTEND;TZID=Europe/Madrid:${dia}T110000`,
    'SUMMARY:Comité de inversiones',
    ...(metodo === 'CANCEL' ? ['STATUS:CANCELLED'] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
let dir = '';
let store: BandejaStore;
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs37-ics-uno-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const procDeps = (ics: string) => ({
  complete: async () => {
    throw new Error('no debe llamar al modelo');
  },
  fetchRaw: async () => '',
  videoText: async () => ({ ok: false as const, reason: 'no' }),
  download: async () => Buffer.from(ics),
});
let n = 0;
async function ics(texto: string) {
  n++;
  const { item } = store.add(
    CHAT,
    { kind: 'texto', fileId: `F${n}`, mimeType: 'text/calendar', fileName: `i${n}.ics` },
    NOV11,
    '2026-11-11',
  );
  store.saveResult(item.id, await processItem(item, procDeps(texto) as never), NOV11);
  const it = store.get(item.id);
  if (!it) throw new Error('sin cosa');
  return it;
}
const borrados: string[] = [];
const deps = {
  get store() {
    return store;
  },
  get queue() {
    return new BandejaQueue(store, procDeps('') as never);
  },
  chatId: CHAT,
  now: () => NOV11,
  timeZone: () => 'Europe/Madrid',
  calendario: async (a: EventoArgs) => `📅 Apuntado en tu Google Calendar: «${a.titulo}». (id g1)`,
  quitarCalendario: async (id: string) => {
    borrados.push(id);
    return '🗑️ Borrado de tu Google Calendar.';
  },
};

describe('bugs-37: un .ics de un solo día de una serie (RECURRENCE-ID)', () => {
  it('se lee (antes: ⚠️ «el .ics no trae ningún evento con fecha»)', async () => {
    expect(parseIcs(UNO('CANCEL', '20261126')).eventos).toHaveLength(1);
    const c = await ics(UNO('CANCEL', '20261126'));
    expect(c.status).toBe('listo');
    expect(c.reason).toContain('un solo día de «Comité de inversiones» (la serie sigue)');
    // Con la serie en el mismo .ics, solo cuenta la serie (como antes).
    const ambos = SERIE.replace(
      'END:VCALENDAR',
      UNO('REQUEST', '20261126').split('\r\n').slice(2).join('\r\n'),
    );
    expect(parseIcs(ambos).eventos.map((e) => e.repite)).toEqual([true]);
  });

  it('cancelar otro día de la serie no ofrece quitar lo apuntado ni bloquea la serie', async () => {
    borrados.length = 0;
    const serie = await ics(SERIE);
    expect((await bandejaCommand(`apuntar ${serie.id}`, deps)).text).toMatch(/^📅 Apuntado/);
    const aviso = await icsAviso(await ics(UNO('CANCEL', '20261126')), deps);
    expect(aviso?.buttons ?? []).toEqual([]);
    expect(aviso?.text).toContain('la serie sigue');
    expect(borrados).toEqual([]);
  });

  it('cancelar justo el día que se apuntó sí ofrece quitarlo', async () => {
    const serie = await ics(SERIE);
    await bandejaCommand(`apuntar ${serie.id}`, deps);
    const aviso = await icsAviso(await ics(UNO('CANCEL', '20261119')), deps);
    expect(aviso?.text).toContain('¿lo quito?');
  });

  it('un cambio de un solo día se puede apuntar, sin tomarse por la serie', async () => {
    const uno = await ics(UNO('REQUEST', '20261126'));
    expect(uno.extra.evento?.nombre).toBe('Comité de inversiones');
    expect(uno.extra.icsUid).toBeUndefined();
    expect(uno.reason).toContain('Cambio en un solo día');
  });
});
