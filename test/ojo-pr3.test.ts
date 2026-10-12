import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { extractCommitments, isExpiry } from '../src/agenda/extract.js';
import type { AgendaItem, UnifiedAgenda } from '../src/agenda/unified.js';
import type { MailMessage } from '../src/mail/types.js';
import { stageInstants } from '../src/ojo.js';
import { amountsIn, ingestCharges, median, parseCharge, senderKey } from '../src/ojo-charges.js';
import { collectFindings, runVigilanteOnce } from '../src/vigilante.js';

const TZ = 'Europe/Madrid';
const H = 3_600_000;
const D = 24 * H;
const BASE = new Date('2026-10-12T10:00:00+02:00').getTime();

const agendaOf = (items: AgendaItem[], days = 7): UnifiedAgenda => ({
  today: [],
  upcoming: items,
  pending: [],
  generatedAt: BASE,
  days,
  counts: { calendar: 0, mail: items.length, pending: 0 },
  notes: [],
});
const expiryItem = (title: string, when: number, extra: Partial<AgendaItem> = {}): AgendaItem => ({
  title,
  at: when,
  kind: 'deadline',
  where: 'correo',
  timed: false,
  expiry: true,
  ...extra,
});
const mail = (
  id: string,
  from: string,
  subject: string,
  text: string,
  at: number,
): MailMessage => ({
  id,
  from,
  to: ['yo@x.es'],
  subject,
  text,
  at,
  seen: true,
  folder: 'INBOX',
});

function rig(
  getItems: () => AgendaItem[],
  opts: { days?: number; msgs?: () => MailMessage[]; quiet?: boolean } = {},
) {
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
          agenda: async () => agendaOf(getItems(), opts.days ?? 7),
          send: async (t) => {
            sent.push(t);
            return true;
          },
          now: () => now,
          ...(opts.msgs ? { charges: async () => (opts.msgs as () => MailMessage[])() } : {}),
          ...(opts.quiet ? { quiet: { startHour: 22, endHour: 8 } } : {}),
        },
        TZ,
      ),
  };
}

describe('caducidades: detección con prueba positiva', () => {
  it('caduca / expires / renueva cuentan; vence solo sin dinero de por medio', () => {
    expect(isExpiry('tu pasaporte caduca el 20 de noviembre')).toBe(true);
    expect(isExpiry('your card expires on 11/2026')).toBe(true);
    expect(isExpiry('tu suscripcion se renueva el 3 de diciembre')).toBe(true);
    expect(isExpiry('tu suscripcion renueva el 3 de diciembre')).toBe(true);
    expect(isExpiry('tu seguro vence el 20 de noviembre')).toBe(true);
    expect(isExpiry('la factura vence el 20 de noviembre')).toBe(false);
    expect(isExpiry('vence el 20 de noviembre importe 59,99 \u20ac')).toBe(false);
    expect(isExpiry('tu pedido ha sido enviado')).toBe(false);
  });
  it('el extractor marca expiry y tipo plazo', () => {
    const msg = mail(
      'm1',
      'Seguros <no-reply@seguros.es>',
      'Tu seguro caduca',
      'Tu seguro del coche caduca el 20 de noviembre de 2026 a las 12:00.',
      BASE,
    );
    const out = extractCommitments([msg], { now: BASE, timeZone: TZ });
    expect(out).toHaveLength(1);
    expect(out[0]?.expiry).toBe(true);
    expect(out[0]?.kind).toBe('deadline');
  });
});

describe('caducidades: etapas 30/7/1 días', () => {
  it('9:00 locales de cada día, sin T-24h/T-2h', () => {
    const it0 = expiryItem('Pasaporte', new Date('2026-11-20T00:00:00+01:00').getTime() + 9 * H);
    const st = stageInstants(it0, TZ);
    expect(st.map((s) => s.stage)).toEqual(['d30', 'd7', 'd1']);
    expect(st.map((s) => new Date(s.at).toLocaleString('sv-SE', { timeZone: TZ }))).toEqual([
      '2026-10-21 09:00:00',
      '2026-11-13 09:00:00',
      '2026-11-19 09:00:00',
    ]);
    const normal = { ...it0, expiry: undefined };
    expect(stageInstants(normal, TZ).map((s) => s.stage)).toEqual(['t24']);
  });
  it('collectFindings: lo normal sigue a 7 días, la caducidad mira a 35', () => {
    const far = {
      title: 'cosa lejana',
      at: BASE + 20 * D,
      kind: 'deadline',
      where: 'correo',
    } as AgendaItem;
    const exp = expiryItem('Pasaporte', BASE + 20 * D);
    const found = collectFindings(agendaOf([far, exp], 35), TZ, BASE);
    expect(found.map((f) => f.title)).toEqual(['Pasaporte']);
  });
  it('barrido: descubrimiento, y luego un solo aviso por etapa (30, 7, 1) con contenido', async () => {
    const due = new Date('2026-11-20T00:00:00+01:00').getTime();
    const r = rig(() => [expiryItem('Pasaporte caduca', due)], { days: 45 });
    await r.run();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain('Caducidad: Pasaporte caduca');
    const tick = async (iso: string) => {
      r.at(new Date(iso).getTime());
      await r.run();
      await r.run(); // idempotente
    };
    await tick('2026-10-20T10:00:00+02:00');
    expect(r.sent).toHaveLength(1); // aún no toca d30
    await tick('2026-10-21T09:30:00+02:00');
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]).toContain('Pasaporte caduca');
    await tick('2026-11-13T10:00:00+01:00');
    expect(r.sent).toHaveLength(3);
    await tick('2026-11-19T10:00:00+01:00');
    expect(r.sent).toHaveLength(4);
    await tick('2026-11-19T18:00:00+01:00');
    expect(r.sent).toHaveLength(4);
  });
  it('un correo que sale de la ventana no pierde sus recordatorios; un evento de calendario sí', async () => {
    const due = new Date('2026-11-20T00:00:00+01:00').getTime();
    let items: AgendaItem[] = [
      expiryItem('Seguro caduca', due),
      expiryItem('Evento cancelado caduca', due + D, { where: 'calendario' }),
    ];
    const r = rig(() => items, { days: 45 });
    await r.run();
    expect(r.sent).toHaveLength(1);
    items = []; // el correo sale de la ventana y el evento se cancela
    r.at(new Date('2026-10-21T09:30:00+02:00').getTime());
    await r.run();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]).toContain('Seguro caduca');
    expect(r.sent[1]).not.toContain('Evento cancelado');
  });
  it('lo no caducidad a más de 7 días no se avisa aunque la agenda mire a 35', async () => {
    const r = rig(
      () => [
        {
          title: 'Reunión lejana',
          at: BASE + 20 * D,
          kind: 'meeting',
          where: 'correo',
          timed: true,
        },
      ],
      { days: 35 },
    );
    await r.run();
    expect(r.sent).toHaveLength(0);
  });
});

describe('cargos raros: parseo', () => {
  it('importes y remitente', () => {
    expect(amountsIn('Total 1.234,56 € y 12,50 EUR')).toEqual([123456, 1250]);
    expect(amountsIn('€ 9.99')).toEqual([999]);
    expect(amountsIn('3 plazos de 100 euros')).toEqual([]);
    expect(senderKey('Netflix <info@mail.netflix.com>')).toBe('mail.netflix.com');
    expect(senderKey('Juan <juan@gmail.com>')).toBe('juan@gmail.com');
    expect(median([1, 5, 3])).toBe(3);
  });
  it('solo un cargo con una palabra de cobro y un único importe', () => {
    const f = 'Netflix <info@netflix.com>';
    expect(parseCharge(mail('a', f, 'Recibo', 'Te hemos cobrado 12,99 €', BASE))).toEqual({
      sender: 'netflix.com',
      cents: 1299,
    });
    expect(parseCharge(mail('b', f, 'Recibo', 'Cobro 12,99 € de 4,00 €', BASE))).toBeNull();
    expect(parseCharge(mail('c', f, 'Oferta', 'Descuento en tu factura 12,99 €', BASE))).toBeNull();
    expect(parseCharge(mail('d', f, 'Hola', 'Solo 12,99 € este mes', BASE))).toBeNull();
  });
});

describe('cargos raros: barrido', () => {
  const F = 'Gimnasio <no-reply@gimnasio.es>';
  const hist = (): MailMessage[] =>
    [1, 2, 3].map((i) =>
      mail(`h${i}`, F, 'Recibo', `Se ha cobrado 30,00 €`, BASE - (40 - i * 10) * D),
    );

  it('la primera ejecución solo siembra: ni historial ni nada se avisa', async () => {
    const msgs = [...hist(), mail('big', F, 'Recibo', 'Se ha cobrado 200,00 €', BASE - 5 * D)];
    const r = rig(() => [], { msgs: () => msgs });
    await r.run();
    expect(r.sent).toHaveLength(0);
  });
  it('subida >1,5x la mediana con >=3 anteriores: un aviso, "inferido del correo", sin repetir', async () => {
    let msgs = hist();
    const r = rig(() => [], { msgs: () => msgs });
    await r.run();
    msgs = [...msgs, mail('n1', F, 'Recibo', 'Se ha cobrado 46,00 €', BASE + H)];
    r.at(BASE + 2 * H);
    await r.run();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain('inferido del correo');
    expect(r.sent[0]).toContain('gimnasio.es');
    expect(r.sent[0]).toContain('46,00 €');
    expect(r.sent[0]).toContain('30,00 €');
    await r.run();
    expect(r.sent).toHaveLength(1);
  });
  it('1,5x exacto o menos no es raro; con menos de 3 anteriores tampoco (si no es nuevo)', async () => {
    let msgs = hist();
    const r = rig(() => [], { msgs: () => msgs });
    await r.run();
    msgs = [...msgs, mail('n1', F, 'Recibo', 'Se ha cobrado 45,00 €', BASE + H)];
    r.at(BASE + 2 * H);
    await r.run();
    expect(r.sent).toHaveLength(0);
    const G = 'Otra <a@otra.es>';
    const r2 = rig(() => [], { msgs: () => msgs2 });
    let msgs2 = [
      mail('o1', G, 'Recibo', 'Se ha cobrado 10,00 €', BASE - 3 * D),
      mail('o2', G, 'Recibo', 'Se ha cobrado 10,00 €', BASE - 2 * D),
    ];
    await r2.run();
    msgs2 = [...msgs2, mail('o3', G, 'Recibo', 'Se ha cobrado 90,00 €', BASE + H)];
    r2.at(BASE + 2 * H);
    await r2.run();
    expect(r2.sent).toHaveLength(0);
  });
  it('remitente nuevo con cobro: aviso "primer cargo"', async () => {
    let msgs = hist();
    const r = rig(() => [], { msgs: () => msgs });
    await r.run();
    msgs = [
      ...msgs,
      mail('x1', 'Raro <cobros@raro.io>', 'Cargo', 'Se ha cobrado 9,99 €', BASE + H),
    ];
    r.at(BASE + 2 * H);
    await r.run();
    expect(r.sent[0]).toContain('primer cargo');
    expect(r.sent[0]).toContain('raro.io');
  });
  it('en horas de silencio espera sin marcarse y sale al terminar', async () => {
    let msgs = hist();
    const night = new Date('2026-10-12T23:30:00+02:00').getTime();
    const r = rig(() => [], { msgs: () => msgs, quiet: true });
    r.at(BASE);
    await r.run();
    msgs = [
      ...msgs,
      mail('x1', 'Raro <cobros@raro.io>', 'Cargo', 'Se ha cobrado 9,99 €', night - H),
    ];
    r.at(night);
    await r.run();
    expect(r.sent).toHaveLength(0);
    r.at(new Date('2026-10-13T08:30:00+02:00').getTime());
    await r.run();
    expect(r.sent).toHaveLength(1);
  });
  it('ingest idempotente: los mismos correos dos veces no duplican', () => {
    const db = new DatabaseSync(':memory:');
    ingestCharges(db, hist(), BASE);
    ingestCharges(db, hist(), BASE + 1);
    expect(db.prepare('SELECT count(*) AS c FROM vigilante_charges').get()).toEqual({ c: 3 });
  });
});
