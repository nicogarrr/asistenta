import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { AgendaItem, UnifiedAgenda } from '../src/agenda/unified.js';

vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runVigilanteOnce, collectFindings, findingKey, formatFindings } = await import(
  '../src/vigilante.js'
);

const TZ = 'Europe/Madrid';
const NOW = new Date('2026-10-11T10:00:00+02:00').getTime();

function item(partial: Partial<AgendaItem> & { title: string }): AgendaItem {
  return { at: NOW + 86_400_000, kind: 'deadline', where: 'correo', ...partial };
}

function agenda(items: AgendaItem[]): UnifiedAgenda {
  return {
    today: [],
    upcoming: items,
    pending: [],
    generatedAt: NOW,
    days: 7,
    counts: { calendar: 0, mail: items.length, pending: 0 },
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
    expect(findingKey(a)).toBe(findingKey(b));
    const otroDia = item({
      title: 'Factura del taller',
      at: new Date('2026-10-13T09:00:00+02:00').getTime(),
    });
    expect(findingKey(otroDia)).not.toBe(findingKey(a));
  });
});

describe('collectFindings', () => {
  it('filtra por tipo con fecha, ordena por cuándo toca y capa', () => {
    const tarde = item({ title: 'tarde', at: NOW + 3 * 86_400_000, kind: 'payment' });
    const pronto = item({ title: 'pronto', at: NOW + 86_400_000, kind: 'travel' });
    const sinFecha = item({ title: 'sin fecha', at: null });
    const recordatorio = item({ title: 'ruido', kind: 'reminder' });
    const found = collectFindings(agenda([tarde, sinFecha, recordatorio, pronto]), 5);
    expect(found.map((f) => f.title)).toEqual(['pronto', 'tarde']);
  });

  it('capa al máximo pedido', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      item({ title: `cosa ${i}`, at: NOW + (i + 1) * 86_400_000 }),
    );
    expect(collectFindings(agenda(many), 5)).toHaveLength(5);
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
  it('digest en español con tipo y fecha, sin hora inventada para el todo-el-día', () => {
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
  });
});
