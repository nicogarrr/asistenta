import { describe, expect, it } from 'vitest';
import { composeWeekly, spokenDigest } from '../src/bandeja/resumen.js';
import type { BandejaItem } from '../src/bandeja/store.js';
import { bibliotecaVista } from '../src/biblioteca.js';
import type { Creado } from '../src/creados.js';
import { previstoTexto } from '../src/previsto.js';

// bugs-34: concordancias que se leían mal en Telegram (y en voz):
// «No tengo ningún imagen», «1 cosas guardadas», «Hoy guardaste 1 cosas», «Y 1 son paja»,
// «1 rutina(s) en pausa no salen».

const item = (over: Partial<BandejaItem>): BandejaItem =>
  ({
    id: 1,
    chatId: '1',
    day: '2026-11-11',
    kind: 'enlace',
    status: 'listo',
    state: 'nuevo',
    verdict: 'ideas',
    title: 'Algo',
    ...over,
  }) as BandejaItem;

describe('concordancia de género y número', () => {
  it('/biblioteca graficas sin imágenes: «ninguna imagen»', () => {
    const lista = [
      { id: '20261111-120000-informe.pdf', nombre: 'informe.pdf', bytes: 2048, creado: 0 },
    ] satisfies Creado[];
    expect(bibliotecaVista(lista, 'imagen').text).toContain('No tengo ninguna imagen');
    expect(bibliotecaVista(lista, 'excel').text).toContain('No tengo ningún Excel');
  });

  it('una sola cosa en la semana y en la versión hablada', () => {
    const one = [item({ verdict: 'paja' })];
    expect(composeWeekly(one)).toMatch(/^🏆 Tu semana en la bandeja: 1 cosa guardada · /);
    const spoken = spokenDigest(one);
    expect(spoken).toContain('Hoy guardaste una cosa.');
    expect(spoken).toContain('Y una es paja.');
    expect(spokenDigest([item({ verdict: 'ideas' })])).toContain('Una tiene ideas buenas');
    expect(spokenDigest([item({}), item({ id: 2 })])).toContain('Hoy guardaste 2 cosas.');
  });

  it('/previsto: «1 rutina en pausa no sale»', () => {
    const now = new Date('2026-11-11T12:00:00+01:00');
    expect(previstoTexto({ filas: [], pausadas: 1 }, 'dia', now)).toContain(
      '⏸️ 1 rutina en pausa no sale',
    );
    expect(previstoTexto({ filas: [], pausadas: 2 }, 'dia', now)).toContain(
      '⏸️ 2 rutinas en pausa no salen',
    );
  });
});
