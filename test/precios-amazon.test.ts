import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  esBloqueoAmazon,
  type ItemListado,
  parseFicha,
  parseListado,
} from '../src/precios/amazon.js';
import { preciosAccion } from '../src/precios/comando.js';
import { codigoFicha, configPrecios, conRespaldo, leerFichaNavegador } from '../src/precios/red.js';
import {
  candidato,
  descarteListado,
  esAccesorio,
  mejorReferencia,
  verificar,
} from '../src/precios/regla.js';
import { categoriasDesde, textoEstado, VigilantePrecios } from '../src/precios/vigilante.js';

// Muestras reales recortadas (amazon.es, 6-nov-2026); ver la cabecera de cada fichero.
const fx = (n: string) => readFileSync(join('test', 'fixtures', 'amazon', n), 'utf8');

// Forma real de un resultado de búsqueda con tachado (copiada de busqueda-robot-aspirador.html).
const resultado = (asin: string, titulo: string, precio: string, tachado?: string) =>
  `<div role="listitem" data-asin="${asin}" data-component-type="s-search-result" class="sg-col-4-of-24">` +
  `<h2 aria-label="${titulo}" class="a-size-base-plus"><span>${titulo}</span></h2>` +
  `<a class="a-link-normal" href="/x/dp/${asin}/"><span class="a-price" data-a-size="xl" data-a-color="base"><span class="a-offscreen">${precio}</span><span aria-hidden="true">x</span></span></a>` +
  (tachado
    ? `<div class="a-section aok-inline-block"><span class="a-size-base a-color-secondary">Recomendado: <span class="a-price a-text-price" data-a-size="b" data-a-strike="true" data-a-color="secondary"><span class="a-offscreen">${tachado}</span><span aria-hidden="true">x</span></span></span></div>`
    : '') +
  '</div>';

// La ficha real (Chromium) con otro precio y el «Precio más bajo reciente» de Amazon.
function fichaCon(entero: string, dec: string, masBajo?: string, vendedor?: string): string {
  let h = fx('ficha-dreo-navegador.html')
    .replace('a-price-whole">41', `a-price-whole">${entero}`)
    .replace('a-price-fraction">31', `a-price-fraction">${dec}`);
  if (masBajo) {
    const marca = `a-price-fraction">${dec}</span>`;
    h = h.replace(
      marca,
      `${marca}<span class="a-size-small">Precio más bajo reciente: <span class="a-price a-text-price apex-basisprice-value" data-a-strike="true"><span class="a-offscreen">${masBajo}</span></span></span>`,
    );
  }
  if (vendedor)
    h = h.replace(
      /Remitente \/ Vendedor/g,
      `Envío desde: ${vendedor} Vendido por: ${vendedor} Detalles`,
    );
  return h;
}

const item = (p: Partial<ItemListado>): ItemListado => ({
  asin: 'B0TEST0001',
  titulo: 'Cecotec Robot Aspirador Conga 2290 Ultra',
  cents: 2290,
  refCents: 22900,
  refTipo: 'recomendado',
  patrocinado: false,
  desde: false,
  porUnidad: false,
  ...p,
});

describe('Amazon.es: lectura de páginas reales', () => {
  it('búsqueda: el tachado de un carrusel de OTRO producto no se pega al resultado', () => {
    const items = parseListado(fx('busqueda-robot-aspirador.html'));
    expect(items.map((i) => i.asin)).toEqual([
      'B0HJMV4V5H',
      'B0H642J8RN',
      'B0HJMX5SSW',
      'B0HJMVCMXL',
    ]);
    const r = items.find((i) => i.asin === 'B0HJMVCMXL');
    expect(r?.cents).toBe(879);
    // Dentro va un anuncio de otro robot a 106,61 € «Recomendado: 205,79 €»: no es suyo.
    expect(r?.refCents).toBeNull();
    expect(items.find((i) => i.asin === 'B0HJMX5SSW')?.cents).toBe(709);
  });

  it('búsqueda: lee precio y «Recomendado» del propio resultado', () => {
    const [it] = parseListado(
      resultado('B0TEST0001', 'Cecotec Conga 2290', '22,90\u00a0€', '229,00\u00a0€'),
    );
    expect(it).toMatchObject({
      asin: 'B0TEST0001',
      cents: 2290,
      refCents: 22900,
      refTipo: 'recomendado',
    });
  });

  it('más vendidos: precio de la rejilla y «desde» marcado', () => {
    const items = parseListado(fx('mas-vendidos-cocina.html'));
    expect(items[0]).toMatchObject({ asin: 'B0C9D4KL9D', cents: 4131, desde: false });
    expect(items[0]?.titulo).toMatch(/^Dreo Calefactor/);
    expect(items.length).toBe(5);
  });

  it('ficha con navegador real: precio, stock, vendedor y estado', () => {
    expect(parseFicha(fx('ficha-dreo-navegador.html'))).toMatchObject({
      cents: 4131,
      precioOculto: false,
      enStock: true,
      vendedor: 'Amazon',
      envio: 'Amazon',
      estado: 'nuevo',
    });
  });

  it('ficha pedida sin navegador: Amazon oculta el precio y eso no es un precio', () => {
    const f = parseFicha(fx('ficha-precio-oculto.html'));
    expect(f.precioOculto).toBe(true);
    expect(f.cents).toBeNull();
  });

  it('ficha: «Precio más bajo reciente» de la oferta principal', () => {
    const f = parseFicha(fichaCon('9', '99', '89,99\u00a0€'));
    expect(f).toMatchObject({ cents: 999, refCents: 8999, refTipo: 'mas-bajo-reciente' });
  });

  it('captcha (503 real de amazon.es) se reconoce como bloqueo', () => {
    expect(esBloqueoAmazon(503, fx('captcha-503.html'))).toBe(true);
    expect(esBloqueoAmazon(200, fx('captcha-503.html'))).toBe(true);
    expect(esBloqueoAmazon(200, fx('mas-vendidos-cocina.html'))).toBe(false);
  });
});

describe('regla del error de precio', () => {
  it('producto nuevo sin historial: el tachado basta para ir a verificar', () => {
    expect(candidato(item({}), [])?.cents).toBe(22900);
    expect(candidato(item({ cents: 9000 }), [])).toBeNull(); // 39 %: no llega
  });

  it('historial propio: mediana con 3 lecturas en más de un día; se usa la referencia más baja', () => {
    const d = 24 * 3600 * 1000;
    const l = [
      { at: 0, cents: 15000 },
      { at: d / 2, cents: 16000 },
      { at: d + 1, cents: 15500 },
    ];
    expect(mejorReferencia(l, { cents: 22900, tipo: 'recomendado' }, null)).toEqual({
      cents: 15500,
      fuente: 'historial',
    });
    expect(mejorReferencia(l.slice(0, 2), { cents: null, tipo: null }, null)).toBeNull();
  });

  it('falsos positivos: recambio, «desde», precio por unidad, reacondicionado', () => {
    expect(
      descarteListado(item({ titulo: 'Kit de recambios compatible con Cecotec Conga 4090' })),
    ).toMatch(/recambio/);
    expect(
      descarteListado(item({ titulo: 'Cepillos laterales para Conga 3090, pack de 6' })),
    ).toMatch(/recambio/);
    expect(descarteListado(item({ desde: true }))).toMatch(/desde/);
    expect(descarteListado(item({ porUnidad: true }))).toMatch(/unidad/);
    expect(descarteListado(item({ titulo: 'Conga 2290 (Reacondicionado)' }))).toMatch(
      /reacondicionado/,
    );
    expect(esAccesorio('Aspiradora sin cable Rowenta X-Force')).toBe(false);
    expect(esAccesorio('Robot aspirador con mopa y base de vaciado')).toBe(false);
  });

  it('verificación: vendido por Amazon y mismo precio en la ficha → aviso', () => {
    const v = verificar(
      item({ cents: 999, refCents: null, refTipo: null }),
      parseFicha(fichaCon('9', '99', '89,99\u00a0€')),
      [],
    );
    expect(v).toMatchObject({
      ok: true,
      cents: 999,
      ref: { cents: 8999, fuente: 'mas-bajo-reciente' },
    });
  });

  it('verificación: el «Recomendado» de un vendedor externo no vale como referencia', () => {
    const v = verificar(
      item({ cents: 999, refCents: 8999 }),
      parseFicha(fichaCon('9', '99', undefined, 'ChinaShopES')),
      [],
    );
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.motivo).toMatch(/ChinaShopES/);
  });

  it('verificación: precio oculto, distinto del listado o agotado → no avisa', () => {
    expect(verificar(item({ cents: 999 }), parseFicha(fx('ficha-precio-oculto.html')), []).ok).toBe(
      false,
    );
    expect(verificar(item({ cents: 999 }), parseFicha(fichaCon('41', '31')), [])).toMatchObject({
      ok: false,
      motivo: expect.stringMatching(/no coinciden/),
    });
    const agotado = fichaCon('9', '99', '89,99\u00a0€').replace('En stock', 'No disponible.');
    expect(verificar(item({ cents: 999 }), parseFicha(agotado), [])).toMatchObject({
      ok: false,
      motivo: 'agotado',
    });
  });
});

describe('vigilante: barrido, aviso, duplicados y captcha', () => {
  const listado =
    resultado('B0TEST0001', 'Dreo Calefactor cerámico 1500W', '9,99\u00a0€', '89,99\u00a0€') +
    resultado('B0TEST0002', 'Otro', '30,00\u00a0€');
  const mk = (
    leerListado: (u: string) => Promise<{ status: number; html: string }>,
    avisos: string[],
    pedidas: string[],
  ) =>
    new VigilantePrecios({
      archivo: join(mkdtempSync(join(tmpdir(), 'precios-')), 'precios-amazon.json'),
      categorias: categoriasDesde('cocina').categorias,
      leerListado: async (u) => {
        pedidas.push(u);
        return leerListado(u);
      },
      leerFicha: async (u) => {
        pedidas.push(u);
        return { status: 200, html: fichaCon('9', '99', '89,99\u00a0€') };
      },
      avisar: async (t) => void avisos.push(t),
      esperar: async () => undefined,
      paginas: 2,
      now: () => 1_800_000_000_000,
    });

  it('avisa una vez con producto, precio, referencia, motivo y enlace; no repite', async () => {
    const avisos: string[] = [];
    const pedidas: string[] = [];
    const v = mk(async () => ({ status: 200, html: listado }), avisos, pedidas);
    const r = await v.barrer();
    expect(r).toMatchObject({ paginas: 2, candidatos: 1, avisos: 1 });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('Dreo Calefactor');
    expect(avisos[0]).toContain('9,99 €');
    expect(avisos[0]).toContain('89,99 €');
    expect(avisos[0]).toContain('−89 %');
    expect(avisos[0]).toContain('precio más bajo reciente');
    expect(avisos[0]).toContain('https://www.amazon.es/dp/B0TEST0001');
    await v.barrer();
    expect(avisos).toHaveLength(1);
  });

  it('captcha: para en seco, no abre más páginas y /precios lo explica', async () => {
    const pedidas: string[] = [];
    const v = mk(async () => ({ status: 503, html: fx('captcha-503.html') }), [], pedidas);
    await v.barrer();
    expect(pedidas).toHaveLength(1);
    expect(await v.barrer()).toBeNull(); // sigue en pausa
    expect(pedidas).toHaveLength(1);
    const txt = textoEstado(v.leer(), {
      activo: true,
      categorias: categoriasDesde('cocina').categorias,
      cadaMin: 30,
      now: 1_800_000_000_000,
      ratio: 0.3,
      tz: 'Europe/Madrid',
    });
    expect(txt).toContain('captcha');
    expect(txt).toContain('Hogar y cocina');
    expect(txt).toMatch(/0 páginas/);
  });

  it('categorías configurables: ids, enlaces y lo que no entiende', () => {
    const r = categoriasDesde(
      'cocina, Informática, https://www.amazon.es/s?k=robot+aspirador, foo',
    );
    expect(r.categorias.map((c) => c.id)).toEqual([
      'cocina',
      'informatica',
      'https://www.amazon.es/s?k=robot+aspirador',
    ]);
    expect(r.desconocidas).toEqual(['foo']);
    expect(categoriasDesde('').categorias.length).toBe(10);
  });
});

describe('lectura en el Chrome de Asistenta y configuración', () => {
  it('la ficha se recorta en la página y vuelve en trozos hasta completar el HTML', async () => {
    const html = fx('ficha-dreo-navegador.html');
    const codigos: string[] = [];
    const nav = {
      execJs: async (_scope: string, code: string) => {
        codigos.push(code);
        const m = code.includes('state.preciosFicha ||')
          ? /slice\((\d+), (\d+)\)/.exec(code)
          : null;
        return { text: m ? html.slice(Number(m[1]), Number(m[2])) : String(html.length) };
      },
    };
    const r = await leerFichaNavegador(
      nav,
      'telegram:dm:1#precios',
    )('https://www.amazon.es/dp/B0C9D4KL9D');
    expect(r.html).toBe(html);
    expect(parseFicha(r.html).cents).toBe(4131);
    expect(codigos[0]).toContain('validateCaptcha');
    expect(codigoFicha('https://www.amazon.es/dp/B0C9D4KL9D')).toContain(
      '"https://www.amazon.es/dp/B0C9D4KL9D"',
    );
    await expect(
      leerFichaNavegador(nav, 's')('https://evil.example/dp/B0C9D4KL9D'),
    ).rejects.toThrow();
  });

  it('sin navegador (Chrome cerrado) cae a la petición normal', async () => {
    const leer = conRespaldo(
      async () => {
        throw new Error('no hay Chrome');
      },
      async () => ({ status: 200, html: 'respaldo' }),
    );
    expect((await leer('https://www.amazon.es/dp/B0C9D4KL9D')).html).toBe('respaldo');
  });

  it('.env: encendido por defecto, umbral en % de descuento, límites sensatos', () => {
    expect(configPrecios({})).toMatchObject({ activo: true, cadaMin: 30, ratio: 0.3, paginas: 6 });
    expect(configPrecios({ PA_PRECIOS: '0' })).toMatchObject({ activo: false });
    expect(configPrecios({ PA_PRECIOS_UMBRAL: '80', PA_PRECIOS_CADA_MIN: '1' })).toMatchObject({
      ratio: 0.2,
      cadaMin: 15,
    });
  });

  it('/precios on|off|ahora', () => {
    expect(preciosAccion('on')).toBe('on');
    expect(preciosAccion('Apágalo')).toBe('off');
    expect(preciosAccion('ahora')).toBe('ahora');
    expect(preciosAccion('')).toBe('estado');
  });

  it('el daemon programa el barrido y /precios está en la ayuda y en el menú', () => {
    const cli = readFileSync(join('src', 'cli.ts'), 'utf8');
    expect(cli).toContain("names: ['precios']");
    expect(cli).toContain('preciosConf.cadaMin * 60_000');
    expect(readFileSync(join('src', 'channels', 'telegram-help.ts'), 'utf8')).toContain(
      "command: 'precios'",
    );
    expect(readFileSync(join('src', 'channels', 'telegram-commands.ts'), 'utf8')).toContain(
      "command: 'precios'",
    );
  });
});
