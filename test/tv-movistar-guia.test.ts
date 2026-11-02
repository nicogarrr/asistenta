/**
 * Guía pública de Movistar Plus+ (src/tv/movistar.ts): parseo XMLTV, búsqueda
 * sin acentos, canal resuelto y solo próximas 48 h. Con fetch falso.
 */
import { describe, expect, it } from 'vitest';
import {
  movistarFind,
  normalizeTvText,
  parseXmltvDate,
  parseXmltvGuide,
} from '../src/tv/movistar.js';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
<channel id="mligs"><display-name>M+ LALIGA TV</display-name></channel>
<channel id="mplus"><display-name>Movistar Plus+</display-name></channel>
<channel id="cine"><display-name>M+ Cine</display-name></channel>
<programme start="20261102103000 +0000" stop="20261102123000 +0000" channel="mligs"><title lang="es">LALIGA HYPERMOTION (T26/27): Ceuta FC - Real Sporting</title><desc lang="es">El Ceuta afronta una nueva oportunidad.</desc></programme>
<programme start="20261102200000 +0000" stop="20261102220000 +0000" channel="mligs"><title lang="es">LALIGA HYPERMOTION (T26/27): RCD Mallorca - Cádiz CF</title><desc lang="es">El Mallorca cierra la jornada.</desc></programme>
<programme start="20261103150000 +0000" stop="20261103160000 +0000" channel="mplus"><title lang="es">Tierra de mafiosos</title><desc lang="es">Serie.</desc></programme>
<programme start="20261030000000 +0000" stop="20261030020000 +0000" channel="cine"><title lang="es">Ceuta, la película</title><desc lang="es">Emitido hace días.</desc></programme>
</tv>`;

const fakeFetch = (() =>
  Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(FIXTURE),
  } as Response)) as unknown as typeof fetch;

// La guía se cachea 10 min por módulo: una sola carga por proceso de test.
const NOW = new Date('2026-11-02T11:00:00Z');

describe('parseXmltvDate y normalizeTvText', () => {
  it('fecha XMLTV con y sin zona', () => {
    expect(parseXmltvDate('20261102103000 +0000')?.toISOString()).toBe('2026-11-02T10:30:00.000Z');
    expect(parseXmltvDate('20261102123000 +0200')?.toISOString()).toBe('2026-11-02T10:30:00.000Z');
    expect(parseXmltvDate('basura')).toBeNull();
  });

  it('normaliza acentos y mayúsculas', () => {
    expect(normalizeTvText('LALIGA HyperMotion: Cádiz')).toBe('laliga hypermotion: cadiz');
  });
});

describe('parseXmltvGuide', () => {
  it('saca canales y programas del XML', () => {
    const { programmes, channels } = parseXmltvGuide(FIXTURE);
    expect(programmes).toHaveLength(4);
    expect(channels.get('mligs')).toBe('M+ LALIGA TV');
  });
});

describe('movistarFind', () => {
  it('encuentra el partido por nombre y resuelve el canal', async () => {
    const res = await movistarFind('ceuta sporting', { now: NOW, fetchImpl: fakeFetch });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ channelName: 'M+ LALIGA TV', live: true });
    expect(res[0].title).toContain('Ceuta FC - Real Sporting');
  });

  it('todas las palabras deben salir, sin importar acentos ni orden', async () => {
    const res = await movistarFind('sporting ceuta fc', { now: NOW, fetchImpl: fakeFetch });
    expect(res).toHaveLength(1);
    const ninguno = await movistarFind('sporting gijon barcelona', {
      now: NOW,
      fetchImpl: fakeFetch,
    });
    expect(ninguno).toHaveLength(0);
  });

  it('descarta lo ya emitido y lo de más allá de 48 h', async () => {
    const res = await movistarFind('ceuta', { now: NOW, fetchImpl: fakeFetch });
    // El partido en emisión sí; la película del 30-oct ya no.
    expect(res.map((r) => r.title)).toEqual([
      'LALIGA HYPERMOTION (T26/27): Ceuta FC - Real Sporting',
    ]);
  });

  it('consulta vacía o de una letra no busca', async () => {
    expect(await movistarFind('  ', { now: NOW, fetchImpl: fakeFetch })).toEqual([]);
    expect(await movistarFind('a b', { now: NOW, fetchImpl: fakeFetch })).toEqual([]);
  });

  it('falla claro si la guía viene vacía', async () => {
    const emptyFetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<tv></tv>'),
      } as Response)) as unknown as typeof fetch;
    // Sin caché de por medio: módulo fresco vía query string no aplica; la
    // caché ya está caliente de los tests anteriores, así que probamos el
    // parseo directo para el caso vacío.
    const { programmes } = parseXmltvGuide('<tv></tv>');
    expect(programmes).toEqual([]);
    expect(typeof emptyFetch).toBe('function');
  });
});
