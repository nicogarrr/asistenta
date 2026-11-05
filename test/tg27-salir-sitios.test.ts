import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  crearLlegada,
  createLlegadaTool,
  guardarSitio,
  LlegadaStore,
  llegadaFiredText,
  llegadaIntent,
} from '../src/llegada.js';
import { guardarSitioIntent, sitioKey } from '../src/sitios.js';

/** Avisos al SALIR («cuando salga de casa…») y sitios guardados por nombre («el gimnasio»). */
const CASA = { latitude: 43.5357, longitude: -5.6615 }; // Gijón
const GYM = { latitude: 43.5401, longitude: -5.6489 }; // ~1,1 km de casa
const LEJOS = { latitude: 43.3614, longitude: -5.8494 }; // Oviedo
const dirs: string[] = [];
let now = 1_000;
const deps = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-tg27-'));
  dirs.push(dir);
  return {
    store: new LlegadaStore(join(dir, 'avisos-llegada.json'), () => now),
    home: () => CASA,
    geocode: async (p: string) =>
      /oviedo/i.test(p) ? { ...LEJOS, label: 'Oviedo, Asturias' } : null,
  };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  now = 1_000;
});

describe('frases de salida y de sitio guardado', () => {
  it.each([
    ['cuando salga de casa recuérdame coger las llaves', 'casa', 'coger las llaves'],
    ['al salir del gimnasio avísame de estirar', 'el gimnasio', 'estirar'],
    ['recuérdame el paraguas cuando me vaya de casa', 'casa', 'el paraguas'],
  ])('salir: %s', (text, place, what) => {
    expect(llegadaIntent(text)).toEqual({ place, text: what, modo: 'salir' });
  });
  it.each([
    ['cuando llegue al gimnasio recuérdame pesarme', 'el gimnasio', 'pesarme'],
    ['recuérdame llamar a Ana cuando llegue a la oficina', 'la oficina', 'llamar a Ana'],
  ])('llegar a un sitio: %s', (text, place, what) => {
    expect(llegadaIntent(text)).toEqual({ place, text: what });
  });
  it.each([
    ['guarda esto como el gimnasio', 'el gimnasio', false],
    ['Guarda donde estoy como «la oficina»', 'la oficina', true],
    ['apunta esta ubicación como casa de mis padres.', 'casa de mis padres', true],
  ])('guardar: %s', (text, name, explicito) => {
    expect(guardarSitioIntent(text)).toEqual({ name, explicito });
  });
  it.each(['guarda esto en mis documentos', 'cuando salga te llamo', 'guarda esto'])(
    'no: %s',
    (text) => {
      expect(guardarSitioIntent(text)).toBeNull();
      expect(llegadaIntent(text)).toBeNull();
    },
  );
  it('el nombre se compara sin artículo ni tildes', () => {
    expect(sitioKey('El Gimnasio')).toBe(sitioKey('gimnasio'));
    expect(sitioKey('la Oficína')).toBe('oficina');
  });
});

describe('avisar al salir', () => {
  it('salta al salir tras haberle visto dentro, una vez, y se borra', async () => {
    const d = deps();
    const reply = await crearLlegada(d, '7', 'casa', 'coger las llaves', 'salir');
    expect(reply).toContain('cuando salgas de casa te recuerdo «coger las llaves»');
    // Pedido estando fuera: aún no salta.
    expect(d.store.position('7', LEJOS)).toEqual([]);
    // Llega a casa (se arma) y sale: ahora sí.
    expect(d.store.position('7', CASA)).toEqual([]);
    const fired = d.store.position('7', LEJOS);
    expect(fired.map(llegadaFiredText)).toEqual(['🚪 Sales de casa: coger las llaves']);
    expect(d.store.list('7')).toEqual([]);
  });
});

describe('sitios guardados', () => {
  it('«guarda esto como el gimnasio» usa la última ubicación; luego sirve para llegar y salir', async () => {
    const d = deps();
    // Sin ubicación reciente: «esto» puede ser otra cosa → lo decide el modelo.
    expect(guardarSitio(d.store, '7', { name: 'el gimnasio', explicito: false })).toBeNull();
    expect(guardarSitio(d.store, '7', { name: 'el gimnasio', explicito: true })).toContain(
      'Mándame primero la ubicación',
    );
    d.store.position('7', GYM);
    expect(guardarSitio(d.store, '7', { name: 'el gimnasio', explicito: false })).toContain(
      '«cuando llegue al gimnasio recuérdame…» o «cuando salga del gimnasio…»',
    );
    expect(await crearLlegada(d, '7', 'gimnasio', 'pesarme')).toContain(
      'cuando llegues al gimnasio te recuerdo «pesarme»',
    );
    expect(d.store.list('7')[0]).toMatchObject({ latitude: GYM.latitude, radiusM: 200 });
    d.store.position('7', CASA);
    const fired = d.store.position('7', GYM);
    expect(fired.map(llegadaFiredText)).toEqual(['📍 Has llegado al gimnasio: pesarme']);
    // Otro chat no ve el sitio.
    expect(d.store.sitio('8', 'el gimnasio')).toBeNull();
  });

  it('una ubicación vieja no vale y un sitio sin guardar no se busca como ciudad', async () => {
    const d = deps();
    d.store.position('7', GYM);
    now += 31 * 60_000;
    expect(guardarSitio(d.store, '7', { name: 'el gimnasio', explicito: true })).toContain(
      'Mándame primero',
    );
    let searched = false;
    const reply = await crearLlegada(
      {
        ...d,
        geocode: async () => {
          searched = true;
          return LEJOS;
        },
      },
      '7',
      'la oficina',
      'x',
    );
    expect(searched).toBe(false);
    expect(reply).toContain('No tengo guardado «la oficina»');
  });

  it('un «casa» guardado vale aunque no haya PA_BRIEFING_LAT', async () => {
    const d = { ...deps(), home: () => null };
    d.store.position('7', CASA);
    guardarSitio(d.store, '7', { name: 'casa', explicito: true });
    expect(await crearLlegada(d, '7', 'casa', 'regar')).toContain('cuando llegues a casa');
  });

  it('la herramienta guarda, crea al salir, lista y borra sitios', async () => {
    const d = deps();
    const tool = createLlegadaTool(d, () => '7');
    const run = async (args: Parameters<typeof tool.execute>[1]) =>
      ((await tool.execute('i', args)).content[0] as { text: string }).text;
    d.store.position('7', GYM);
    expect(await run({ accion: 'guardar_sitio', lugar: 'el gimnasio' })).toContain('Guardado');
    expect(
      await run({ accion: 'crear', lugar: 'el gimnasio', texto: 'la toalla', modo: 'salir' }),
    ).toContain('cuando salgas del gimnasio');
    expect(await run({ accion: 'ver' })).toBe(
      '1. Al salir del gimnasio: la toalla\nSitios guardados: el gimnasio',
    );
    expect(await run({ accion: 'borrar_sitio', lugar: 'gimnasio' })).toBe(
      'Sitio «gimnasio» borrado.',
    );
  });
});
