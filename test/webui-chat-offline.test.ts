import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

function trozo(html: string, cabecera: string): string {
  const inicio = html.indexOf(cabecera);
  expect(inicio).toBeGreaterThan(-1);
  const fin = html.indexOf('\n      }\n', inicio);
  return html.slice(inicio, fin + 8);
}

const html = renderPage();

describe('panel: chat sin conexión', () => {
  it('la tarjeta Chat tiene su aviso «Sin conexión», oculto de entrada y anunciado', () => {
    const chat = html.slice(
      html.indexOf('aria-labelledby="titulo-chat"'),
      html.indexOf('id="panel-chat"'),
    );
    expect(chat).toMatch(
      /<p id="conexion-chat" class="aviso-conexion" role="status" hidden>Sin conexión/,
    );
  });

  it('llamar() marca el fallo de red como sinConexion (y un error del servidor no)', async () => {
    const fuente = `${trozo(html, 'async function llamar(')}\nreturn llamar;`;
    const hacer = (fetch: () => Promise<unknown>) =>
      new Function('token', 'fetch', 'errorSinToken', fuente)(
        'demo',
        fetch,
        () => new Error('sin token'),
      ) as (r: string, o: { metodo: string; cuerpo?: unknown }) => Promise<unknown>;
    const red = await hacer(() => Promise.reject(new TypeError('Failed to fetch')))('/api/chat', {
      metodo: 'POST',
      cuerpo: { text: 'hola' },
    }).catch((e) => e);
    expect(red).toMatchObject({
      sinConexion: true,
      message: expect.stringMatching(/No se pudo conectar/),
    });
    const servidor = await hacer(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'roto' }),
    }))('/api/chat', { metodo: 'POST', cuerpo: { text: 'hola' } }).catch((e) => e);
    expect(servidor).toBeInstanceOf(Error);
    expect((servidor as { sinConexion?: boolean }).sinConexion).toBeUndefined();
  });

  function montarAviso() {
    const elementos = {
      'conexion-aprobaciones': { hidden: true },
      'conexion-chat': { hidden: true },
    };
    const porId: Record<string, { hidden: boolean }> = elementos;
    const anuncios: string[] = [];
    const aviso = new Function(
      'document',
      'anunciar',
      `${trozo(html, 'function avisoConexion(')}\nreturn avisoConexion;`,
    )({ getElementById: (id: string) => porId[id] ?? null }, (t: string) => anuncios.push(t)) as (
      caido: boolean,
      desdeChat?: boolean,
    ) => void;
    return { aviso, elementos, anuncios };
  }

  it('un envío del chat sin red enseña ambos avisos; la vuelta de la conexión quita los dos y lo anuncia', () => {
    const m = montarAviso();
    m.aviso(true, true);
    expect(m.elementos['conexion-chat'].hidden).toBe(false);
    expect(m.elementos['conexion-aprobaciones'].hidden).toBe(false);
    m.aviso(false);
    expect(m.elementos['conexion-chat'].hidden).toBe(true);
    expect(m.elementos['conexion-aprobaciones'].hidden).toBe(true);
    expect(m.anuncios).toEqual(['Conexión con el asistente recuperada.']);
  });

  it('la recarga automática caída no pone el aviso del chat (no se perdió ningún mensaje)', () => {
    const m = montarAviso();
    m.aviso(true);
    expect(m.elementos['conexion-chat'].hidden).toBe(true);
    expect(m.elementos['conexion-aprobaciones'].hidden).toBe(false);
  });

  it('enviarChat avisa sin conexión solo si el fallo es de red, y lo quita cuando contesta', async () => {
    const fuente = `${trozo(html, 'async function enviarChat(')}\nreturn enviarChat;`;
    const llamadas: unknown[][] = [];
    const montar = (enviar: () => Promise<unknown>) => {
      const campo = { value: '', focus() {} };
      const boton = { disabled: false };
      const turno = () => {
        const cuerpo = { textContent: '', className: '' };
        return { className: '', querySelector: () => cuerpo, appendChild() {} };
      };
      return new Function(
        'document',
        'window',
        'anadirTurno',
        'formato',
        'enviar',
        'nodo',
        'avisoConexion',
        fuente,
      )(
        { getElementById: (id: string) => (id === 'texto-chat' ? campo : boton) },
        { setInterval: () => 1, clearInterval() {} },
        turno,
        { textoEspera: () => 'Pensando…' },
        enviar,
        () => ({ type: '', addEventListener() {} }),
        (...a: unknown[]) => llamadas.push(a),
      ) as (e: null, t: string) => Promise<void>;
    };
    await montar(() =>
      Promise.reject(Object.assign(new Error('No se pudo conectar'), { sinConexion: true })),
    )(null, 'hola');
    expect(llamadas).toEqual([[true, true]]);
    llamadas.length = 0;
    await montar(() => Promise.reject(new Error('El asistente respondió 500')))(null, 'hola');
    expect(llamadas).toEqual([]);
    await montar(async () => ({ text: 'vale' }))(null, 'hola');
    expect(llamadas).toEqual([[false]]);
  });
});
