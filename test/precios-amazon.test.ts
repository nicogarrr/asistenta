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
import {
  codigoFicha,
  codigoListado,
  configPrecios,
  conRespaldo,
  leerFichaNavegador,
  leerListadoNavegador,
} from '../src/precios/red.js';
import {
  candidato,
  descarteListado,
  esAccesorio,
  mejorReferencia,
  verificar,
} from '../src/precios/regla.js';
import {
  CATEGORIAS_POR_DEFECTO,
  categoriasDesde,
  RAPIDAS_POR_DEFECTO,
  rapidasDesde,
  textoEstado,
  VigilantePrecios,
} from '../src/precios/vigilante.js';

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
    botones: unknown[] = [],
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
      avisar: async (t, b) => {
        avisos.push(t);
        botones.push(b);
      },
      esperar: async () => undefined,
      paginas: 2,
      now: () => 1_800_000_000_000,
    });

  it('el aviso dice «ERROR DE PRECIO» y lleva botones de compra directa y de la ficha', async () => {
    const avisos: string[] = [];
    const botones: unknown[] = [];
    const v = mk(async () => ({ status: 200, html: listado }), avisos, [], botones);
    await v.barrer();
    expect(avisos[0]?.split('\n')[0]).toBe('🚨 ERROR DE PRECIO');
    expect(avisos[0]).toContain(
      'https://www.amazon.es/gp/aws/cart/add.html?ASIN.1=B0TEST0001&Quantity.1=1',
    );
    expect(avisos[0]).toMatch(/Por qué: .*precio más bajo reciente/);
    expect(botones[0]).toEqual([
      {
        label: '🛒 Comprar ya',
        action: 'url:https://www.amazon.es/gp/aws/cart/add.html?ASIN.1=B0TEST0001&Quantity.1=1',
      },
      { label: '🔗 Ver en Amazon', action: 'url:https://www.amazon.es/dp/B0TEST0001' },
    ]);
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
    expect(categoriasDesde('').categorias.length).toBe(12);
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

describe('listados en el Chrome de Asistenta (menos captchas)', () => {
  it('el listado recortado en la página (atributos en otro orden) se lee igual', async () => {
    // Lo que deja el recorte del navegador: data-asin antes que role, sin el resto de atributos.
    const recortado = fx('busqueda-robot-aspirador.html').replace(
      /<div role="listitem" data-asin="([A-Z0-9]{10})"[^>]*>/g,
      '<div data-asin="$1" role="listitem">',
    );
    const nav = {
      execJs: async (_s: string, code: string) => {
        const m = code.includes('state.preciosPagina ||')
          ? /slice\((\d+), (\d+)\)/.exec(code)
          : null;
        return { text: m ? recortado.slice(Number(m[1]), Number(m[2])) : String(recortado.length) };
      },
    };
    const r = await leerListadoNavegador(nav, 's')('https://www.amazon.es/s?k=robot+aspirador');
    const items = parseListado(r.html);
    expect(items.map((i) => i.asin)).toEqual([
      'B0HJMV4V5H',
      'B0H642J8RN',
      'B0HJMX5SSW',
      'B0HJMVCMXL',
    ]);
    expect(items.find((i) => i.asin === 'B0HJMVCMXL')).toMatchObject({
      cents: 879,
      refCents: null,
    });
    expect(codigoListado('https://www.amazon.es/gp/bestsellers/kitchen/')).toContain(
      'gridItemRoot',
    );
  });

  it('si el Chrome falla, usa la petición normal y no lo reintenta en 6 h', async () => {
    let t = 0;
    let intentos = 0;
    const leer = conRespaldo(
      async () => {
        intentos++;
        throw new Error('no hay Chrome');
      },
      async () => ({ status: 200, html: 'http' }),
      { now: () => t },
    );
    await leer('https://www.amazon.es/x');
    await leer('https://www.amazon.es/x');
    expect(intentos).toBe(1);
    expect(leer.fallo()?.motivo).toBe('no hay Chrome');
    t = 7 * 3600_000;
    await leer('https://www.amazon.es/x');
    expect(intentos).toBe(2);
  });

  it('un precio «desde» no entra en el historial', async () => {
    const html = resultado('B0TEST0003', 'Producto', '10,00\u00a0€').replace(
      '<span class="a-price"',
      'Más opciones de compra desde <span class="a-price"',
    );
    expect(parseListado(html)[0]?.desde).toBe(true);
    const v = new VigilantePrecios({
      archivo: join(mkdtempSync(join(tmpdir(), 'precios-')), 'p.json'),
      categorias: categoriasDesde('cocina').categorias,
      leerListado: async () => ({ status: 200, html }),
      leerFicha: async () => ({ status: 200, html: '' }),
      avisar: async () => undefined,
      esperar: async () => undefined,
      paginas: 1,
    });
    await v.barrer();
    expect(v.leer().asins.B0TEST0003).toBeUndefined();
  });
});

// Los dos hallazgos reales de Quique (@Letscookvlc, 6-nov-2026, ~09:00), los dos vendidos por
// Amazon.es: la plancha ghd Gold a 29,90 € (normal ~250 €) y el Chivas Regal Mizunara a
// 12,50 € (normal ~69 €). Con el vigilante antiguo ninguno se habría visto sin pasar el enlace.
function fichaDe(o: {
  titulo: string;
  entero: string;
  dec: string;
  tachado?: string;
  etiqueta?: string;
  vendedor?: string;
}): string {
  const marca = `a-price-fraction">${o.dec}</span>`;
  let h = fx('ficha-dreo-navegador.html')
    .replace(/(<span id="productTitle"[^>]*>)[\s\S]*?(<\/span>)/, `$1 ${o.titulo} $2`)
    .replace('a-price-whole">41', `a-price-whole">${o.entero}`)
    .replace('a-price-fraction">31', marca);
  if (o.tachado) {
    h = h.replace(
      marca,
      `${marca}<span class="a-size-small">${o.etiqueta ?? 'Recomendado:'} <span class="a-price a-text-price apex-basisprice-value" data-a-strike="true"><span class="a-offscreen">${o.tachado}</span></span></span>`,
    );
  }
  const v = o.vendedor ?? 'Amazon.es';
  return h.replace(/Remitente \/ Vendedor/g, `Envío desde: ${v} Vendido por: ${v} Detalles`);
}

describe('casos reales de Quique: ghd Gold y Chivas Regal Mizunara', () => {
  const GHD = 'B0QUIQUE01';
  const CHIVAS = 'B0QUIQUE02';
  const LISTADO =
    resultado(
      GHD,
      'ghd Gold Professional Plancha de pelo profesional',
      '29,90\u00a0€',
      '249,00\u00a0€',
    ) +
    resultado(CHIVAS, 'Chivas Regal Mizunara Blended Scotch Whisky 70 cl', '12,50\u00a0€') +
    resultado(
      'B0LOOKALK1',
      'Placas de repuesto compatibles con ghd Gold',
      '9,99\u00a0€',
      '249,00\u00a0€',
    ) +
    resultado(
      'B0LOOKALK2',
      'ghd Gold plancha de pelo (vendedor externo)',
      '24,90\u00a0€',
      '249,00\u00a0€',
    );
  const FICHAS: Record<string, string> = {
    [GHD]: fichaDe({
      titulo: 'ghd Gold Professional Plancha de pelo',
      entero: '29',
      dec: '90',
      tachado: '249,00\u00a0€',
    }),
    [CHIVAS]: fichaDe({
      titulo: 'Chivas Regal Mizunara Blended Scotch Whisky 70 cl',
      entero: '12',
      dec: '50',
    }),
    B0LOOKALK1: fichaDe({
      titulo: 'Placas de repuesto compatibles con ghd Gold',
      entero: '9',
      dec: '99',
      tachado: '249,00\u00a0€',
    }),
    B0LOOKALK2: fichaDe({
      titulo: 'ghd Gold plancha de pelo',
      entero: '24',
      dec: '90',
      tachado: '249,00\u00a0€',
      vendedor: 'BeautyOutletES',
    }),
  };

  it('avisan el ghd (con su «Recomendado» de Amazon.es) y el Chivas (con su historial); los parecidos no', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'precios-quique-'));
    const archivo = join(dir, 'precios-amazon.json');
    // El Chivas ya se había visto a su precio normal (69 €) varias veces en dos días.
    const d = 24 * 3600_000;
    const now = 1_800_000_000_000;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      archivo,
      JSON.stringify({
        asins: {
          [CHIVAS]: {
            t: 'Chivas Regal Mizunara',
            l: [
              [now - 2 * d, 6900],
              [now - d, 6890],
              [now - d / 2, 6950],
            ],
          },
        },
      }),
    );
    const avisos: string[] = [];
    const v = new VigilantePrecios({
      archivo,
      categorias: [],
      rapidas: rapidasDesde('ghd|beauty, whisky|grocery'),
      leerListado: async () => ({ status: 200, html: LISTADO }),
      leerFicha: async (u) => ({ status: 200, html: FICHAS[u.slice(-10)] ?? '' }),
      avisar: async (t) => void avisos.push(t),
      esperar: async () => undefined,
      now: () => now,
      fichas: 5,
    });
    const r = await v.barrer({ rapido: true });
    expect(r?.avisos).toBe(2);
    const ghd = avisos.find((a) => a.includes('ghd Gold')) ?? '';
    expect(ghd).toContain('29,90 €');
    expect(ghd).toContain('249,00 €');
    expect(ghd).toContain('−88 %');
    expect(ghd).toContain(`https://www.amazon.es/dp/${GHD}`);
    const chivas = avisos.find((a) => a.includes('Chivas')) ?? '';
    expect(chivas).toContain('12,50 €');
    expect(chivas).toMatch(/antes 69,\d\d €/);
    expect(chivas).toContain('mediana de lo que he visto antes');
    // El recambio ni se abre; el del vendedor externo se descarta al verificar.
    expect(avisos.some((a) => a.includes('repuesto'))).toBe(false);
    const pend = v.leer().pendientes;
    expect(pend.find((p) => p.asin === 'B0LOOKALK2')?.motivo).toMatch(/BeautyOutletES/);
    expect(pend.some((p) => p.asin === 'B0LOOKALK1')).toBe(false);
  });

  it('las búsquedas rápidas por defecto cubren pelo (ghd, Dyson, planchas) y licores (whisky, ginebra, ron)', () => {
    const urls = rapidasDesde(undefined)
      .flatMap((c) => c.urls)
      .join(' ');
    for (const q of [
      'k=ghd',
      'k=dyson',
      'k=plancha+de+pelo',
      'k=whisky',
      'k=ginebra+premium',
      'i=grocery',
    ]) {
      expect(urls).toContain(q);
    }
    expect(rapidasDesde('no')).toEqual([]);
    expect(configPrecios({})).toMatchObject({ rapidoMin: 12, paginasRapido: 4 });
    expect(configPrecios({ PA_PRECIOS_RAPIDO_MIN: '0' }).rapidoMin).toBe(0);
    expect(categoriasDesde('licores').categorias[0]?.nombre).toBe('Bebidas y licores');
  });
});

describe('precios: qué barre (Nico, 6-nov-2026: relojes e informática sí, LEGO no)', () => {
  const textos = RAPIDAS_POR_DEFECTO.map((r) => r.split('|')[0]?.toLowerCase());
  it('el barrido rápido ya no busca LEGO', () => {
    expect(textos.some((t) => t?.includes('lego'))).toBe(false);
  });
  it('busca relojes inteligentes de las marcas grandes', () => {
    for (const m of [
      'apple watch',
      'galaxy watch',
      'garmin',
      'amazfit',
      'huawei watch',
      'pixel watch',
    ])
      expect(textos.some((t) => t?.includes(m))).toBe(true);
  });
  it('busca sobre todo informática, y sigue con belleza y licores', () => {
    for (const m of [
      'portátil gaming',
      'macbook',
      'monitor',
      'ssd',
      'rtx',
      'ryzen',
      'intel',
      'ipad',
      'tablet',
      'sony',
      'bose',
      'airpods',
      'iphone',
      'galaxy s',
      'router mesh',
      'ghd',
      'whisky',
    ])
      expect(textos.some((t) => t?.includes(m))).toBe(true);
  });
  it('busca RAM y componentes de marca (Nico, 11:18: «Ram también»)', () => {
    for (const m of [
      'ddr5',
      'ddr4',
      'corsair',
      'kingston fury',
      'g.skill',
      'crucial',
      'placa base',
      'fuente de alimentación',
      'aio',
      'caja pc',
      'nas',
      'logitech',
      'razer',
    ])
      expect(textos.some((t) => t?.includes(m))).toBe(true);
  });
  it('el barrido de 30 min incluye «relojes inteligentes» (por búsqueda) e «informática»', () => {
    expect(CATEGORIAS_POR_DEFECTO).toEqual(expect.arrayContaining(['relojes', 'informatica']));
    const [r] = categoriasDesde('relojes').categorias;
    expect(r?.nombre).toBe('Relojes inteligentes');
    expect(r?.urls).toContain('https://www.amazon.es/s?k=reloj+inteligente&i=electronics');
  });
});
