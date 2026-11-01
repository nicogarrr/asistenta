import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Nico (31 oct): que Asistenta hable como en un chat. Panel y /cron sin
// «sesiones», «JSON», «ticks» ni identificadores de objetivo.
const panel = readFileSync('src/webui/page.ts', 'utf8');
const cron = readFileSync('src/daemon/cron-command.ts', 'utf8');

describe('textos fijos sin jerga (6)', () => {
  it('panel: «Conversaciones» en vez de «Sesiones»', () => {
    expect(panel).toContain('<h2 id="titulo-sesiones">Conversaciones</h2>');
    expect(panel).toContain("'No hay conversaciones que coincidan.'");
    expect(panel).not.toContain('No hay sesiones');
  });

  it('panel: una respuesta rara no habla de «JSON»', () => {
    expect(panel).toContain("'El panel ha contestado algo que no entiendo. Recarga la página.'");
    expect(panel).not.toContain('no es JSON válido');
  });

  it('/cron con un objetivo: sin «ticks» ni el identificador', () => {
    expect(cron).not.toMatch(/con ticks|sin ticks/);
    expect(cron).toContain("'Ese objetivo ya no existe: no hay nada que probar.'");
    expect(cron).not.toContain('El objetivo $' + '{id} ya no existe');
  });
});
