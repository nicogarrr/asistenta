import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { AgendaItem, UnifiedAgenda } from '../src/agenda/unified.js';

vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  runVigilanteOnce,
  collectFindings,
  findingKey,
  formatFindings,
  resolveOwnerUserId,
  resolveOwnerDmChatId,
  startVigilanteLoop,
} = await import('../src/vigilante.js');

const TZ = 'Europe/Madrid';
const NOW = new Date('2026-10-11T10:00:00+02:00').getTime();
const DAY = 86_400_000;

function item(partial: Partial<AgendaItem> & { title: string }): AgendaItem {
  return { at: NOW + DAY, kind: 'deadline', where: 'correo', ...partial };
}

function agenda(items: AgendaItem[], pending: AgendaItem[] = []): UnifiedAgenda {
  return {
    today: [],
    upcoming: items,
    pending,
    generatedAt: NOW,
    days: 7,
    counts: { calendar: 0, mail: items.length, pending: pending.length },
    notes: [],
  };
}

function deps(items: AgendaItem[], send?: (text: string) => Promise<boolean>) {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    agenda: async () => agenda(items),
    send: send ?? (async () => true),
    now: () => NOW,
  };
}

describe('findingKey', () => {
  it('es estable: mismo hallazgo, misma clave aunque cambie la hora del día', () => {
    const a = item({
      title: 'Factura del taller',
      at: new Date('2026-10-12T09:00:00+02:00').getTime(),
    });
    const b = item({
      title: '  factura   del TALLER ',
      at: new Date('2026-10-12T21:30:00+02:00').getTime(),
    });
    expect(findingKey(a, TZ)).toBe(findingKey(b, TZ));
    const otroDia = item({
      title: 'Factura del taller',
      at: new Date('2026-10-13T09:00:00+02:00').getTime(),
    });
    expect(findingKey(otroDia, TZ)).not.toBe(findingKey(a, TZ));
  });

  it('el día es LOCAL, no UTC: la medianoche de Madrid no parte el hallazgo', () => {
    const madrugada = item({
      title: 'Plazo',
      at: new Date('2026-10-13T00:30:00+02:00').getTime(),
    });
    const tarde = item({ title: 'Plazo', at: new Date('2026-10-13T14:00:00+02:00').getTime() });
    expect(findingKey(madrugada, TZ)).toBe(findingKey(tarde, TZ));
  });
});

describe('collectFindings', () => {
  it('filtra por tipo con fecha y ordena por cuándo toca, SIN capar', () => {
    const tarde = item({ title: 'tarde', at: NOW + 3 * DAY, kind: 'payment' });
    const pronto = item({ title: 'pronto', at: NOW + DAY, kind: 'travel' });
    const sinFecha = item({ title: 'sin fecha', at: null });
    const recordatorio = item({ title: 'ruido', kind: 'reminder' });
    const found = collectFindings(agenda([tarde, sinFecha, recordatorio, pronto]), TZ, NOW);
    expect(found.map((f) => f.title)).toEqual(['pronto', 'tarde']);
  });

  it('no capa: el cap va después de descartar lo ya notificado', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      item({ title: `cosa ${i}`, at: NOW + (i + 1) * DAY }),
    );
    expect(collectFindings(agenda(many), TZ, NOW)).toHaveLength(8);
  });

  it('incluye pendientes vigentes; excluye vencidos, sin fecha y fuera de ventana', () => {
    const vigente = item({ title: 'vigente', at: NOW + 2 * DAY, where: 'pendiente' });
    const vencido = item({ title: 'vencido', at: NOW - DAY, where: 'pendiente' });
    const sinFecha = item({ title: 'sin fecha', at: null, where: 'pendiente' });
    const lejano = item({ title: 'lejano', at: NOW + 40 * DAY, where: 'pendiente' });
    const found = collectFindings(agenda([], [vigente, vencido, sinFecha, lejano]), TZ, NOW);
    expect(found.map((f) => f.title)).toEqual(['vigente']);
  });
});

describe('resolveOwnerUserId', () => {
  it('allowlist unitaria: ese usuario es el owner', () => {
    expect(resolveOwnerUserId([12345], null)).toBe(12345);
  });

  it('allowlist múltiple sin config explícita: fail-closed (usar el bot != ser el owner)', () => {
    expect(resolveOwnerUserId([12345, 678], null)).toBeNull();
  });

  it('config explícita válida (y allowlisted) gana', () => {
    expect(resolveOwnerUserId([12345, 678], 678)).toBe(678);
  });

  it('config fuera de la allowlist: fail-closed', () => {
    expect(resolveOwnerUserId([12345], 999)).toBeNull();
  });
});

describe('resolveOwnerDmChatId', () => {
  it('encuentra el DM del owner verificado y solo ese', () => {
    expect(resolveOwnerDmChatId(['telegram:cuenta:12345'], 12345)).toBe('12345');
  });

  it('sin owner verificado no hay destino, hable quien hable', () => {
    expect(resolveOwnerDmChatId(['telegram:cuenta:12345'], null)).toBeNull();
  });

  it('rechaza el DM de otra persona, grupos y otros canales', () => {
    expect(resolveOwnerDmChatId(['telegram:cuenta:678'], 12345)).toBeNull();
    expect(resolveOwnerDmChatId(['telegram:cuenta:-100999888'], 12345)).toBeNull();
    expect(resolveOwnerDmChatId(['whatsapp:cuenta:12345'], 12345)).toBeNull();
    expect(resolveOwnerDmChatId([], 12345)).toBeNull();
  });

  it('ruta adversarial: allowlist [owner, B] y solo B ha hablado -> no se envía', () => {
    const ownerId = resolveOwnerUserId([111, 222], null);
    expect(ownerId).toBeNull();
    expect(resolveOwnerDmChatId(['telegram:cuenta:222'], ownerId)).toBeNull();
  });

  it('con config explícita, el DM del owner configurado sí resuelve', () => {
    const ownerId = resolveOwnerUserId([111, 222], 111);
    expect(resolveOwnerDmChatId(['telegram:cuenta:111', 'telegram:cuenta:222'], ownerId)).toBe(
      '111',
    );
  });
});

describe('runVigilanteOnce', () => {
  it('notifica lo nuevo una sola vez', async () => {
    const sent: string[] = [];
    const d = deps([item({ title: 'Factura del taller' })], async (text) => {
      sent.push(text);
      return true;
    });
    const first = await runVigilanteOnce(d, TZ);
    expect(first).toEqual({ seen: 1, fresh: 1, notified: 1 });
    expect(sent[0]).toContain('Factura del taller');
    expect(sent[0]).toContain('Ojo de águila');

    const second = await runVigilanteOnce(d, TZ);
    expect(second).toEqual({ seen: 1, fresh: 0, notified: 0 });
    expect(sent).toHaveLength(1);
  });

  it('capa tras el dedupe: el sexto hallazgo sale en el siguiente barrido', async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      item({ title: `plazo ${i}`, at: NOW + (i + 1) * DAY }),
    );
    const d = deps(many);
    expect((await runVigilanteOnce(d, TZ)).notified).toBe(5);
    expect((await runVigilanteOnce(d, TZ)).notified).toBe(1);
  });

  it('deduplica dentro del mismo barrido', async () => {
    const dup = item({ title: 'Factura del taller' });
    const d = deps([dup, { ...dup }]);
    expect((await runVigilanteOnce(d, TZ)).notified).toBe(1);
  });

  it('un envío fallido no marca: el siguiente barrido reintenta', async () => {
    let calls = 0;
    const d = deps([item({ title: 'Pago del seguro', kind: 'payment' })], async () => {
      calls += 1;
      return calls > 1;
    });
    const first = await runVigilanteOnce(d, TZ);
    expect(first.notified).toBe(0);
    const second = await runVigilanteOnce(d, TZ);
    expect(second.notified).toBe(1);
    expect(calls).toBe(2);
  });

  it('una agenda que explota no tumba el barrido', async () => {
    const db = new DatabaseSync(':memory:');
    const result = await runVigilanteOnce(
      {
        db,
        agenda: async () => {
          throw new Error('imap caido');
        },
        send: async () => true,
      },
      TZ,
    );
    expect(result).toEqual({ seen: 0, fresh: 0, notified: 0 });
  });

  it('shouldAbort antes del envío: no envía y no marca', async () => {
    let calls = 0;
    const d = {
      ...deps([item({ title: 'Factura' })], async () => {
        calls += 1;
        return true;
      }),
      shouldAbort: () => true,
    };
    const result = await runVigilanteOnce(d, TZ);
    expect(result.notified).toBe(0);
    expect(calls).toBe(0);
    const after = await runVigilanteOnce({ ...d, shouldAbort: () => false }, TZ);
    expect(after.notified).toBe(1);
  });

  it('entrega confirmada se persiste aunque el cierre empiece después (drain)', async () => {
    let checks = 0;
    const items = [item({ title: 'Factura' })];
    const base = deps(items);
    const d = {
      ...base,
      shouldAbort: () => {
        checks += 1;
        return checks > 1;
      },
    };
    const result = await runVigilanteOnce(d, TZ);
    // El abort frena el ENVÍO durante el cierre, pero una entrega ya confirmada se
    // marca: si no, el mismo aviso reaparecería al reiniciar.
    expect(result.notified).toBe(1);
    const again = await runVigilanteOnce({ ...base }, TZ);
    expect(again.fresh).toBe(0);
  });

  it('los hallazgos viejos no se renotifican entre procesos (persiste en sqlite)', async () => {
    const db = new DatabaseSync(':memory:');
    const items = [item({ title: 'Tren a Barcelona', kind: 'travel' })];
    const d1 = { db, agenda: async () => agenda(items), send: async () => true, now: () => NOW };
    await runVigilanteOnce(d1, TZ);
    let sent = 0;
    const d2 = {
      db,
      agenda: async () => agenda(items),
      send: async () => {
        sent += 1;
        return true;
      },
      now: () => NOW,
    };
    const second = await runVigilanteOnce(d2, TZ);
    expect(second.fresh).toBe(0);
    expect(sent).toBe(0);
  });
});

describe('formatFindings', () => {
  it('digest en español con tipo, fecha y fuente', () => {
    const text = formatFindings(
      [
        item({
          title: 'Factura del taller',
          kind: 'deadline',
          at: new Date('2026-10-13T09:00:00+02:00').getTime(),
        }),
      ],
      TZ,
    );
    expect(text).toContain('🦅 Ojo de águila: 1 cosa nueva');
    expect(text).toContain('Plazo: Factura del taller');
    expect(text).toContain('octubre');
    expect(text).toContain('(correo)');
  });

  it('todo el día y sin hora se dicen; nunca se inventa una hora', () => {
    const text = formatFindings(
      [
        item({
          title: 'Día de la madre',
          allDay: true,
          timed: false,
          at: new Date('2026-10-13T00:00:00+02:00').getTime(),
        }),
        item({ title: 'Pago sin hora', timed: false }),
      ],
      TZ,
    );
    expect(text).not.toContain('0:00');
    expect(text).toContain('todo el día');
    expect(text).toContain('sin hora');
  });

  it('la confianza baja se declara; el título se capa a 90', () => {
    const text = formatFindings(
      [
        item({
          title: `Asunto de correo ${'muy '.repeat(40)}largo`,
          confidence: 0.45,
        }),
      ],
      TZ,
    );
    expect(text).toContain('(45% seguro)');
    const line = text.split('\n')[1] ?? '';
    expect(line.length).toBeLessThan(160);
  });
});

describe('timeout de agenda', () => {
  it('una agenda colgada no eterniza el barrido: timeout y a otra cosa', async () => {
    const db = new DatabaseSync(':memory:');
    const started = Date.now();
    const result = await runVigilanteOnce(
      {
        db,
        agenda: () => new Promise<UnifiedAgenda>(() => {}),
        send: async () => true,
        agendaTimeoutMs: 30,
      },
      TZ,
    );
    expect(result).toEqual({ seen: 0, fresh: 0, notified: 0 });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('startVigilanteLoop', () => {
  it('stop drena acotado: ni una agenda colgada eterniza el cierre del daemon', async () => {
    const loop = startVigilanteLoop(
      {
        db: new DatabaseSync(':memory:'),
        agenda: () => new Promise<UnifiedAgenda>(() => {}),
        send: async () => true,
        agendaTimeoutMs: 30,
      },
      TZ,
      10_000,
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    await loop.stop();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('stop drena el barrido en vuelo y cancela el siguiente tick', async () => {
    let sends = 0;
    let sendFinished = false;
    const loop = startVigilanteLoop(
      {
        db: new DatabaseSync(':memory:'),
        agenda: async () => agenda([item({ title: 'Factura' })]),
        send: async () => {
          sends += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          sendFinished = true;
          return true;
        },
        now: () => NOW,
      },
      TZ,
      10_000,
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await loop.stop();
    expect(sendFinished).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toBe(1);
  });
});

it('incluye degradación de fuentes en el digest ya existente sin generar otro aviso', async () => {
  const send = vi.fn(async (_text: string) => true);
  const d = deps([item({ title: 'Dentista local', where: 'calendario', kind: 'meeting' })], send);
  d.agenda = async () => ({
    ...agenda([item({ title: 'Dentista local', where: 'calendario', kind: 'meeting' })]),
    notes: ['No se ha podido leer el calendario remoto.'],
  });
  await runVigilanteOnce(d, TZ);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toContain('No se ha podido leer el calendario remoto.');
  d.db.close();
});
it('no manda un digest vacío sólo por degradación de fuentes', async () => {
  const send = vi.fn(async (_text: string) => true);
  const d = deps([], send);
  d.agenda = async () => ({ ...agenda([]), notes: ['Calendario no disponible.'] });
  await runVigilanteOnce(d, TZ);
  expect(send).not.toHaveBeenCalled();
  d.db.close();
});
