import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Extrae una función del script del panel por su nombre (cuerpo hasta la llave de cierre a 6 espacios).
function funcion(html: string, nombre: string): string {
  const inicio = html.indexOf(`function ${nombre}(`);
  expect(inicio).toBeGreaterThan(-1);
  const fin = html.indexOf('\n      }\n', inicio);
  return html.slice(inicio, fin + 8);
}

type Entorno = { respuesta: () => Promise<unknown> };

function cargar(entorno: Entorno) {
  const html = renderPage();
  const aviso = { hidden: true };
  const contenedor = { contains: () => false };
  const anuncios: string[] = [];
  const pintadas: unknown[] = [];
  const documento = {
    activeElement: { tagName: 'BODY' },
    getElementById: (id: string) => (id === 'conexion-aprobaciones' ? aviso : contenedor),
  };
  const fuente = `async ${funcion(html, 'cargarAprobacionesEnSilencio')}\n${funcion(html, 'avisoConexion')}\nreturn cargarAprobacionesEnSilencio;`;
  const recargar = new Function(
    'document',
    'pedir',
    'pintarAprobaciones',
    'finCarga',
    'anunciar',
    fuente,
  )(
    documento,
    () => entorno.respuesta(),
    (_c: unknown, datos: unknown) => pintadas.push(datos),
    () => {},
    (t: string) => anuncios.push(t),
  ) as () => Promise<void>;
  return { recargar, aviso, anuncios, pintadas };
}

describe('panel: aviso de sin conexión en la recarga automática', () => {
  it('el aviso existe en la tarjeta, oculto y anunciado como estado', () => {
    const html = renderPage();
    expect(html).toMatch(
      /<p id="conexion-aprobaciones" class="aviso-conexion" role="status" hidden>Sin conexión con el asistente/,
    );
  });

  it('si el asistente cae lo muestra sin borrar lo ya pintado, y lo quita al volver', async () => {
    const entorno: Entorno = { respuesta: async () => [] };
    const { recargar, aviso, anuncios, pintadas } = cargar(entorno);
    await recargar();
    expect(aviso.hidden).toBe(true);
    expect(anuncios).toEqual([]);
    entorno.respuesta = async () => {
      throw new Error('fetch failed');
    };
    await recargar();
    expect(aviso.hidden).toBe(false);
    expect(pintadas).toHaveLength(1);
    await recargar();
    expect(aviso.hidden).toBe(false);
    entorno.respuesta = async () => [{ id: 'a1' }];
    await recargar();
    expect(aviso.hidden).toBe(true);
    expect(anuncios).toEqual(['Conexión con el asistente recuperada.']);
  });

  it('sin token no habla de conexión: ya se pide el token', async () => {
    const { recargar, aviso } = cargar({
      respuesta: async () => {
        throw Object.assign(new Error('Falta el token'), { sinToken: true });
      },
    });
    await recargar();
    expect(aviso.hidden).toBe(true);
  });
});
