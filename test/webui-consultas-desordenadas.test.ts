import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Búsqueda de Sesiones y ámbito de Memoria, sin navegador: el código real de la página
// (cargarSesiones, cargarMemoria) con un DOM falso y respuestas que llegan desordenadas.
// Lo que se ve debe corresponder siempre a la última consulta, no a la que llegó la última.
const html = renderPage();
function trozo(desde: string, hasta: string): string {
  const a = html.indexOf(desde);
  const b = html.indexOf(hasta, a);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  return html.slice(a, b);
}

function montar(funcion: 'cargarSesiones' | 'cargarMemoria') {
  const campo = { value: '' };
  const contenedor = { id: 'contenedor' };
  const pintado: string[] = [];
  const errores: string[] = [];
  const pendientes: Record<string, { ok: (v: unknown) => void; ko: (e: unknown) => void }> = {};
  const fuente =
    funcion === 'cargarSesiones'
      ? trozo('async function cargarSesiones', 'function pintarMemoria')
      : trozo('async function cargarMemoria', 'async function cargarAuditoria');
  // Los contadores de consulta pueden vivir fuera del trozo; declararlos aquí no cambia main.
  const cargar = new Function(
    'document',
    'pedir',
    'pintarCarga',
    'finCarga',
    'pintarSesiones',
    'pintarMemoria',
    'pintarError',
    `var consultaSesiones = 0; var consultaMemoria = 0;\n${fuente}\nreturn ${funcion};`,
  )(
    { getElementById: (id: string) => (id.startsWith('panel-') ? contenedor : campo) },
    (ruta: string) =>
      new Promise((ok, ko) => {
        pendientes[ruta] = { ok, ko };
      }),
    () => {},
    () => {},
    (_c: unknown, d: { q: string }) => pintado.push(d.q),
    (_c: unknown, d: { q: string }) => pintado.push(d.q),
    (_c: unknown, e: Error) => errores.push(e.message),
  ) as () => Promise<boolean>;
  return { cargar, campo, pintado, errores, pendientes };
}
const tic = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('panel: respuestas desordenadas en Sesiones y Memoria', () => {
  it('Sesiones: si la búsqueda vieja contesta después de la nueva, se queda la nueva', async () => {
    const m = montar('cargarSesiones');
    m.campo.value = 'vu';
    const vieja = m.cargar();
    m.campo.value = 'vuelos';
    const nueva = m.cargar();
    m.pendientes['/api/sessions?q=vuelos']?.ok({ q: 'vuelos' });
    await tic();
    m.pendientes['/api/sessions?q=vu']?.ok({ q: 'vu' });
    await Promise.all([vieja, nueva]);
    expect(m.pintado).toEqual(['vuelos']);
  });

  it('Sesiones: un error de la búsqueda vieja no tapa los resultados de la nueva', async () => {
    const m = montar('cargarSesiones');
    m.campo.value = 'a';
    const vieja = m.cargar();
    m.campo.value = 'ab';
    const nueva = m.cargar();
    m.pendientes['/api/sessions?q=ab']?.ok({ q: 'ab' });
    await tic();
    m.pendientes['/api/sessions?q=a']?.ko(new Error('HTTP 500'));
    await Promise.all([vieja, nueva]);
    expect(m.pintado).toEqual(['ab']);
    expect(m.errores).toEqual([]);
  });

  it('Memoria: al cambiar de ámbito, la respuesta tardía del anterior no pinta encima', async () => {
    const m = montar('cargarMemoria');
    m.campo.value = '';
    const vieja = m.cargar();
    m.campo.value = 'local';
    const nueva = m.cargar();
    m.pendientes['/api/memory?scope=local']?.ok({ q: 'local' });
    await tic();
    m.pendientes['/api/memory']?.ok({ q: 'defecto' });
    await Promise.all([vieja, nueva]);
    expect(m.pintado).toEqual(['local']);
  });

  it('una sola consulta se pinta como siempre', async () => {
    const m = montar('cargarMemoria');
    const p = m.cargar();
    m.pendientes['/api/memory']?.ok({ q: 'defecto' });
    await expect(p).resolves.toBe(true);
    expect(m.pintado).toEqual(['defecto']);
  });
});
