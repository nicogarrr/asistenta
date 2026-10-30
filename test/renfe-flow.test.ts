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
  /** Texto del modal «Detalles del trayecto» que abre cada fila (null = no abre). */
  modals?: (string | null)[];
  /** El modal anterior se queda abierto: `.modal:visible` sigue dando el primero. */
  modalSticks?: boolean;
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
  const log = { closed: 0, launched: 0, cellClicks: 0, picked: [] as string[], modalCloses: 0 };
  // Fila de resultados abierta ahora y modal que se ve (para «Ver detalles del trayecto»).
  let row = -1;
  let shownModal = -1;
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
      nth: (i: number) => {
        if (sel.endsWith('.selectedTren')) row = i;
        return self;
      },
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
        if (sel.startsWith('.modal')) {
          if (st.modals?.[row] == null) throw new Error('timeout');
          if (!st.modalSticks || shownModal < 0) shownModal = row;
        }
      },
      count: async () => {
        if (sel.startsWith('li[role=option]')) return matching().length;
        if (sel.startsWith('button.day_cell')) return st.cellExists ? 1 : 0;
        return 0;
      },
      isVisible: async () => sel.startsWith('button.day_cell'),
      innerText: async () => {
        if (sel.startsWith('.modal')) return st.modals?.[shownModal] ?? '';
        return sel === 'body' ? st.body : '';
      },
      evaluate: async () => {
        if (sel.startsWith('.modal') && sel.endsWith('.close')) log.modalCloses++;
        return undefined;
      },
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

// Texto real del modal de Renfe: iconos sueltos, horas HH:MM y la estación debajo.
const DETAIL_0627 = `Detalles del trayecto
radio_button_checked
06:27
MADRID-PUERTA DE ATOCHA
07:45
ZARAGOZA-DELICIAS
location_on
09:56
BARCELONA-SANTS
close`;
const DETAIL_1627 = `Detalles del trayecto
radio_button_checked
16:27
MADRID-PUERTA DE ATOCHA
location_on
19:44
BARCELONA-SANTS`;

describe('searchRenfe: estaciones desde «Ver detalles del trayecto» (página falsa)', () => {
  it('cada tren recibe las estaciones y paradas de SU modal y el modal se cierra tras leerlo', async () => {
    const f = fakeBrowser({ modals: [DETAIL_0627, DETAIL_1627] });
    const r = await searchRenfe(base, { launch: f.launch });
    expect(r.trains[0]).toMatchObject({
      estacionSalida: 'MADRID-PUERTA DE ATOCHA',
      estacionLlegada: 'BARCELONA-SANTS',
      paradas: ['07:45 ZARAGOZA-DELICIAS'],
    });
    expect(r.trains[1]).toMatchObject({
      estacionSalida: 'MADRID-PUERTA DE ATOCHA',
      estacionLlegada: 'BARCELONA-SANTS',
      paradas: [],
    });
    expect(f.log.modalCloses).toBe(2);
    expect(f.log.closed).toBe(1);
  });

  it('un modal anterior que sigue abierto (horas de otro tren) no asigna estaciones', async () => {
    const f = fakeBrowser({ modals: [DETAIL_0627, DETAIL_1627], modalSticks: true });
    const r = await searchRenfe(base, { launch: f.launch });
    expect(r.trains[0]?.estacionSalida).toBe('MADRID-PUERTA DE ATOCHA');
    expect(r.trains[1]?.estacionSalida).toBeUndefined();
    expect(r.trains[1]?.estacionLlegada).toBeUndefined();
    expect(r.trains[1]?.paradas).toBeUndefined();
  });

  it('el modal es de la misma hora de salida pero otra llegada: no se asigna nada', async () => {
    const otro = DETAIL_1627.replace('19:44', '20:10');
    const f = fakeBrowser({ modals: [DETAIL_0627, otro] });
    const r = await searchRenfe(base, { launch: f.launch });
    expect(r.trains[0]?.estacionLlegada).toBe('BARCELONA-SANTS');
    expect(r.trains[1]?.estacionLlegada).toBeUndefined();
  });

  it('el modal no se abre en una fila: ese tren sale sin estaciones y los demás siguen', async () => {
    const f = fakeBrowser({ modals: [null, DETAIL_1627] });
    const r = await searchRenfe(base, { launch: f.launch });
    expect(r.total).toBe(2);
    expect(r.trains[0]?.estacionSalida).toBeUndefined();
    expect(r.trains[1]?.estacionSalida).toBe('MADRID-PUERTA DE ATOCHA');
    expect(f.log.closed).toBe(1);
  });

  it('un modal con una sola parada legible no inventa estaciones', async () => {
    const f = fakeBrowser({
      modals: ['Detalles del trayecto\n06:27\nMADRID-PUERTA DE ATOCHA', null],
    });
    const r = await searchRenfe(base, { launch: f.launch });
    expect(r.trains[0]?.estacionSalida).toBeUndefined();
    expect(r.trains[0]?.paradas).toBeUndefined();
  });

  it('la fila cuya hora no cuadra con el tren no se abre ni se le piden detalles', async () => {
    const f = fakeBrowser({
      modals: [DETAIL_0627, DETAIL_1627],
      rows: [
        { labels: ['Tren con salida a las 06:27 horas'], text: '' },
        { labels: ['Tren con salida a las 16:30 horas'], text: '' },
      ],
    });
    const r = await searchRenfe(base, { launch: f.launch });
    expect(r.trains[0]?.estacionSalida).toBe('MADRID-PUERTA DE ATOCHA');
    expect(r.trains[1]?.estacionSalida).toBeUndefined();
    expect(f.log.modalCloses).toBe(1);
  });

  it('el texto de la herramienta muestra «origen -> destino» solo para el tren con estaciones', async () => {
    const f = fakeBrowser({ modals: [DETAIL_0627, null] });
    const tool = createRenfeTool({ launch: f.launch });
    const res = await tool.execute('t1', base);
    const text = res.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('MADRID-PUERTA DE ATOCHA -> BARCELONA-SANTS');
    expect(text.match(/ -> BARCELONA-SANTS/g)?.length).toBe(1);
    expect(text).toMatch(/16:27 -> 19:44 \(/);
  });
});
