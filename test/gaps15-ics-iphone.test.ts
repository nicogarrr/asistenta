import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand } from '../src/bandeja/comando.js';
import { BandejaQueue } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import { icsDeEvento, icsNombre, parseIcs } from '../src/ics.js';

const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
const MAD = 'Europe/Madrid';
let dir = '';
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps15-ics-iphone-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function evento(ev: Record<string, unknown>) {
  const { item } = store.add(
    CHAT,
    { kind: 'enlace', url: 'https://junta.example/2026' },
    NOV11,
    '2026-11-11',
  );
  store.saveResult(
    item.id,
    {
      title: 'Junta',
      verdict: 'ideas',
      score: 6,
      reason: 'x',
      ideas: [],
      costMin: 2,
      costLabel: '📰 ~2 min de lectura',
      extra: { source: 'junta.example', basis: 'texto', evento: ev as never },
    },
    NOV11,
  );
  return item.id;
}

const deps = (calendario?: () => Promise<string>) => ({
  store,
  queue: new BandejaQueue(store, {
    complete: async () => async () => '',
    fetchRaw: async () => '',
    videoText: async () => ({ ok: false as const, reason: 'no' }),
  }),
  chatId: CHAT,
  now: () => NOV11,
  timeZone: () => MAD,
  ...(calendario ? { calendario } : {}),
});

describe('gaps-15: «📲 .ics (iPhone)» — el evento sin Google', () => {
  it('icsDeEvento: hora de Madrid a UTC, escapes, 1 h por defecto, y se vuelve a leer igual', () => {
    const ics = icsDeEvento(
      { titulo: 'Junta, Q4; votación', inicio: '2026-11-20T09:30', lugar: 'IFEMA, Madrid' },
      MAD,
      { uid: 'bandeja-1@asistenta', now: NOV11 },
    );
    expect(ics).toContain('DTSTART:20261120T083000Z\r\nDTEND:20261120T093000Z');
    expect(ics).toContain('SUMMARY:Junta\\, Q4\\; votación');
    expect(ics).toContain('DTSTAMP:20261111T150000Z');
    expect(parseIcs(ics ?? '').eventos[0]).toEqual({
      nombre: 'Junta, Q4; votación',
      inicio: '2026-11-20T08:30:00Z',
      fin: '2026-11-20T09:30:00Z',
      lugar: 'IFEMA, Madrid',
      // bugs-37: el UID también se lee (la cancelación lo usa para quitar lo apuntado).
      uid: 'bandeja-1@asistenta',
    });
  });

  it('día entero con fin exclusivo; líneas largas plegadas a 75 octetos', () => {
    const ics =
      icsDeEvento(
        { titulo: 'Congreso '.repeat(20), inicio: '2026-12-02', fin: '2026-12-04' },
        MAD,
        {
          uid: 'u',
        },
      ) ?? '';
    expect(ics).toContain('DTSTART;VALUE=DATE:20261202\r\nDTEND;VALUE=DATE:20261204');
    for (const l of ics.split('\r\n')) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(icsDeEvento({ titulo: 'x', inicio: 'mañana' }, MAD, { uid: 'u' })).toBeNull();
    expect(icsNombre('Junta: 2026/Q4')).toBe('Junta 2026 Q4.ics');
    expect(icsNombre('')).toBe('evento.ics');
  });

  it('la pregunta de «📅 Al calendario» trae también «📲 .ics (iPhone)»', async () => {
    const id = evento({ nombre: 'Junta', inicio: '2026-11-20T09:30:00+01:00' });
    const r = await bandejaCommand(`calendario ${id}`, deps());
    expect((r.buttons ?? []).map((b) => commandFromCallback(b.action))).toEqual([
      `/bandeja apuntar ${id}`,
      `/bandeja ics ${id}`,
    ]);
  });

  it('«/bandeja ics N» da el fichero, aunque ya esté en Google', async () => {
    const id = evento({ nombre: 'Junta', inicio: '2026-11-20T09:30:00+01:00', lugar: 'IFEMA' });
    store.setMeta(`cal_added_${id}`, NOV11.toISOString());
    const r = await bandejaCommand(`ics ${id}`, deps());
    expect(r.file?.name).toBe('Junta.ics');
    expect(r.file?.bytes.toString('utf8')).toContain('LOCATION:IFEMA');
    expect(r.text).toMatch(/^📲 Te mando «Junta» \(viernes 20 nov, 09:30\) como \.ics/);
  });

  it('un evento pasado no da .ics; sin Google, «apuntar» ofrece el .ics', async () => {
    const viejo = evento({ nombre: 'Vieja', inicio: '2026-11-01T09:30:00+01:00' });
    expect((await bandejaCommand(`ics ${viejo}`, deps())).file).toBeUndefined();
    const id = evento({ nombre: 'Junta', inicio: '2026-11-20T09:30:00+01:00' });
    const r = await bandejaCommand(
      `apuntar ${id}`,
      deps(async () => '📅 Para apuntarlo conecta Google: /google conectar'),
    );
    expect(r.text).toContain('O toca «📲 .ics» y lo añades en el iPhone sin Google.');
    expect(commandFromCallback(r.buttons?.[0]?.action ?? '')).toBe(`/bandeja ics ${id}`);
    expect(store.getMeta(`cal_added_${id}`)).toBeNull();
  });

  it('cli manda el fichero detrás', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain('if (reply.file)');
  });
});
