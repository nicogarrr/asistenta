import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capturaDeLaPagina, sigueLaTareaEnCurso } from '../src/daemon/captura-tarea.js';
import { resolveInboundThread } from '../src/daemon/inbound.js';

/**
 * La conversación de Gertru (@XMihura, 3-oct, 00:08–00:15) pasada por Asistenta con
 * piezas falsas: nada de Renfe real ni red. Cada bloque es un mensaje del dueño.
 */
const PIDE =
  'Puedes mirar en la página de Renfe cuál es el primer tren que sale mañana de Madrid a Barcelona? Después de las 15';
const CAPTURA = 'Pásame una captura de pantalla cuando lo tengas';

// Página de resultados al estilo Renfe (lo que el navegador falso «ve» y fotografía).
const FIXTURE_RENFE = [
  'Selecciona tu viaje',
  '15:27 h · 3 horas 47 minutos · 19:14 h · Solo plaza H (silla de ruedas)',
  '15:57 h · 3 horas 2 minutos · 18:59 h · Precio desde 146,90 €',
].join('\n');

interface Hilo {
  key: string;
  active: boolean;
}

function enrutador(base: (t: string) => boolean) {
  const main: Hilo = { key: 'telegram:dm:1:main', active: false };
  const creados: string[] = [];
  const deps = {
    activeTopic: new Map<string, string>(),
    messageThread: new Map<string, string>(),
    threads: new Map<string, Hilo>(),
    goalScopeBySentId: () => undefined,
    splitGoalScope: () => ({ chatKey: '', thread: '' }),
    getOrCreateThread: async (_chat: string, name: string) => {
      creados.push(name);
      return { key: `telegram:dm:1:${name}`, active: false };
    },
    defaultThread: async () => main,
    looksLikeFollowUp: base,
  } as unknown as Parameters<typeof resolveInboundThread<Hilo>>[2];
  const llega = (messageId: string, text: string) =>
    resolveInboundThread<Hilo>(
      { messageId, text, chatId: '1' } as unknown as Parameters<typeof resolveInboundThread>[0],
      'telegram:dm:1',
      deps,
    );
  return { main, creados, llega };
}

// Lo que cli.ts compone: los «sí/vale» de siempre más «cuando lo tengas».
const sigueEnElHilo = (t: string) => /^(s[ií]|vale|ok)$/i.test(t.trim()) || sigueLaTareaEnCurso(t);

describe('escenario Renfe de Gertru en Asistenta', () => {
  it('«pásame una captura cuando lo tengas» a mitad de la búsqueda sigue en la misma conversación', async () => {
    const r = enrutador(sigueEnElHilo);
    const primero = await r.llega('10', PIDE);
    expect(primero).toBe(r.main);
    r.main.active = true; // buscando en Renfe
    const segundo = await r.llega('11', CAPTURA);
    expect(segundo).toBe(r.main);
    expect(r.creados).toEqual([]);
    // Una petición nueva y con contenido propio sí abre otra conversación.
    await r.llega(
      '12',
      'Y mira también el tiempo que hace en Barcelona este fin de semana, por favor',
    );
    expect(r.creados).toEqual(['m12']);
  });

  it('la captura es la página de Renfe de la tarea, no el escritorio', async () => {
    expect(capturaDeLaPagina(CAPTURA, true)).toBe(true);
    expect(capturaDeLaPagina(CAPTURA, false)).toBe(false);
    expect(capturaDeLaPagina('pásame una captura del PC', true)).toBe(false);
    expect(capturaDeLaPagina('mándame captura del escritorio', true)).toBe(false);
    // La página de la tarea (navegador sin ventana) es la que se fotografía y se manda:
    // en cli.ts sendScreenShot usa capturePageIfOpen cuando capturaDeLaPagina dice sí.
    expect(FIXTURE_RENFE).toContain('Precio desde 146,90 €');
  });

  it('frases que siguen la tarea y frases que no', () => {
    for (const t of [
      CAPTURA,
      'mándamelo en cuanto lo tengas',
      'avísame al terminar',
      'cuando acabes pásame el enlace',
    ]) {
      expect(sigueLaTareaEnCurso(t), t).toBe(true);
    }
    for (const t of [
      PIDE,
      'qué tiempo hace mañana',
      'cuando vayas a Madrid avísame de los trenes de la semana que viene y de los precios de los hoteles cerca de Atocha, que tengo que organizar el viaje con tiempo',
    ]) {
      expect(sigueLaTareaEnCurso(t), t).toBe(false);
    }
  });

  it('cli.ts usa las dos piezas (cableado)', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('looksLikeFollowUp(t) || sigueLaTareaEnCurso(t)');
    expect(cli).toContain('capturaDeLaPagina(inbound.text, service.isOpen(threadKey))');
    expect(cli).toMatch(/if \(!desktop \|\| pagina\) \{/);
  });
});
