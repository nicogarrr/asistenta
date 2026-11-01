import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Nico (31 oct): la cabecera del panel decía siempre «1 sección sin cargar» aunque todo
// cargara. «Actualizar» cuenta como fallo cada carga que no devuelve true, y
// cargarAmbitos() no devolvía nada. Probamos la función real de la página con fakes.
function cargarAmbitosDeLaPagina(pedir: (ruta: string) => Promise<unknown>) {
  const html = renderPage();
  const inicio = html.indexOf('async function cargarAmbitos()');
  expect(inicio).toBeGreaterThan(-1);
  const resto = html.slice(inicio);
  const fin = resto.indexOf('\n      }\n') + '\n      }\n'.length;
  const fuente = resto.slice(0, fin);
  const lista = { value: '', replaceChildren: (..._opciones: unknown[]) => {} };
  const document = { getElementById: () => lista };
  const nodo = () => ({ value: '' });
  const formato = { etiquetaAmbitoPorDefecto: () => 'Privado', etiquetaAmbito: (a: string) => a };
  const fabricar = new Function(
    'document',
    'pedir',
    'nodo',
    'formato',
    `${fuente}\nreturn cargarAmbitos;`,
  );
  return fabricar(document, pedir, nodo, formato) as () => Promise<unknown>;
}

describe('panel: «sin cargar» solo cuenta fallos reales', () => {
  it('ámbitos cargados cuentan como sección cargada', async () => {
    const cargar = cargarAmbitosDeLaPagina(async () => ({
      porDefecto: 'telegram:dm:1',
      ambitos: ['local', 'telegram:dm:1', 'telegram:grupo:2'],
    }));
    await expect(cargar()).resolves.toBe(true);
  });

  it('también con la lista antigua (array) de ámbitos', async () => {
    const cargar = cargarAmbitosDeLaPagina(async () => ['local', 'telegram:dm:1']);
    await expect(cargar()).resolves.toBe(true);
  });

  it('si la petición falla, cuenta como sin cargar', async () => {
    const cargar = cargarAmbitosDeLaPagina(async () => {
      throw new Error('red caída');
    });
    await expect(cargar()).resolves.toBe(false);
  });

  it('si la respuesta no trae ámbitos, cuenta como sin cargar', async () => {
    const cargar = cargarAmbitosDeLaPagina(async () => ({ algo: 1 }));
    await expect(cargar()).resolves.toBe(false);
  });
});
