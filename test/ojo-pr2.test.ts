import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AgendaItem, UnifiedAgenda } from '../src/agenda/unified.js';
import {
  activateRule,
  classKey,
  confirmNotices,
  deleteRule,
  dismissNotice,
  formatRules,
  lastNoticeNumber,
  listRules,
  reserveNotices,
  titlePattern,
} from '../src/ojo-ignore.js';
import { isOwnerDm, runVigilanteOnce } from '../src/vigilante.js';

const TZ = 'Europe/Madrid';
const H = 3_600_000;
const BASE = new Date('2026-10-12T10:00:00+02:00').getTime();

const agenda = (items: AgendaItem[]): UnifiedAgenda => ({
  today: [],
  upcoming: items,
  pending: [],
  generatedAt: BASE,
  days: 7,
  counts: { calendar: 0, mail: items.length, pending: 0 },
  notes: [],
});
const dl = (title: string, when: number, extra: Partial<AgendaItem> = {}): AgendaItem => ({
  title,
  at: when,
  kind: 'deadline',
  where: 'correo',
  timed: true,
  ...extra,
});

function rig(getItems: () => AgendaItem[], ok = () => true) {
  const db = new DatabaseSync(':memory:');
  const sent: string[] = [];
  let now = BASE;
  return {
    db,
    sent,
    at: (t: number) => {
      now = t;
    },
    run: () =>
      runVigilanteOnce(
        {
          db,
          agenda: async () => agenda(getItems()),
          send: async (t) => {
            if (!ok()) return false;
            sent.push(t);
            return true;
          },
          now: () => now,
        },
        TZ,
      ),
  };
}

describe('titlePattern y clase', () => {
  it('ignora acentos, dígitos y puntuación y se queda con 4 palabras', () => {
    expect(titlePattern('Factura nº 1234 del Taller García - octubre 2026')).toBe(
      'factura del taller garcia',
    );
    expect(titlePattern('FACTURA del taller 99')).toBe(titlePattern('factura del taller 12'));
    expect(titlePattern('123 456')).toBe('');
  });
  it('la clase distingue tipo y fuente', () => {
    const a = dl('Factura taller 1', BASE + 30 * H);
    expect(classKey(a)).toBe(classKey(dl('Factura taller 2', BASE + 50 * H)));
    expect(classKey(a)).not.toBe(classKey({ ...a, where: 'calendario' }));
    expect(classKey(a)).not.toBe(classKey({ ...a, kind: 'payment' }));
    expect(classKey(dl('2026', BASE))).toBeNull();
  });
});

describe('avisos numerados', () => {
  it('cada aviso lleva [#n], correlativos entre mensajes, y un envío fallido no gasta números', async () => {
    let fail = true;
    let items = [dl('Plazo uno', BASE + 30 * H), dl('Plazo dos', BASE + 60 * H)];
    const r = rig(
      () => items,
      () => !fail,
    );
    await r.run();
    expect(r.sent).toHaveLength(0);
    expect(lastNoticeNumber(r.db)).toBe(0);
    fail = false;
    await r.run();
    expect(r.sent[0]).toContain('[#1]');
    expect(r.sent[0]).toContain('[#2]');
    items = [...items, dl('Plazo tres', BASE + 90 * H)];
    await r.run();
    expect(r.sent[1]).toContain('[#3]');
  });
});

describe('/ignora: descartar, contar y proponer', () => {
  const setup = async () => {
    const items = [
      dl('Factura taller 111', BASE + 30 * H),
      dl('Factura taller 222', BASE + 54 * H),
      dl('Renovación seguro', BASE + 78 * H),
    ];
    const r = rig(() => items);
    await r.run();
    return { r, items };
  };

  it('número inexistente, repetido e idempotente', async () => {
    const { r } = await setup();
    expect(dismissNotice(r.db, 99, 1)).toMatchObject({ ok: false });
    const first = dismissNotice(r.db, 1, 1);
    expect(first).toMatchObject({ ok: true, already: false, proposal: null });
    expect(dismissNotice(r.db, 1, 2)).toMatchObject({ ok: true, already: true });
    expect(listRules(r.db)).toHaveLength(0); // el mismo aviso dos veces no cuenta dos
  });

  it('dos avisos distintos de la misma clase proponen una regla, sin activarla', async () => {
    const { r } = await setup();
    dismissNotice(r.db, 1, 1);
    const second = dismissNotice(r.db, 2, 2);
    expect(second).toMatchObject({ ok: true });
    if (second.ok) {
      expect(second.proposal?.status).toBe('propuesta');
      expect(second.proposal?.pattern).toBe('factura taller');
    }
    expect(listRules(r.db)[0]?.status).toBe('propuesta');
    // propuesta: nada se silencia todavía
    const again = dismissNotice(r.db, 3, 3); // otra clase, no propone
    expect(again).toMatchObject({ ok: true, proposal: null });
  });

  it('un aviso de otra clase no cuenta', async () => {
    const { r } = await setup();
    dismissNotice(r.db, 1, 1);
    dismissNotice(r.db, 3, 2);
    expect(listRules(r.db)).toHaveLength(0);
  });

  it('descartar un aviso detiene sus recordatorios (y el control de otra clase sí recuerda)', async () => {
    const items = [dl('Factura taller 111', BASE + 30 * H), dl('Seguro del coche', BASE + 30 * H)];
    const r = rig(() => items);
    await r.run();
    dismissNotice(r.db, 1, 1);
    r.at(BASE + 30 * H - 24 * H + 60_000);
    await r.run();
    const text = r.sent.slice(1).join('\n');
    expect(text).toContain('Recordatorio');
    expect(text).toContain('Seguro del coche');
    expect(text).not.toContain('Factura taller 111');
  });

  it('una propuesta no silencia; activada silencia descubrimiento y recordatorios de la clase, no otras', async () => {
    const items = [
      dl('Factura taller 111', BASE + 30 * H),
      dl('Factura taller 222', BASE + 54 * H),
    ];
    const r = rig(() => items);
    await r.run();
    dismissNotice(r.db, 1, 1);
    dismissNotice(r.db, 2, 2);
    // propuesta: un nuevo aviso de la clase sí sale
    items.push(dl('Factura taller 333', BASE + 80 * H));
    await r.run();
    expect(r.sent.at(-1)).toContain('Factura taller 333');
    const id = listRules(r.db)[0]?.id as number;
    expect(activateRule(r.db, id)).toEqual({ ok: true });
    expect(activateRule(r.db, id)).toMatchObject({ ok: false });
    items.push(dl('Factura taller 444', BASE + 100 * H));
    items.push(dl('Seguro del coche', BASE + 100 * H));
    const before = r.sent.length;
    await r.run();
    const msg = r.sent.slice(before).join('\n');
    expect(msg).toContain('Seguro del coche');
    expect(msg).not.toContain('Factura taller 444');
  });

  it('borrar la regla restaura los avisos y reinicia el conteo', async () => {
    const items = [
      dl('Factura taller 111', BASE + 30 * H),
      dl('Factura taller 222', BASE + 54 * H),
    ];
    const r = rig(() => items);
    await r.run();
    dismissNotice(r.db, 1, 1);
    dismissNotice(r.db, 2, 2);
    const id = listRules(r.db)[0]?.id as number;
    activateRule(r.db, id);
    items.push(dl('Factura taller 555', BASE + 80 * H));
    await r.run();
    expect(r.sent.join('\n')).not.toContain('Factura taller 555');
    expect(deleteRule(r.db, id)).toEqual({ ok: true });
    await r.run();
    expect(r.sent.at(-1)).toContain('Factura taller 555');
    expect(listRules(r.db)).toHaveLength(0);
    // el conteo se reinició: un solo descarte nuevo no propone
    expect(dismissNotice(r.db, lastNoticeNumber(r.db), 9)).toMatchObject({
      ok: true,
      proposal: null,
    });
  });

  it('formatRules lista id, estado, clase y contador', async () => {
    const { r } = await setup();
    expect(formatRules(listRules(r.db))).toContain('No hay reglas');
    dismissNotice(r.db, 1, 1);
    dismissNotice(r.db, 2, 2);
    const text = formatRules(listRules(r.db));
    expect(text).toContain('[propuesta]');
    expect(text).toContain('«factura taller»');
    expect(text).toContain('descartados: 2');
  });
});

describe('salvaguarda crítica <2h', () => {
  const pay = (title: string, when: number): AgendaItem => ({
    title,
    at: when,
    kind: 'payment',
    where: 'correo',
    timed: true,
  });

  it('un pago con regla activa de su clase descubierto a <2 h se avisa igualmente', async () => {
    const items = [pay('Cargo tarjeta 1', BASE + 30 * H), pay('Cargo tarjeta 2', BASE + 54 * H)];
    const r = rig(() => items);
    await r.run();
    dismissNotice(r.db, 1, 1);
    dismissNotice(r.db, 2, 2);
    activateRule(r.db, listRules(r.db)[0]?.id as number);
    items.push(pay('Cargo tarjeta 3', BASE + 80 * H)); // no crítico: silenciado por la regla
    items.push(pay('Cargo tarjeta 4', BASE + 60 * 60_000)); // a 1 h: crítico
    const before = r.sent.length;
    await r.run();
    const msg = r.sent.slice(before).join('\n');
    expect(msg).toContain('Cargo tarjeta 4');
    expect(msg).not.toContain('Cargo tarjeta 3');
  });

  it('un pago descartado sigue recibiendo su recordatorio cuando pasa a ser crítico', async () => {
    const items = [pay('Cargo único', BASE + 3 * H)];
    const r = rig(() => items);
    await r.run(); // descubrimiento, aún no crítico
    dismissNotice(r.db, 1, 1);
    r.at(BASE + 3 * H - 2 * H + 60_000); // a 1 h 59 min: crítico
    await r.run();
    expect(r.sent.slice(1).join('\n')).toContain('Cargo único');
    // lo mismo con un plazo con hora
    const items2 = [dl('Plazo suave', BASE + 5 * H)];
    const r2 = rig(() => items2);
    await r2.run();
    dismissNotice(r2.db, 1, 1);
    r2.at(BASE + 5 * H - 2 * H + 60_000); // 1 h 59 min: plazo con hora, también crítico
    await r2.run();
    expect(r2.sent.slice(1).join('\n')).toContain('Plazo suave');
  });
});

describe('R1: la salvaguarda crítica avisa al ENTRAR en <2 h', () => {
  it('T-2h exacto servido y descartado: a 1h59 se avisa una vez, y no se repite', async () => {
    const pay = dl('Pago hipoteca banco', BASE + 3 * H, { kind: 'payment' });
    const r = rig(() => [pay]);
    await r.run(); // descubrimiento a 3 h: #1
    r.at(BASE + H); // exactamente 2 h: T2 sale, no es crítico todavía
    await r.run();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]).toContain('[#2]');
    dismissNotice(r.db, 2, BASE + H);
    r.at(BASE + H + 60_000); // 1h59
    await r.run();
    expect(r.sent).toHaveLength(3);
    expect(r.sent[2]).toContain('Pago hipoteca banco');
    r.at(BASE + H + 120_000);
    await r.run();
    expect(r.sent).toHaveLength(3); // sin repetir cada barrido
  });
});

describe('R1: reserva y serialización de números', () => {
  it('dos barridos solapados con el mismo DB no comparten número', async () => {
    const db = new DatabaseSync(':memory:');
    const sent: string[] = [];
    let items = [dl('Plazo uno', BASE + 30 * H)];
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let first = true;
    const deps = {
      db,
      agenda: async () => agenda(items),
      send: async (t: string) => {
        if (first) {
          first = false;
          await gate;
        }
        sent.push(t);
        return true;
      },
      now: () => BASE,
    };
    const a = runVigilanteOnce(deps, TZ);
    await new Promise((r) => setTimeout(r, 20));
    // A está en vuelo: su número existe pero aún no se puede descartar
    expect(dismissNotice(db, 1, 1)).toMatchObject({ ok: false });
    items = [...items, dl('Plazo dos', BASE + 60 * H)];
    const b = runVigilanteOnce(deps, TZ);
    release();
    await Promise.all([a, b]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('[#1]');
    expect(sent[1]).toContain('[#2]');
    expect(sent[1]).not.toContain('[#1]');
    const t = db.prepare('SELECT n, title FROM vigilante_notices ORDER BY n').all();
    expect(t).toHaveLength(2);
  });
  it('envío fallido: reservas sueltas y el reintento reutiliza el número', async () => {
    let fail = true;
    const r = rig(
      () => [dl('Plazo uno', BASE + 30 * H)],
      () => !fail,
    );
    await r.run();
    expect(r.db.prepare('SELECT count(*) AS c FROM vigilante_notices').get()).toEqual({ c: 0 });
    fail = false;
    await r.run();
    expect(r.sent[0]).toContain('[#1]');
  });
});

describe('R1: privacidad de los comandos', () => {
  it('solo el DM del owner verificado', () => {
    expect(isOwnerDm({ channel: 'telegram', chatId: '42', userId: '42' }, 42)).toBe(true);
    expect(isOwnerDm({ channel: 'telegram', chatId: '-100', userId: '42' }, 42)).toBe(false);
    expect(isOwnerDm({ channel: 'telegram', chatId: '7', userId: '7' }, 42)).toBe(false);
    expect(isOwnerDm({ channel: 'discord', chatId: '42', userId: '42' }, 42)).toBe(false);
    expect(isOwnerDm({ channel: 'telegram', chatId: '42', userId: '42' }, null)).toBe(false);
  });
});

describe('R1: conteo visible y estado exacto', () => {
  it('muestra ocurrencias distintas y activar exige propuesta', () => {
    const db = new DatabaseSync(':memory:');
    const a = dl('Factura taller 111', BASE + 30 * H);
    const b = dl('Factura taller 222', BASE + 54 * H);
    const ns = reserveNotices(db, [a, a, b], 1);
    confirmNotices(db, ns);
    dismissNotice(db, ns[0] as number, 1);
    dismissNotice(db, ns[1] as number, 2);
    expect(listRules(db)).toHaveLength(0);
    dismissNotice(db, ns[2] as number, 3);
    const rules = listRules(db);
    expect(rules[0]?.dismissed).toBe(2);
    expect(formatRules(rules)).toContain('avisos distintos descartados: 2');
    db.prepare("UPDATE vigilante_rules SET status = 'rara'").run();
    expect(activateRule(db, rules[0]?.id as number)).toMatchObject({ ok: false });
  });
});
