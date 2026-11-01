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

  it('cada respuesta pregunta normal y da un ejemplo de verdad', () => {});

  it('el botón «Vigilar» caducado no enseña <enlace>', () => {
    expect(COMPARE_WATCH_STALE).not.toMatch(MARCADOR);
  });

  it('las frases nuevas no llevan marcadores', () => {
    const nuevas = [
      ...cli.matchAll(
        /'(¿Qué (?:página|producto|investigo)[^']*|No te he entendido[^']*|Mándame el PDF[^']*)'/g,
      ),
    ].map((m) => m[1] ?? '');
    for (const t of nuevas) expect(t).not.toMatch(MARCADOR);
  });
});
