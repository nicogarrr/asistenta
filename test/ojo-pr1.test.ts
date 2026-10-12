import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AgendaItem, UnifiedAgenda } from '../src/agenda/unified.js';
import { dueStages, findConflicts, inQuietHours, isCritical, stageInstants } from '../src/ojo.js';
import {
  findingKey,
  getOjoEnabled,
  runVigilanteOnce,
  setOjoEnabled,
  type VigilanteDeps,
} from '../src/vigilante.js';

const TZ = 'Europe/Madrid';
const H = 3_600_000;
const at = (iso: string): number => new Date(iso).getTime();
const BASE = at('2026-10-12T10:00:00+02:00');

function agenda(items: AgendaItem[]): UnifiedAgenda {
  return {
    today: [],
    upcoming: items,
    pending: [],
    generatedAt: BASE,
    days: 7,
    counts: { calendar: items.length, mail: 0, pending: 0 },
    notes: [],
  };
}

function rig(items: AgendaItem[], quiet?: VigilanteDeps['quiet']) {
  const db = new DatabaseSync(':memory:');
  const sent: string[] = [];
  let now = BASE;
  const run = async () =>
    runVigilanteOnce(
      {
        db,
        agenda: async () => agenda(items),
        send: async (t) => {
          sent.push(t);
          return true;
        },
        now: () => now,
        quiet,
      },
      TZ,
    );
  return {
    db,
    sent,
    run,
    at: (t: number) => {
      now = t;
    },
  };
}

const meeting = (title: string, when: number, extra: Partial<AgendaItem> = {}): AgendaItem => ({
  title,
  at: when,
  kind: 'meeting',
  where: 'calendario',
  timed: true,
  ...extra,
});

describe('recordatorios escalonados', () => {
  it('avisa al descubrir, luego T-24h y T-2h, cada uno una sola vez', async () => {
    const when = BASE + 30 * H;
    const r = rig([meeting('Reunión con gestoría', when)]);
    await r.run();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain('cosa nueva');
    await r.run();
    expect(r.sent).toHaveLength(1);
    r.at(when - 24 * H + 60_000);
    await r.run();
    await r.run();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]).toContain('Recordatorio');
    expect(r.sent[1]).toContain('en 24 h');
    r.at(when - 2 * H + 60_000);
    await r.run();
    await r.run();
    expect(r.sent).toHaveLength(3);
    expect(r.sent[2]).toContain('en 1 h 59 min');
    r.at(when - 60_000);
    await r.run();
    expect(r.sent).toHaveLength(3);
  });

  it('un hallazgo descubierto tarde no recibe recordatorios ya cubiertos por el propio aviso', async () => {
    const r = rig([meeting('Cita', BASE + 90 * 60_000)]);
    await r.run();
    await r.run();
    r.at(BASE + 20 * 60_000);
    await r.run();
    expect(r.sent).toHaveLength(1);
  });

  it('si el daemon estuvo apagado sale solo la etapa más cercana y las dos quedan marcadas', async () => {
    const when = BASE + 30 * H;
    const r = rig([meeting('Cita', when)]);
    await r.run();
    r.at(when - 90 * 60_000);
    await r.run();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]).toContain('en 1 h 30 min');
    r.at(when - 60 * 60_000);
    await r.run();
    expect(r.sent).toHaveLength(2);
  });

  it('lo vencido no se recuerda', () => {
    const item = meeting('Cita', BASE - H);
    expect(dueStages(item, TZ, BASE)).toEqual([]);
  });

  it('sin hora: solo "mañana" a las 09:00 del día anterior y nunca T-2h', () => {
    const item: AgendaItem = {
      title: 'Plazo IRPF',
      at: at('2026-10-15T00:00:00+02:00'),
      kind: 'deadline',
      where: 'correo',
      timed: false,
    };
    const st = stageInstants(item, TZ);
    expect(st).toHaveLength(1);
    expect(st[0]?.stage).toBe('t24');
    expect(st[0]?.at).toBe(at('2026-10-14T09:00:00+02:00'));
    expect(dueStages(item, TZ, at('2026-10-14T08:59:00+02:00'))).toEqual([]);
    expect(dueStages(item, TZ, at('2026-10-14T09:00:00+02:00'))).toEqual(['t24']);
    expect(dueStages(item, TZ, at('2026-10-15T23:00:00+02:00'))).toEqual(['t24']);
    expect(dueStages(item, TZ, at('2026-10-16T00:30:00+02:00'))).toEqual([]);
  });

  it('un viaje no tiene recordatorios escalonados', () => {
    expect(
      stageInstants({ title: 'Tren', at: BASE + 30 * H, kind: 'travel', where: 'correo' }, TZ),
    ).toEqual([]);
  });
});

describe('conflictos de agenda', () => {
  const key = (i: AgendaItem) => findingKey(i, TZ);
  const t = (h: number, m = 0) =>
    at(`2026-10-13T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+02:00`);

  it('dos citas con hora que se pisan avisan una sola vez', async () => {
    const a = meeting('Dentista', t(10), { end: t(11) });
    const b = meeting('Reunión equipo', t(10, 30), { end: t(11, 30) });
    const r = rig([a, b]);
    await r.run();
    expect(r.sent[0]).toContain('Conflicto de agenda');
    expect(r.sent[0]).toContain('«Dentista»');
    expect(r.sent[0]).toContain('«Reunión equipo»');
    await r.run();
    expect(r.sent).toHaveLength(1);
  });

  it('adyacentes, todo el día y sin hora no chocan; un puntual dentro de otro sí', () => {
    const a = meeting('A', t(10), { end: t(11) });
    const adj = meeting('B', t(11), { end: t(12) });
    const allDay = meeting('C', t(10), { allDay: true });
    const untimed = meeting('D', t(10), { timed: false });
    const point = meeting('E', t(10, 30));
    const now = t(8);
    expect(findConflicts([a, adj], key, now)).toHaveLength(0);
    expect(findConflicts([a, allDay, untimed], key, now)).toHaveLength(0);
    expect(findConflicts([a, point], key, now)).toHaveLength(1);
    expect(findConflicts([a, meeting('F', t(10))], key, now)).toHaveLength(1);
  });

  it('la misma cosa vista dos veces no choca consigo misma y lo ya terminado no cuenta', () => {
    const a = meeting('A', t(10), { end: t(11) });
    expect(findConflicts([a, { ...a }], key, t(8))).toHaveLength(0);
    const b = meeting('B', t(10, 30), { end: t(11, 30) });
    expect(findConflicts([a, b], key, t(12))).toHaveLength(0);
  });
});

describe('horas de silencio', () => {
  it('inQuietHours cruza la medianoche', () => {
    const q = { startHour: 22, endHour: 8 };
    expect(inQuietHours(at('2026-10-12T23:00:00+02:00'), q, TZ)).toBe(true);
    expect(inQuietHours(at('2026-10-13T07:59:00+02:00'), q, TZ)).toBe(true);
    expect(inQuietHours(at('2026-10-13T08:00:00+02:00'), q, TZ)).toBe(false);
    expect(inQuietHours(at('2026-10-12T21:59:00+02:00'), q, TZ)).toBe(false);
  });

  it('lo no crítico espera sin marcarse y sale al terminar el silencio', async () => {
    const night = at('2026-10-12T23:00:00+02:00');
    const r = rig([meeting('Cita', night + 20 * H)], { startHour: 22, endHour: 8 });
    r.at(night);
    await r.run();
    expect(r.sent).toHaveLength(0);
    r.at(at('2026-10-13T08:05:00+02:00'));
    await r.run();
    expect(r.sent).toHaveLength(1);
  });

  it('un pago con hora a menos de 2 h se avisa de noche; una cita no', async () => {
    const night = at('2026-10-12T23:00:00+02:00');
    const pay: AgendaItem = {
      title: 'Cargo tarjeta',
      at: night + H,
      kind: 'payment',
      where: 'correo',
    };
    const cita = meeting('Cita', night + H);
    expect(isCritical(pay, night)).toBe(true);
    expect(isCritical(cita, night)).toBe(false);
    expect(isCritical({ ...pay, at: night + 3 * H }, night)).toBe(false);
    const r = rig([pay, cita], { startHour: 22, endHour: 8 });
    r.at(night);
    await r.run();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain('Cargo tarjeta');
    expect(r.sent[0]).not.toContain('Cita');
  });

  it('los conflictos esperan durante el silencio', async () => {
    const night = at('2026-10-12T23:00:00+02:00');
    const a = meeting('A', night + 20 * H, { end: night + 21 * H });
    const b = meeting('B', night + 20 * H + 30 * 60_000, { end: night + 22 * H });
    const r = rig([a, b], { startHour: 22, endHour: 8 });
    r.at(night);
    await r.run();
    expect(r.sent).toHaveLength(0);
    r.at(at('2026-10-13T08:10:00+02:00'));
    await r.run();
    expect(r.sent[0]).toContain('Conflicto');
  });
});

describe('interruptor /ojo', () => {
  it('apagado no avisa de nada y al encender recupera lo pendiente', async () => {
    const r = rig([meeting('Cita', BASE + 30 * H)]);
    expect(getOjoEnabled(r.db)).toBe(true);
    setOjoEnabled(r.db, false);
    expect(getOjoEnabled(r.db)).toBe(false);
    await r.run();
    expect(r.sent).toHaveLength(0);
    setOjoEnabled(r.db, true);
    await r.run();
    expect(r.sent).toHaveLength(1);
  });
});

describe('auditor R1 (B1-B4)', () => {
  it('B1: sin hora, el propio día dice "hoy" y el día antes "mañana"', async () => {
    const dl: AgendaItem = {
      title: 'Plazo IRPF',
      at: at('2026-10-15T00:00:00+02:00'),
      kind: 'deadline',
      where: 'correo',
      timed: false,
    };
    const r = rig([dl]);
    r.at(at('2026-10-13T10:00:00+02:00'));
    await r.run(); // descubrimiento
    r.at(at('2026-10-14T09:30:00+02:00'));
    await r.run();
    expect(r.sent[1]).toContain('mañana (sin hora)');
    const r2 = rig([dl]);
    r2.at(at('2026-10-13T10:00:00+02:00'));
    await r2.run();
    r2.at(at('2026-10-15T10:00:00+02:00')); // reanudación el propio día tras un apagón
    await r2.run();
    expect(r2.sent[1]).toContain('hoy (sin hora)');
    expect(r2.sent[1]).not.toContain('mañana');
  });

  it('B2: /ojo off durante un barrido en vuelo no envía ni marca', async () => {
    const db = new DatabaseSync(':memory:');
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const sent: string[] = [];
    const items = [meeting('CANARY', BASE + 30 * H)];
    const p = runVigilanteOnce(
      {
        db,
        agenda: async () => {
          await gate;
          return agenda(items);
        },
        send: async (t) => {
          sent.push(t);
          return true;
        },
        now: () => BASE,
      },
      TZ,
    );
    setOjoEnabled(db, false);
    release();
    await p;
    expect(sent).toHaveLength(0);
    expect((db.prepare('SELECT count(*) n FROM vigilante_seen').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) n FROM vigilante_stages').get() as { n: number }).n).toBe(
      0,
    );
  });

  it('B3: homónimos del mismo día a distinta hora son ocurrencias distintas y chocan', async () => {
    const a = meeting('Reunión', at('2026-10-13T11:00:00+02:00'), {
      end: at('2026-10-13T13:00:00+02:00'),
    });
    const b = meeting('Reunión', at('2026-10-13T12:00:00+02:00'), {
      end: at('2026-10-13T14:00:00+02:00'),
    });
    const r = rig([a, b]);
    await r.run();
    expect(r.sent[0]).toContain('Conflicto de agenda');
    await r.run();
    expect(r.sent).toHaveLength(1);
  });

  it('B3: el redescubrimiento duplicado de la misma ocurrencia no es conflicto ni duplica etapas', async () => {
    const a = meeting('Reunión', at('2026-10-13T11:00:00+02:00'), {
      end: at('2026-10-13T13:00:00+02:00'),
    });
    const r = rig([a, { ...a, where: 'correo', sources: ['correo'] }]);
    await r.run();
    expect(r.sent[0]).not.toContain('Conflicto');
  });

  it('B3: homónimos: el descubrimiento cubre las etapas de TODAS las ocurrencias del hallazgo', async () => {
    const t1 = BASE + 30 * H;
    const a = meeting('Revisión', t1);
    const b = meeting('Revisión', t1 + 3 * H);
    const r = rig([a, b]);
    r.at(t1 - 1 * H); // ambas dentro de T-24h al descubrir
    await r.run();
    const n = r.sent.length;
    await r.run();
    expect(r.sent).toHaveLength(n);
  });

  it('B3: homónimos reciben cada uno su recordatorio T-2h', async () => {
    const t1 = BASE + 30 * H;
    const a = meeting('Revisión', t1);
    const b = meeting('Revisión', t1 + 5 * H);
    const r = rig([a, b]);
    await r.run();
    r.at(t1 - 2 * H + 60_000);
    await r.run();
    r.at(t1 + 5 * H - 2 * H + 60_000);
    await r.run();
    const rec = r.sent.filter((t) => t.includes('Recordatorio'));
    expect(rec.length).toBeGreaterThanOrEqual(2);
  });

  it('B4: el conflicto lleva procedencia y duda de ambos lados', async () => {
    const a = meeting('Dentista', at('2026-10-13T10:00:00+02:00'), {
      end: at('2026-10-13T11:00:00+02:00'),
    });
    const b = meeting('Comida', at('2026-10-13T10:30:00+02:00'), {
      where: 'correo',
      confidence: 0.4,
    });
    const r = rig([a, b]);
    await r.run();
    const msg = r.sent.find((t) => t.includes('Conflicto')) ?? '';
    expect(msg).toContain('calendario');
    expect(msg).toContain('correo, 40% seguro');
  });

  it('menor: crítico es estrictamente menos de 2 h', () => {
    const pay: AgendaItem = { title: 'P', at: BASE + 2 * H, kind: 'payment', where: 'correo' };
    expect(isCritical(pay, BASE)).toBe(false);
    expect(isCritical({ ...pay, at: BASE + 2 * H - 1 }, BASE)).toBe(true);
  });
});

describe('auditor R2: cobertura = contenido', () => {
  it('homónimos sin duración: el descubrimiento dice AMBAS horas y luego no hay silencio indebido', async () => {
    const a = meeting('Reunión', at('2026-10-12T11:00:00+02:00'));
    const b = meeting('Reunión', at('2026-10-12T11:30:00+02:00'));
    const r = rig([a, b]);
    await r.run();
    expect(r.sent[0]).toContain('11:00');
    expect(r.sent[0]).toContain('11:30');
    await r.run();
    expect(r.sent).toHaveLength(1);
  });

  it('una ocurrencia homónima que no estaba en el descubrimiento sigue recibiendo su recordatorio', async () => {
    const a = meeting('Reunión', BASE + 30 * H);
    const r = rig([a]);
    await r.run();
    // aparece después otra con el mismo título y día, a otra hora
    const b = meeting('Reunión', BASE + 33 * H);
    const items = [a, b];
    const sent: string[] = [];
    const db = r.db;
    const now = BASE + 33 * H - 2 * H + 60_000;
    await runVigilanteOnce(
      {
        db,
        agenda: async () => agenda(items),
        send: async (t) => {
          sent.push(t);
          return true;
        },
        now: () => now,
      },
      TZ,
    );
    const text = sent.join('\n');
    expect(text).toContain('Recordatorio');
    expect(text).toContain('en 1 h 59 min');
  });
});
