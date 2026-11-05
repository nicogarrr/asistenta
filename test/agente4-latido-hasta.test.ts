import { describe, expect, it } from 'vitest';
import { createLatidoTool, Latidos, latidoHasta, latidoLine } from '../src/daemon/latido.js';

const TZ = 'Europe/Madrid';
// Jueves 5 de noviembre de 2026, 10:50 en Madrid (UTC+1).
const NOW = new Date('2026-11-05T09:50:00Z');
const local = (d: Date | null): string =>
  d
    ? new Intl.DateTimeFormat('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: TZ,
        day: 'numeric',
      }).format(d)
    : 'null';

/**
 * «Vigila la web cada 10 min hasta las 8» solo admitía horas (que calculaba el modelo): acababa
 * a las 3 h por defecto o en una cuenta mal hecha. Ahora la hora de fin se lee tal cual.
 */
describe('latido «hasta las 8»', () => {
  it.each([
    ['hasta las 8', '5, 20:00'],
    ['hasta las 8 de la tarde', '5, 20:00'],
    ['hasta las 20:30', '5, 20:30'],
    ['hasta las 12', '5, 12:00'],
    ['hasta mediodía', '5, 12:00'],
    ['hasta medianoche', '6, 00:00'],
    ['las 9 de la noche', '5, 21:00'],
    ['hasta las 13h', '5, 13:00'],
  ])('%s → %s', (said, want) => {
    expect(local(latidoHasta(said, NOW, TZ))).toBe(want);
  });

  it('lo que no es una hora, null', () => {
    expect(latidoHasta('hasta que vuelva internet', NOW, TZ)).toBeNull();
    expect(latidoHasta('', NOW, TZ)).toBeNull();
  });

  function tool() {
    const waits: number[] = [];
    const sent: string[] = [];
    let now = NOW.getTime();
    const fns: (() => void)[] = [];
    const latidos = new Latidos({
      run: async () => 'SIN_CAMBIOS',
      send: async (_c, t) => {
        sent.push(t);
      },
      now: () => now,
      later: (fn, ms) => {
        waits.push(ms);
        fns.push(fn);
        return { cancel: () => {} };
      },
    });
    const t = createLatidoTool({
      latidos,
      scopeOf: () => 'telegram:1#main',
      chatIdOf: () => '1',
      now: () => now,
      timeZone: TZ,
    });
    return {
      t,
      latidos,
      waits,
      sent,
      setNow: (n: number) => {
        now = n;
      },
    };
  }

  it('la herramienta para a esa hora y lo dice así', async () => {
    const { t, latidos, waits, sent, setNow } = tool();
    const r = await t.execute('x', {
      action: 'start',
      task: 'mira si ha bajado el precio',
      every_minutes: 10,
      until: 'hasta las 8',
    });
    const text = (r.content[0] as { text: string }).text;
    expect(r.isError).toBeFalsy();
    expect(text).toContain('hasta las 20:00');
    const [l] = latidos.list('telegram:1#main');
    expect(l?.untilMs).toBe(new Date('2026-11-05T19:00:00Z').getTime());
    expect(latidoLine(l as never)).toBe(
      '«mira si ha bajado el precio» cada 10 min, hasta las 20:00',
    );
    // A las 19:55 el siguiente toque es a las 20:00 justas, no a las 20:05.
    setNow(new Date('2026-11-05T18:55:00Z').getTime());
    await latidos.tick(l?.id as string);
    expect(waits.at(-1)).toBe(5 * 60_000);
    setNow(new Date('2026-11-05T19:00:00Z').getTime());
    await latidos.tick(l?.id as string);
    expect(sent.at(-1)).toContain('ya son las 20:00');
    expect(latidos.list('telegram:1#main')).toEqual([]);
  });

  it('más de 12 h o una hora que no entiende: lo dice, no se inventa 3 h', async () => {
    const { t, latidos } = tool();
    const far = await t.execute('x', {
      action: 'start',
      task: 'la web',
      until: 'hasta las 7 de la mañana',
    });
    expect(far.isError).toBe(true);
    expect((far.content[0] as { text: string }).text).toContain('más de 12 h');
    const odd = await t.execute('x', { action: 'start', task: 'la web', until: 'hasta que acabe' });
    expect(odd.isError).toBe(true);
    expect((odd.content[0] as { text: string }).text).toContain('No entiendo «hasta que acabe»');
    expect(latidos.list('telegram:1#main')).toEqual([]);
  });

  it('sin hora de fin, igual que antes (durante 3 h)', async () => {
    const { t, latidos } = tool();
    await t.execute('x', { action: 'start', task: 'la web' });
    const [l] = latidos.list('telegram:1#main');
    expect(latidoLine(l as never)).toBe('«la web» cada 10 min, durante 3 h');
  });
});
