import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { createRenfeTool, searchRenfe } from '../src/tools/renfe.js';

// Página falsa de renfe.com: solo lo que el recorrido usa, con el estado como datos.
interface FakeState {
  suggestions: string[];
  dayInCalendar: boolean;
  resultsLoad: boolean;
  states: { pressed: string; fingerprint: string; summaryDay: string }[];
  cellExists: boolean;
  body: string;
  rows: { labels: string[]; text: string }[];
}

const DATE = '2099-11-04';
const WANT = '04/11/2099';
const BODY = `Selecciona tu viaje
06:27 h
3 horas 29 minutos
09:56 h
Precio desde
99,60 €
16:27 h
3 horas 17 minutos
19:44 h
Precio desde
45,10 €
`;

function fakeBrowser(over: Partial<FakeState> = {}) {
  const st: FakeState = {
    suggestions: ['MADRID (TODAS)', 'MADRID-PUERTA DE ATOCHA', 'BARCELONA (TODAS)'],
    dayInCalendar: true,
    resultsLoad: true,
    states: [{ pressed: WANT, fingerprint: 'A|B', summaryDay: '4' }],
    cellExists: true,
    body: BODY,
    rows: [
      { labels: ['Tren con salida a las 06:27 horas', 'Tipo de tren: AVE.'], text: '' },
      { labels: ['Tren con salida a las 16:27 horas'], text: 'Tren completo' },
    ],
    ...over,
  };
  const log = { closed: 0, launched: 0, cellClicks: 0, picked: [] as string[] };
  const values: Record<string, string> = {};
  let field = '';
  // Como Renfe: el desplegable solo enseña estaciones que empiezan como lo tecleado.
  const visible = () => {
    const typed = (values[`typed:${field}`] ?? '').slice(0, 3).toLowerCase();
    return typed ? st.suggestions.filter((s) => s.toLowerCase().startsWith(typed)) : [];
  };
  const loc = (
    sel: string,
    opts?: { hasText?: RegExp | string },
    more: RegExp[] = [],
  ): Record<string, unknown> => {
    const matching = () =>
      visible().filter((s) => {
        const h = opts?.hasText;
        const ok = !h || (typeof h === 'string' ? s.includes(h) : h.test(s));
        return ok && more.every((r) => r.test(s));
      });
    const self: Record<string, unknown> = {
      first: () => self,
      nth: () => self,
      filter: (o: { hasText?: RegExp }) =>
        o.hasText instanceof RegExp ? loc(sel, opts, [...more, o.hasText]) : self,
      locator: (s: string) => loc(`${sel} ${s}`),
      getByText: (t: string) => loc(`${sel} text=${t}`),
      click: async () => {
        if (sel.startsWith('li[role=option]')) {
          const m = matching();
          if (!m[0]) throw new Error('no option');
          values[field] = m[0];
          log.picked.push(m[0]);
        }
        if (sel.startsWith('button.day_cell')) {
          log.cellClicks++;
        }
      },
      fill: async () => {
        field = sel.slice(1);
        values[field] = '';
      },
      pressSequentially: async (t: string) => {
        values[`typed:${field}`] = t;
      },
      inputValue: async () => values[sel.slice(1)] ?? '',
      waitFor: async () => {
        if (sel.startsWith('li[role=option]') && matching().length === 0)
          throw new Error('timeout');
        if (sel.startsWith('.modal')) throw new Error('timeout');
      },
      count: async () => {
        if (sel.startsWith('li[role=option]')) return matching().length;
        if (sel.startsWith('button.day_cell')) return st.cellExists ? 1 : 0;
        return 0;
      },
      isVisible: async () => sel.startsWith('button.day_cell'),
      innerText: async () => (sel === 'body' ? st.body : ''),
      evaluate: async () => undefined,
    };
    return self;
  };
  let stateIdx = 0;
  const page = {
    setDefaultTimeout: () => {},
    goto: async () => {},
    locator: loc,
    getByRole: (_r: string, o: { name: RegExp }) => loc(`role=${o.name}`),
    getByText: (t: string) => loc(`text=${t}`),
    waitForURL: async () => {
      if (!st.resultsLoad) throw new Error('timeout');
    },
    waitForTimeout: async () => {},
    evaluate: async (fn: () => unknown, arg?: unknown) => {
      if (typeof arg === 'string') return st.dayInCalendar;
      const code = String(fn);
      if (code.includes('day_cell')) {
        const s = st.states[Math.min(stateIdx, st.states.length - 1)];
        stateIdx++;
        return s;
      }
      return st.rows;
    },
  };
  const browser = {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => {
      log.closed++;
    },
  };
  const launch = async () => {
    log.launched++;
    return browser as unknown as Browser;
  };
  return { launch, log };
}

const base = { origin: 'Madrid', destination: 'Barcelona', date: DATE };

describe('searchRenfe con página falsa', () => {
  it('día ya correcto: devuelve los trenes con tipo y completo, prefiere (TODAS) y cierra el navegador', async () => {
    const f = fakeBrowser();
    const r = await searchRenfe(base, { launch: f.launch });
    expect(r.total).toBe(2);
    expect(r.trains.map((t) => t.salida)).toEqual(['06:27', '16:27']);
    expect(r.trains[0]?.tipo).toBe('AVE');
    expect(r.trains[1]?.completo).toBe(true);
    expect(r.trains[0]?.estacionSalida).toBeUndefined(); // detalle best effort, sin inventar
    expect(f.log.picked).toEqual(['MADRID (TODAS)', 'BARCELONA (TODAS)']);
    expect(f.log.closed).toBe(1);
  });

  it('after y limit recortan lo devuelto pero total cuenta todos', async () => {
    const f = fakeBrowser();
    const r = await searchRenfe({ ...base, after: '10:00', limit: 5 }, { launch: f.launch });
    expect(r.trains.map((t) => t.salida)).toEqual(['16:27']);
    expect(r.total).toBe(2);
  });

  it('un origen con paréntesis («Madrid (Todas)») se busca como texto, no como grupo de RegExp', async () => {
    const f = fakeBrowser();
    const r = await searchRenfe({ ...base, origin: 'Madrid (Todas)' }, { launch: f.launch });
    expect(r.total).toBe(2);
    expect(f.log.picked[0]).toBe('MADRID (TODAS)');
  });

  it('un origen cortado a 20 caracteres a mitad de paréntesis no revienta con SyntaxError', async () => {
    const f = fakeBrowser({ suggestions: ['ALCAZAR DE S.JUAN (CR', 'BARCELONA (TODAS)'] });
    await expect(
      searchRenfe({ ...base, origin: 'Alcazar de S.Juan (CR)' }, { launch: f.launch }),
    ).resolves.toMatchObject({ total: 2 });
  });

  it('el (TODAS) que se elige es el de la estación tecleada, no otro visible', async () => {
    const f = fakeBrowser({
      suggestions: ['MADRID (TODAS)', 'BARCELONA-SANTS', 'BARCELONA (TODAS)', 'BARBASTRO'],
    });
    await searchRenfe(base, { launch: f.launch });
    expect(f.log.picked).toEqual(['MADRID (TODAS)', 'BARCELONA (TODAS)']);
  });

  it('sin sugerencias: error del paso origen y navegador cerrado', async () => {
    const f = fakeBrowser({ suggestions: ['BARCELONA (TODAS)', 'VALENCIA (TODAS)'] });
    await expect(searchRenfe(base, { launch: f.launch })).rejects.toThrow(/paso origen/);
    expect(f.log.closed).toBe(1);
  });

  it('día fuera del calendario: error del paso fecha', async () => {
    const f = fakeBrowser({ dayInCalendar: false });
    await expect(searchRenfe(base, { launch: f.launch })).rejects.toThrow(/paso fecha: 2099-11-04/);
    expect(f.log.closed).toBe(1);
  });

  it('la página de resultados no carga: error del paso búsqueda', async () => {
    const f = fakeBrowser({ resultsLoad: false });
    await expect(searchRenfe(base, { launch: f.launch })).rejects.toThrow(/paso búsqueda/);
  });

  it('Renfe muestra otro día y el pedido no está en la barra: nunca devuelve trenes de otro día', async () => {
    const f = fakeBrowser({
      states: [{ pressed: '30/10/2099', fingerprint: 'X', summaryDay: '30' }],
      cellExists: false,
    });
    await expect(searchRenfe(base, { launch: f.launch })).rejects.toThrow(
      /no devuelvo trenes de otro día/,
    );
  });

  it('otro día: pulsa el pedido, espera a que la lista cambie y se quede quieta', async () => {
    const f = fakeBrowser({
      states: [
        { pressed: '30/10/2099', fingerprint: 'X', summaryDay: '30' },
        { pressed: WANT, fingerprint: 'A|B', summaryDay: '4' },
        { pressed: WANT, fingerprint: 'A|B', summaryDay: '4' },
      ],
    });
    const r = await searchRenfe(base, { launch: f.launch });
    expect(f.log.cellClicks).toBe(1);
    expect(r.total).toBe(2);
  });

  it('otro día: si la lista no cambia tras pulsar, error en vez de la lista vieja', async () => {
    const f = fakeBrowser({
      states: [
        { pressed: '30/10/2099', fingerprint: 'X', summaryDay: '' },
        { pressed: WANT, fingerprint: 'X', summaryDay: '' },
      ],
    });
    await expect(searchRenfe(base, { launch: f.launch })).rejects.toThrow(/no cambió/);
  });

  it('lista cargada sin trenes legibles: error del paso resultados', async () => {
    const f = fakeBrowser({ body: 'Selecciona tu viaje\nNo hay trenes' });
    await expect(searchRenfe(base, { launch: f.launch })).rejects.toThrow(/paso resultados/);
    expect(f.log.closed).toBe(1);
  });

  it('una fecha imposible (30 de febrero) se rechaza sin abrir el navegador', async () => {
    const f = fakeBrowser();
    await expect(
      searchRenfe({ ...base, date: '2099-02-30' }, { launch: f.launch }),
    ).rejects.toThrow(/no existe/);
    expect(f.log.launched).toBe(0);
  });

  it('sin Chromium instalado: mensaje corto con el remedio, no el recuadro de Playwright', async () => {
    const tool = createRenfeTool({
      launch: async () => {
        throw new Error(
          "browserType.launch: Executable doesn't exist at /x/chrome\n╔══════╗\n║ Looks like Playwright was just installed ║\n║ npx playwright install ║\n╚══════╝",
        );
      },
    });
    const err = await tool.execute('1', base).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/paso navegador: .*npx playwright install chromium/);
    expect(err?.message).not.toMatch(/╔|\n/);
  });
});
