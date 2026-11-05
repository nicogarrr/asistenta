import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBriefing } from '../src/briefing.js';
import { composeDailyBriefing } from '../src/briefing-daily.js';
import { buildContextNote } from '../src/daemon/context-note.js';
import { Store } from '../src/db.js';
import {
  knownDates,
  upcomingDateLine,
  upcomingDates,
  upcomingDatesNote,
} from '../src/memory/fechas.js';
import { MemorySnapshot } from '../src/memory/snapshot.js';
import { MemoryStore } from '../src/memory.js';

/**
 * agente-2: Nico contaba «el cumple de mi madre es el 6 de noviembre» y quedaba apuntado,
 * pero nadie miraba el calendario: ni el resumen de la mañana ni el modelo sabían que era
 * mañana. Ahora las fechas apuntadas que caen en los próximos 7 días salen en el resumen
 * («Fechas») y en la nota de contexto de cada turno.
 */
describe('fechas que Nico contó', () => {
  // Jueves 5 de noviembre de 2026, 10:00 en Madrid.
  const NOW = new Date('2026-11-05T09:00:00Z');
  const TZ = 'Europe/Madrid';
  const ENTRIES = [
    '[dicho] Mi cumpleaños es el 3 de mayo',
    '[dicho] El cumple de mi madre es el 6 de noviembre',
    '[dicho] Mi aniversario con Ana es el 8/11',
    'Javi cumple años el 20 de noviembre',
    '[dicho] El santo de mi padre es el 5 de noviembre',
    '[dicho] Mi dentista es el Dr. García',
    'Reunión el 6 de noviembre con el banco',
    '[auto] Mi hermana nació el 29 de febrero',
  ];

  it('lee de quién es cada fecha', () => {
    expect(knownDates(ENTRIES)).toEqual([
      { label: 'tu cumpleaños', month: 5, day: 3 },
      { label: 'cumple de tu madre', month: 11, day: 6 },
      { label: 'tu aniversario con ana', month: 11, day: 8 },
      { label: 'cumple de javi', month: 11, day: 20 },
      { label: 'santo de tu padre', month: 11, day: 5 },
    ]);
  });

  it('las de los próximos 7 días, la más cercana primero', () => {
    const up = upcomingDates(ENTRIES, NOW, 7, TZ);
    expect(up.map(upcomingDateLine)).toEqual([
      'Hoy: santo de tu padre',
      'Mañana (vie 06/11): cumple de tu madre',
      'Dom 08/11 (en 3 días): tu aniversario con ana',
    ]);
  });

  it('a fin de año mira el año siguiente', () => {
    const up = upcomingDates(
      ['El cumple de mi madre es el 2 de enero'],
      new Date('2026-12-30T10:00:00Z'),
      7,
      TZ,
    );
    expect(up.map((d) => [d.label, d.inDays])).toEqual([['cumple de tu madre', 3]]);
  });

  it('nota para el modelo solo si hay algo', () => {
    expect(upcomingDatesNote([])).toBe('');
    const note = upcomingDatesNote(upcomingDates(ENTRIES, NOW, 7, TZ));
    expect(note).toContain('<fechas>');
    expect(note).toContain('mañana (vie 06/11): cumple de su madre');
  });

  it('el resumen de la mañana trae la sección «Fechas»', () => {
    const text = buildBriefing({
      greeting: 'Buenos días',
      today: NOW,
      agenda: [],
      routines: [],
      reminders: [],
      followups: [],
      dates: upcomingDates(ENTRIES, NOW, 7, TZ),
    });
    expect(text).toContain(
      'Fechas\n- Hoy: santo de tu padre\n- Mañana (vie 06/11): cumple de tu madre',
    );
  });

  it('un cumpleaños hoy o mañana basta para mandar el resumen; dentro de 5 días, no', async () => {
    const base = {
      enabled: () => true,
      now: () => NOW,
      lastSent: () => 0,
      markSent: () => {},
      owner: () => '1',
      send: async () => true,
    };
    const soon = await composeDailyBriefing({
      ...base,
      dates: () => upcomingDates(['El cumple de mi madre es el 6 de noviembre'], NOW, 7, TZ),
    });
    expect(soon.empty).toBe(false);
    expect(soon.text).toContain('cumple de tu madre');
    const later = await composeDailyBriefing({
      ...base,
      dates: () => upcomingDates(['El cumple de mi madre es el 10 de noviembre'], NOW, 7, TZ),
    });
    expect(later.empty).toBe(true);
  });
});

describe('nota del turno: el modelo sabe qué cumpleaños caen pronto', () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const c of closers.splice(0)) c();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const note = (entries: string[], ownerView: boolean) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T09:00:00Z'));
    const dir = mkdtempSync(join(tmpdir(), 'ag2-fechas-'));
    dirs.push(dir);
    const store = new Store(join(dir, 'db.sqlite'));
    closers.push(() => store.close());
    const snapshot = new MemorySnapshot({ dir: join(dir, 'snapshot') });
    for (const e of entries) snapshot.appendEntry(e);
    return buildContextNote(
      { key: 'telegram:1', name: 'main' },
      store,
      new MemoryStore(join(dir, 'memory')),
      snapshot,
      undefined,
      undefined,
      undefined,
      undefined,
      'hola',
      ownerView,
    );
  };

  it('en su chat privado, con un cumple mañana, sale <fechas>', () => {
    const text = note(['[dicho] El cumple de mi madre es el 6 de noviembre'], true);
    expect(text).toContain('<fechas>');
    expect(text).toContain('cumple de su madre');
  });

  it('sin nada en 7 días, o fuera de su chat privado, no sale nada', () => {
    expect(note(['[dicho] El cumple de mi madre es el 20 de diciembre'], true)).not.toContain(
      '<fechas>',
    );
    expect(note(['[dicho] El cumple de mi madre es el 6 de noviembre'], false)).not.toContain(
      '<fechas>',
    );
  });
});
