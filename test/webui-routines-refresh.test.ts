import { describe, expect, it } from 'vitest';
import { fechaCortaEs } from '../src/tools/reminder.js';
import { type PanelRoutineSource, panelRoutines } from '../src/webui/next-up.js';
import { renderPage } from '../src/webui/page.js';

function trozo(html: string, cabecera: string): string {
  const inicio = html.indexOf(cabecera);
  expect(inicio).toBeGreaterThan(-1);
  const fin = html.indexOf('\n      }\n', inicio);
  return html.slice(inicio, fin + 8);
}

const base: PanelRoutineSource = {
  scope: 'local',
  name: 'resumen',
  kind: 'schedule',
  schedule: '0 8 * * *',
  enabled: true,
  prompt: 'resume el día',
};

describe('panel: Rutinas con última ejecución', () => {
  it('panelRoutines da la última ejecución legible, o null si nunca o ilegible', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    const iso = '2026-10-30T07:00:00.000Z';
    const filas = panelRoutines(
      [
        { ...base, name: 'a', lastRunAt: iso },
        { ...base, name: 'b', lastRunAt: null },
        { ...base, name: 'c', lastRunAt: 'ayer' },
        { ...base, name: 'd', lastRunAt: String(Date.parse(iso)) },
      ],
      [],
      () => '',
      undefined,
      now,
    );
    const por = Object.fromEntries(filas.map((f) => [f.nombre, f.ultima]));
    expect(por).toEqual({
      a: fechaCortaEs(new Date(iso)),
      b: null,
      c: null,
      d: fechaCortaEs(new Date(iso)),
    });
  });
});

type Nodo = { texto: string; hijos: Nodo[]; appendChild(n: Nodo): void; setAttribute(): void };
function nodo(_tag: string, _cls: string | null, texto?: string): Nodo {
  const n: Nodo = {
    texto: texto ?? '',
    hijos: [],
    appendChild(h) {
      n.hijos.push(h);
    },
    setAttribute() {},
  };
  return n;
}
const textos = (n: Nodo): string[] => [n.texto, ...n.hijos.flatMap(textos)];

function montarCarga(respuesta: () => Promise<unknown>) {
  const llamadas = { carga: 0, error: 0, fin: 0 };
  let hijos: Nodo[] = [nodo('p', null, 'lo de antes')];
  const contenedor = {
    replaceChildren: (...n: Nodo[]) => {
      hijos = n;
    },
    appendChild: (n: Nodo) => {
      hijos.push(n);
    },
  };
  const fuente = `${trozo(renderPage(), 'async function cargarRutinas(')}\nreturn cargarRutinas;`;
  const cargar = new Function(
    'document',
    'pedir',
    'nodo',
    'insignia',
    'pintarCarga',
    'finCarga',
    'pintarError',
    fuente,
  )(
    { getElementById: () => contenedor },
    respuesta,
    nodo,
    (_c: string, t: string) => nodo('span', null, t),
    () => {
      llamadas.carga += 1;
    },
    () => {
      llamadas.fin += 1;
    },
    () => {
      llamadas.error += 1;
    },
  ) as (silencio?: boolean) => Promise<boolean>;
  return { cargar, llamadas, textos: () => hijos.flatMap(textos) };
}

describe('panel: tarjeta Rutinas en el navegador', () => {
  const filas = [
    {
      nombre: 'resumen',
      horario: '0 8 * * *',
      activa: true,
      proxima: 'sáb 31/10 08:00 (en 18 h)',
      comando: null,
      ultima: 'vie 30/10 08:00',
    },
    {
      nombre: 'backup',
      horario: '0 3 * * *',
      activa: true,
      proxima: 'sáb 31/10 03:00 (en 13 h)',
      comando: null,
      ultima: null,
    },
  ];

  it('enseña «Última:» con la fecha o «todavía no se ha ejecutado»', async () => {
    const m = montarCarga(async () => filas);
    expect(await m.cargar()).toBe(true);
    expect(m.textos()).toContain('Última: vie 30/10 08:00');
    expect(m.textos()).toContain('Última: todavía no se ha ejecutado');
  });

  it('en silencio no pinta «Cargando…» y si falla deja lo que ya se veía', async () => {
    const m = montarCarga(async () => {
      throw new Error('caído');
    });
    expect(await m.cargar(true)).toBe(false);
    expect(m.llamadas).toEqual({ carga: 0, error: 0, fin: 0 });
    expect(m.textos()).toEqual(['lo de antes']);
  });

  it('el refresco normal sigue pintando la carga y el error con Reintentar', async () => {
    const m = montarCarga(async () => {
      throw new Error('caído');
    });
    expect(await m.cargar()).toBe(false);
    expect(m.llamadas.carga).toBe(1);
    expect(m.llamadas.error).toBe(1);
  });
});

describe('panel: Rutinas al volver a la pestaña', () => {
  function montar(token: string) {
    const documento = { visibilityState: 'visible' };
    const cargas: unknown[] = [];
    const fuente = `var ocultaDesde = 0;\n${trozo(renderPage(), 'function alCambiarVisibilidad(')}\nreturn alCambiarVisibilidad;`;
    const cambiar = new Function(
      'document',
      'token',
      'cargarAprobacionesEnSilencio',
      'cargarRutinas',
      fuente,
    )(
      documento,
      token,
      () => {},
      (silencio: unknown) => {
        cargas.push(silencio);
      },
    ) as () => void;
    return {
      ir(estado: 'visible' | 'hidden') {
        documento.visibilityState = estado;
        cambiar();
      },
      cargas,
    };
  }

  it('recarga las Rutinas en silencio una vez por vuelta, y no sin token', () => {
    const p = montar('demo');
    p.ir('visible');
    expect(p.cargas).toEqual([]);
    p.ir('hidden');
    p.ir('visible');
    p.ir('visible');
    expect(p.cargas).toEqual([true]);
    const sin = montar('');
    sin.ir('hidden');
    sin.ir('visible');
    expect(sin.cargas).toEqual([]);
  });
});
