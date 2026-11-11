import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand } from '../src/bandeja/comando.js';
import { eventoLinea } from '../src/bandeja/evento.js';
import { cardText, eventLine } from '../src/bandeja/formato.js';
import { BandejaQueue } from '../src/bandeja/procesar.js';
import { composeDigest } from '../src/bandeja/resumen.js';
import { BandejaStore } from '../src/bandeja/store.js';

const TZ = 'Europe/Madrid';
const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
const EV = {
  nombre: 'Value Investing Forum 2026',
  inicio: '2026-11-20T09:30:00+01:00',
  fin: '2026-11-20T18:00:00+01:00',
  lugar: 'IFEMA, Madrid',
};

let dir = '';
let store: BandejaStore;
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = TZ;
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps14-bandeja-fecha-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function evento(extra: Record<string, unknown> = { evento: EV }) {
  const { item } = store.add(
    CHAT,
    { kind: 'enlace', url: 'https://vif.example/2026' },
    NOV11,
    '2026-11-11',
  );
  store.saveResult(
    item.id,
    {
      title: 'VIF 2026',
      verdict: 'ideas',
      score: 7,
      reason: 'Buen cartel de ponentes.',
      ideas: ['a'],
      costMin: 3,
      costLabel: '📰 ~3 min de lectura',
      extra: { source: 'vif.example', basis: 'texto', ...extra },
    },
    NOV11,
  );
  const fresh = store.get(item.id);
  if (!fresh) throw new Error('sin cosa');
  return fresh;
}

describe('gaps-14: la fecha del evento en la ficha y en el resumen de la noche', () => {
  it('la línea dice día, hora y sitio en su zona, y «(ya pasó)» si pasó', () => {
    expect(eventoLinea(EV, TZ, NOV11)).toBe('📅 viernes 20 nov, 09:30–18:00 · IFEMA, Madrid');
    expect(eventoLinea(EV, TZ, new Date('2026-11-21T10:00:00Z'))).toBe(
      '📅 viernes 20 nov, 09:30–18:00 · IFEMA, Madrid (ya pasó)',
    );
    expect(eventoLinea({ nombre: 'Junta', inicio: '2026-12-02' }, TZ, NOV11)).toBe(
      '📅 miércoles 2 dic (todo el día)',
    );
    // En Nueva York es otra hora.
    expect(eventoLinea(EV, 'America/New_York', NOV11)).toContain('03:30–12:00');
  });

  it('la ficha la lleva debajo del título; una página normal no', () => {
    const it1 = evento();
    const card = cardText(it1, NOV11).split('\n');
    expect(card[1]).toContain('VIF 2026');
    expect(card).toContain('📅 viernes 20 nov, 09:30–18:00 · IFEMA, Madrid');
    const normal = evento({});
    expect(eventLine(normal, NOV11)).toBeNull();
    expect(cardText(normal, NOV11)).not.toContain('📅');
  });

  it('el resumen la lleva y añade «📅 N calendario» (solo si no ha pasado)', () => {
    const it1 = evento();
    const d = composeDigest([it1], '2026-11-11', NOV11);
    expect(d.text).toContain('   📅 viernes 20 nov, 09:30–18:00 · IFEMA, Madrid');
    const cal = d.buttons.filter((b) => b.label === `📅 ${it1.id} calendario`);
    expect(cal).toHaveLength(1);
    expect(cal[0]?.action).toContain(`bandeja calendario ${it1.id}`);
    const tarde = composeDigest([it1], '2026-11-21', new Date('2026-11-21T20:00:00Z'));
    expect(tarde.text).toContain('(ya pasó)');
    expect(tarde.buttons.some((b) => b.label.startsWith('📅'))).toBe(false);
  });

  it('«/bandeja ver N» la enseña', async () => {
    const it1 = evento();
    const r = await bandejaCommand(`ver ${it1.id}`, {
      store,
      queue: new BandejaQueue(store, {
        complete: async () => async () => '',
        fetchRaw: async () => '',
        videoText: async () => ({ ok: false, reason: 'no' }),
      }),
      chatId: CHAT,
      now: () => NOV11,
      timeZone: () => TZ,
    });
    expect(r.text).toContain('📅 viernes 20 nov, 09:30–18:00 · IFEMA, Madrid');
  });
});
