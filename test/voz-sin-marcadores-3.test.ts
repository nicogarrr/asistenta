import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMPARE_WATCH_STALE } from '../src/watch/compare.js';

// Nico (1 nov): «conversaciones naturales, no usar cosas como <número o palabra>».
// Correo, OCR, vigilancias, comparar, investigar, consumo, pendientes, calendario,
// conversaciones y /steer contestaban con «Uso: /cmd <arg> [opcional]». Ahora:
// una pregunta normal con un ejemplo real.
const MARCADOR = /<[a-záéíóúñ][^<>\n]{0,40}>|\bUso:|\[[a-z]+(?:\|[a-z0-9-]+)+\]/i;
const cli = readFileSync('src/cli.ts', 'utf8');
const steer = readFileSync('src/steer.ts', 'utf8');
const wide = readFileSync('src/research/wide-research.ts', 'utf8');
const deep = readFileSync('src/research/deep-research.ts', 'utf8');

describe('respuestas naturales, sin <marcadores> (3): compras, investigación, correo y más', () => {
  it('ya no queda ningún «Uso: /cmd <…>» de estos comandos', () => {
    for (const viejo of [
      'Uso: /correo',
      'Uso: manda un PDF',
      'Uso: /vigila <enlace>',
      'Uso: /compara <enlace',
      'Uso: /investiga',
      'Uso: /consumo',
      'Uso: /resolver',
      'Uso: /calendario',
      'Fecha no válida. Usa',
      'Usa /topic <nombre>',
      'Prueba /vigila <enlace>',
    ]) {
      expect(cli).not.toContain(viejo);
    }
    expect(steer).not.toContain('/steer <nueva instrucción>');
    expect(wide).not.toContain('Falta la pregunta: /investiga amplio <pregunta>');
    expect(wide).not.toContain('Falta la lista: /investiga amplio <pregunta>');
    expect(deep).not.toContain('Falta la pregunta: /investiga <pregunta>');
  });

  it('cada respuesta pregunta normal y da un ejemplo de verdad', () => {
    expect(cli).toContain(
      "'¿Qué página vigilo? Pásame el enlace, por ejemplo: /vigila https://tienda.es/producto objetivo=500€.",
    );
    expect(cli).toContain(
      "'¿Qué producto comparo? Pásame el enlace de su ficha, por ejemplo: /compara https://tienda.es/producto.",
    );
    expect(cli).toContain(
      "'¿Qué investigo? Por ejemplo: /investiga ¿merece la pena la aerotermia en Madrid?",
    );
    expect(cli).toContain(
      '/consumo hoy, /consumo semana, /consumo mes o un número de días, como /consumo 10.',
    );
    expect(cli).toContain(
      "'¿Cuál doy por resuelto? Mira /pendientes y dime su código o una palabra, por ejemplo /resolver factura.'",
    );
    expect(cli).toContain(
      "'Para abrir otra, ponle nombre, por ejemplo /topic viaje. Con /topics las ves todas.'",
    );
    expect(steer).toContain("'¿Qué cambio? Por ejemplo: /steer mejor en euros y sin IVA.'");
  });

  it('el botón «Vigilar» caducado no enseña <enlace>', () => {
    expect(COMPARE_WATCH_STALE).not.toMatch(MARCADOR);
    expect(COMPARE_WATCH_STALE).toContain('Mándame /vigila con el enlace del producto.');
  });

  it('las frases nuevas no llevan marcadores', () => {
    const nuevas = [
      ...cli.matchAll(
        /'(¿Qué (?:página|producto|investigo)[^']*|No te he entendido[^']*|Mándame el PDF[^']*)'/g,
      ),
    ].map((m) => m[1] ?? '');
    expect(nuevas.length).toBeGreaterThanOrEqual(5);
    for (const t of nuevas) expect(t).not.toMatch(MARCADOR);
  });
});
