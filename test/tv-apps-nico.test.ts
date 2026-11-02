/**
 * Apps de la tele de Nico (LG C5 rooteada): los nombres que el dice («pon
 * Movistar», «abre Nuvio») resuelven a los ids REALES de su tele, verificados
 * contra listApps (2026-10-25). Sin estos alias, launch probaba un id que no
 * existe o dependia del titulo instalado.
 */
import { describe, expect, it } from 'vitest';
import { APP_NAMES, needsAppLookup, resolveAppId } from '../src/tv/apps.js';

const CASOS: Array<[string, string]> = [
  ['Movistar', 'com.telefonica.app.nux'],
  ['Movistar Plus+', 'com.telefonica.app.nux'],
  ['movistar plus', 'com.telefonica.app.nux'],
  ['Nuvio', 'space.nuvio.webos'],
  ['Nuvio TV', 'space.nuvio.webos'],
  ['IBO Player', 'iboplayer.lg'],
  ['IBO Player Pro', 'iboplayer.lg'],
  ['Moonlight', 'com.limelight.webos'],
  ['Asistenta', 'com.tvweb.dashboard'],
  ['YouTube AdFree', 'org.webosbrew.youtube.adfree'],
];

describe('alias de apps de la tele de Nico', () => {
  for (const [dicho, id] of CASOS) {
    it(`«${dicho}» -> ${id}`, () => {
      const r = resolveAppId(dicho, null);
      expect(r.id).toBe(id);
      expect(r.how).toBe('alias');
    });
  }

  it('los nombres nuevos no piden consulta a la tele', () => {
    for (const [dicho] of CASOS) {
      expect(needsAppLookup(dicho)).toBe(false);
    }
  });

  it('cada id nuevo tiene nombre para ensenar a la persona', () => {
    for (const id of new Set(CASOS.map(([, id]) => id))) {
      expect(APP_NAMES[id], `APP_NAMES[${id}]`).toBeTruthy();
    }
  });

  it('en una tele con Movistar con OTRO id instalado, gana el titulo instalado', () => {
    const installed = [{ id: 'es.movistarplus.app', title: 'Movistar Plus+' }];
    const r = resolveAppId('movistar', installed);
    expect(r.id).toBe('es.movistarplus.app');
    expect(r.how).toBe('title');
  });

  it('los alias genericos de siempre siguen intactos', () => {
    expect(resolveAppId('Netflix', null).id).toBe('netflix');
    expect(resolveAppId('YouTube', null).id).toBe('youtube.leanback.v4');
    expect(resolveAppId('Disney+', null).id).toBe('com.disney.disneyplus-prod');
  });
});
