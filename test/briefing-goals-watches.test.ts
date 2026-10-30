import { describe, expect, it } from 'vitest';
import { buildBriefing, euros } from '../src/briefing.js';
import {
  _resetDailyBriefingForTests,
  composeDailyBriefing,
  type DailyBriefingDeps,
  runDailyBriefingIfDue,
} from '../src/briefing-daily.js';

const base = {
  greeting: 'Buenos días',
  today: new Date(2026, 9, 30, 8, 0),
  routines: [],
  followups: [],
  reminders: [],
  agenda: [],
};

function deps(extra: Partial<DailyBriefingDeps>): DailyBriefingDeps {
  return {
    enabled: () => true,
    now: () => new Date(2026, 9, 30, 8, 5),
    lastSent: () => 0,
    markSent: () => {},
    owner: () => '1',
    send: async () => true,
    ...extra,
  } as DailyBriefingDeps;
}

describe('briefing: objetivos y vigilancias de precio', () => {
  it('formatea euros en español', () => {
    expect(euros(129900)).toBe('1.299,00 €');
    expect(euros(5)).toBe('0,05 €');
    expect(euros(123456789)).toBe('1.234.567,89 €');
  });

  it('lista objetivos (bloqueados primero, con su motivo) y el siguiente paso', () => {
    const text = buildBriefing({
      ...base,
      goals: [
        { title: 'Renovar DNI', status: 'active', next: 'pedir cita' },
        { title: 'Vender bici', status: 'blocked', next: '¿acepto 300 €?' },
      ],
    });
    expect(text).toContain('Objetivos');
    expect(text.indexOf('Vender bici (bloqueado: ¿acepto 300 €?)')).toBeLessThan(
      text.indexOf('Renovar DNI: pedir cita'),
    );
  });

  it('lista precios vigilados y destaca los que ya bajaron del objetivo', () => {
    const text = buildBriefing({
      ...base,
      watches: [
        { label: 'Monitor', lastCents: 25000, targetCents: 20000 },
        { label: 'Portátil', lastCents: 109900, targetCents: 110000 },
        { label: 'Cascos', lastCents: null, targetCents: null },
      ],
    });
    expect(text).toContain('Precios');
    expect(text).toContain('¡Portátil: 1.099,00 € (objetivo 1.100,00 €), ya está por debajo!');
    expect(text).toContain('- Monitor: 250,00 € (objetivo 200,00 €)');
    expect(text).toContain('- Cascos: sin lectura aún');
    expect(text.indexOf('Portátil')).toBeLessThan(text.indexOf('Monitor'));
  });

  it('sin objetivos ni vigilancias no aparecen las secciones', () => {
    const text = buildBriefing({ ...base, goals: [], watches: [] });
    expect(text).not.toContain('Objetivos');
    expect(text).not.toContain('Precios');
  });

  it('composeDailyBriefing pide objetivos y precios a sus fuentes', async () => {
    const { text, empty } = await composeDailyBriefing(
      deps({
        goals: () => [{ title: 'Vender bici', status: 'blocked', next: 'precio' }],
        watches: async () => [{ label: 'Monitor', lastCents: 19900, targetCents: 20000 }],
      }),
    );
    expect(empty).toBe(false);
    expect(text).toContain('Vender bici (bloqueado: precio)');
    expect(text).toContain('Monitor: 199,00 €');
  });

  it('un objetivo activo o un precio sin novedad no bastan para enviar el resumen', async () => {
    const { empty } = await composeDailyBriefing(
      deps({
        goals: () => [{ title: 'Renovar DNI', status: 'active' }],
        watches: () => [{ label: 'Monitor', lastCents: 25000, targetCents: 20000 }],
      }),
    );
    expect(empty).toBe(true);
  });

  it('una fuente de objetivos que falla no tumba el resumen', async () => {
    const { text } = await composeDailyBriefing(
      deps({
        goals: () => {
          throw new Error('db rota');
        },
        reminders: () => [{ text: 'Llamar al banco' }],
        warn: () => {},
      }),
    );
    expect(text).toContain('Llamar al banco');
  });
});

describe('briefing: PA_BRIEFING_VOZ', () => {
  const day = { reminders: () => [{ text: 'Llamar al banco' }] };

  it('tras enviar el texto, manda la voz con el mismo texto', async () => {
    _resetDailyBriefingForTests();
    const order: string[] = [];
    const spoken: string[] = [];
    const res = await runDailyBriefingIfDue(
      deps({
        ...day,
        send: async () => {
          order.push('texto');
          return true;
        },
        speak: async (_chat, text) => {
          order.push('voz');
          spoken.push(text);
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(res.status).toBe('sent');
    expect(order).toEqual(['texto', 'voz']);
    expect(spoken[0]).toContain('Llamar al banco');
  });

  it('no espera a la voz ni falla si la voz se cuelga o revienta', async () => {
    _resetDailyBriefingForTests();
    const warns: string[] = [];
    const res = await runDailyBriefingIfDue(
      deps({
        ...day,
        speak: () => new Promise(() => {}),
      }),
    );
    expect(res.status).toBe('sent');
    _resetDailyBriefingForTests();
    const res2 = await runDailyBriefingIfDue(
      deps({
        ...day,
        speak: async () => {
          throw new Error('sapi');
        },
        warn: (m) => warns.push(m),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(res2.status).toBe('sent');
    expect(warns).toContain('briefing: voz falló');
  });

  it('sin texto enviado no hay voz', async () => {
    _resetDailyBriefingForTests();
    let spoke = false;
    const res = await runDailyBriefingIfDue(
      deps({
        ...day,
        send: async () => false,
        speak: async () => {
          spoke = true;
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(res.status).toBe('send-failed');
    expect(spoke).toBe(false);
  });
});
