/**
 * «pon en YouTube X» sin pasar por el modelo (asis-computeruse-2). Antes iba
 * al modelo (2 vueltas, 4–8 s) y en la tele solo podía abrir la app de
 * YouTube, sin buscar nada. Ahora, con una tele configurada y sin nombrar el
 * PC, va al momento por la receta directa de búsqueda de YouTube.
 */
import { describe, expect, it } from 'vitest';
import { tvFastPathIntent } from '../src/tv/fast-path.js';

const now = 1_000_000;
const base = { now, lastTvOrderAt: null };

describe('atajo sin modelo: «pon en YouTube X»', () => {
  it('con una tele configurada va directo a la tele', () => {
    expect(
      tvFastPathIntent({
        ...base,
        text: 'pon en YouTube Bailando de Enrique Iglesias',
        hasTv: true,
      }),
    ).toEqual({
      action: 'search',
      text: 'bailando de enrique iglesias',
      appId: 'youtube.leanback.v4',
    });
    expect(
      tvFastPathIntent({ ...base, text: 'Ponme el tráiler de Dune en Netflix', hasTv: true }),
    ).toEqual({ action: 'search', text: 'dune', appId: 'netflix' });
  });

  it('sin tele configurada, o nombrando el PC, sigue al modelo', () => {
    expect(tvFastPathIntent({ ...base, text: 'pon en YouTube Bailando' })).toBeNull();
    expect(
      tvFastPathIntent({ ...base, text: 'pon en YouTube Bailando en el ordenador', hasTv: true }),
    ).toBeNull();
    expect(
      tvFastPathIntent({ ...base, text: 'pon en YouTube Bailando a las 9', hasTv: true }),
    ).toBeNull();
  });

  it('«busca X en YouTube» sin más puede ser del navegador: al modelo; con «tele», a la tele', () => {
    expect(
      tvFastPathIntent({ ...base, text: 'busca Bailando en YouTube', hasTv: true }),
    ).toBeNull();
    expect(
      tvFastPathIntent({ ...base, text: 'busca Bailando en YouTube en la tele', hasTv: true })
        ?.action,
    ).toBe('search');
    // Navegando la tele (orden hace menos de 3 min), también.
    expect(
      tvFastPathIntent({
        ...base,
        text: 'busca Bailando en YouTube',
        lastTvOrderAt: now - 30_000,
      })?.action,
    ).toBe('search');
  });

  it('lo de siempre no cambia: «pon youtube» sin contexto sigue al modelo', () => {
    expect(tvFastPathIntent({ ...base, text: 'pon youtube', hasTv: true })).toBeNull();
    expect(tvFastPathIntent({ ...base, text: 'baja el volumen de la tele', hasTv: true })).toEqual({
      action: 'volumeStep',
      steps: -3,
    });
  });
});
