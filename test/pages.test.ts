import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  describeChange,
  describeWatch,
  eur,
  extractPrice,
  FAILURES_BEFORE_NOTICE,
  PageWatchStore,
  parseVigilaArgs,
  sparkline,
  storeForUrl,
  watchValue,
} from '../src/watch/pages.js';

const mk = () => {
  let t = 1_000;
  const store = new PageWatchStore(new DatabaseSync(':memory:'), () => t);
  return {
    store,
    tick: (ms: number) => {
      t += ms;
    },
  };
};

describe('extractPrice', () => {
  it('normalises Spanish and prefix formats', () => {
    expect(extractPrice('Ahora 49,90 € con envío')).toBe('49,90 €');
    expect(extractPrice('Precio: 1.299,5€')).toBe('1299,50 €');
    expect(extractPrice('Total € 20')).toBe('20,00 €');
    expect(extractPrice('sin precio aquí')).toBeNull();
  });
  it('falls back to a text hash that ignores whitespace and case', () => {
    expect(watchValue('Hola   Mundo')).toBe(watchValue(' hola mundo '));
    expect(watchValue('hola')).not.toBe(watchValue('adiós'));
  });
});

describe('PageWatchStore', () => {
  it('baselines, stays quiet, then reports a price drop once', async () => {
    const { store } = mk();
    const w = store.add('chat1', 'https://shop.example/p', 'Zapatillas');
    expect((await store.check(w, async () => 'Precio 80,00 €')).kind).toBe('baseline');
    const w2 = store.get(w.id) as typeof w;
    expect((await store.check(w2, async () => 'Precio 80,00 €')).kind).toBe('unchanged');
    const out = await store.check(store.get(w.id) as typeof w, async () => 'Precio 64,99 €');
    expect(out).toEqual({ kind: 'changed', from: '80,00 €', to: '64,99 €' });
    expect(describeChange(w, out)).toContain('80,00 € -> 64,99 €');
    // la referencia ya es la nueva: no vuelve a avisar
    expect((await store.check(store.get(w.id) as typeof w, async () => '64,99 €')).kind).toBe(
      'unchanged',
    );
  });

  it('a network error is not a change; it warns once at the threshold', async () => {
    const { store } = mk();
    const w = store.add('c', 'https://a.example/');
    await store.check(w, async () => '10 €');
    const notices: (string | null)[] = [];
    for (let i = 0; i < FAILURES_BEFORE_NOTICE + 2; i++) {
      const o = await store.check(store.get(w.id) as typeof w, async () => {
        throw new Error('timeout');
      });
      notices.push(describeChange(w, o));
    }
    expect(notices.filter(Boolean)).toHaveLength(1);
    expect(store.get(w.id)?.lastValue).toBe('10,00 €');
    // y al recuperarse, no es un cambio
    expect((await store.check(store.get(w.id) as typeof w, async () => '10 €')).kind).toBe(
      'unchanged',
    );
  });

  it('dedupes, caps, scopes and removes', () => {
    const { store } = mk();
    const a = store.add('c', 'https://a.example/');
    expect(store.add('c', 'https://a.example/').id).toBe(a.id);
    for (let i = 0; i < 9; i++) store.add('c', `https://x${i}.example/`);
    expect(() => store.add('c', 'https://more.example/')).toThrow(/10 páginas/);
    expect(store.list('otro')).toHaveLength(0);
    expect(store.remove('otro', a.id)).toBe(false);
    expect(store.remove('c', a.id)).toBe(true);
    expect(store.list('c')).toHaveLength(9);
  });

  it('due() returns only watches not checked within the interval', async () => {
    const { store, tick } = mk();
    const w = store.add('c', 'https://a.example/');
    await store.check(w, async () => '5 €');
    expect(store.due(60_000)).toHaveLength(0);
    tick(61_000);
    expect(store.due(60_000)).toHaveLength(1);
  });
});

describe('extractPrice con punto decimal y distintos formatos', () => {
  it.each([
    ['49.90 €', '49,90 €'],
    ['45.90 €', '45,90 €'],
    ['49.90€', '49,90 €'],
    ['€49.90', '49,90 €'],
    ['EUR 49.90', '49,90 €'],
    ['1.299,50 €', '1299,50 €'],
    ['1,299.50 €', '1299,50 €'],
    ['49,90 €', '49,90 €'],
    ['1.299 €', '1299,00 €'],
    ['49 €', '49,00 €'],
    ['12,5€', '12,50 €'],
    ['1,459 €', '1,459 €'],
    ['1.2345 €', null],
  ])('%s -> %s', (text, expected) => {
    expect(extractPrice(text)).toBe(expected);
  });

  it('un cambio 49.90 -> 45.90 se detecta (antes ambos eran 90,00 €)', () => {
    expect(extractPrice('Precio 49.90 €')).not.toBe(extractPrice('Precio 45.90 €'));
  });
});

describe('vigilar una palabra', () => {
  it('parsea palabra y nombre, con comillas tipográficas', () => {
    expect(parseVigilaArgs('https://a.es/p palabra=agotado Zapas')).toEqual({
      url: 'https://a.es/p',
      keyword: 'agotado',
      label: 'Zapas',
      targetCents: null,
      dropPct: null,
    });
    expect(parseVigilaArgs('https://a.es/p palabra=“sin stock”')).toMatchObject({
      keyword: 'sin stock',
      label: '',
    });
    expect(parseVigilaArgs('https://a.es/p Solo nombre')).toMatchObject({
      keyword: '',
      label: 'Solo nombre',
    });
    expect(parseVigilaArgs('  ')).toBeNull();
  });

  it('avisa cuando aparece y cuando desaparece, ignorando tildes y mayúsculas', async () => {
    const { store } = mk();
    const w = store.add('c', 'https://a.es/p', 'Entradas', 'Agotado');
    expect((await store.check(w, async () => 'Quedan plazas')).kind).toBe('baseline');
    const o1 = await store.check(store.get(w.id) as typeof w, async () => 'AGOTADO');
    expect(o1).toEqual({ kind: 'changed', from: 'ausente', to: 'presente' });
    expect(describeChange(w, o1)).toContain('Ahora aparece "Agotado"');
    const o2 = await store.check(store.get(w.id) as typeof w, async () => 'ya hay');
    expect(describeChange(w, o2)).toContain('Ya no veo');
    expect(watchValue('Sin  habitación', 'habitacion')).toBe('presente');
  });

  it('la misma URL con otra palabra es otra vigilancia, y la tabla antigua se migra', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE page_watches (id TEXT PRIMARY KEY, scope TEXT NOT NULL, url TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '', last_value TEXT NOT NULL DEFAULT '', last_checked_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`);
    const store = new PageWatchStore(db);
    const a = store.add('c', 'https://a.es/', '', '');
    const b = store.add('c', 'https://a.es/', '', 'agotado');
    expect(a.id).not.toBe(b.id);
    expect(store.list('c').map((w) => w.keyword)).toEqual(['', 'agotado']);
  });
});

describe('eur y storeForUrl', () => {
  it('formatea céntimos en español', () => {
    expect(eur(129950)).toBe('1.299,50 €');
    expect(eur(50000)).toBe('500,00 €');
    expect(eur(49)).toBe('0,49 €');
    expect(eur(5)).toBe('0,05 €');
  });

  it('reconoce las 7 tiendas y rechaza el resto', () => {
    expect(storeForUrl('https://www.amazon.es/dp/B0ABC12345')).toBe('amazon');
    expect(storeForUrl('https://www.mediamarkt.es/es/product/_x.html')).toBe('mediamarkt');
    expect(storeForUrl('https://www.pccomponentes.com/x')).toBe('pccomponentes');
    expect(storeForUrl('https://www.carrefour.es/x')).toBe('carrefour');
    expect(storeForUrl('https://www.elcorteingles.es/x')).toBe('elcorteingles');
    expect(storeForUrl('https://www.fnac.es/x')).toBe('fnac');
    expect(storeForUrl('https://www.worten.es/x')).toBe('worten');
    expect(storeForUrl('https://shop.example/p')).toBeNull();
    expect(storeForUrl('no-es-url')).toBeNull();
  });
});

const AMAZON_URL = 'https://www.amazon.es/dp/B0ABC12345';

/** Ficha mínima con JSON-LD + meta coherentes (consenso de dos fuentes). */
function ficha(price: string, availability = 'https://schema.org/InStock'): string {
  return `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"Tele","offers":{"@type":"Offer","priceCurrency":"EUR","price":"${price}","availability":"${availability}"}}</script>
<meta property="product:price:amount" content="${price}">
</head><body></body></html>`;
}

const noText = async (): Promise<string> => {
  throw new Error('la ruta estructurada no debe pedir texto plano');
};

describe('vigilancia estructurada de tiendas', () => {
  it('guarda histórico y avisa de cambios con el precio de la ficha', async () => {
    const { store } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele');
    const o1 = await store.check(w, noText, async () => ficha('1299.99'));
    expect(o1).toEqual({ kind: 'baseline', value: '1.299,99 €' });
    expect(store.get(w.id)?.lastValue).toBe('1.299,99 €');
    const o2 = await store.check(store.get(w.id) as typeof w, noText, async () => ficha('1299.99'));
    expect(o2.kind).toBe('unchanged');
    const o3 = await store.check(store.get(w.id) as typeof w, noText, async () => ficha('999.99'));
    expect(o3).toMatchObject({ kind: 'changed', from: '1.299,99 €', to: '999,99 €' });
    const msg = describeChange(store.get(w.id) as typeof w, o3);
    expect(msg).toContain('999,99 €');
    expect(msg).toContain('verificado con varias fuentes');
    expect(msg).toContain('en stock');
    expect(msg).not.toContain('primer precio');
    expect(store.readings(w.id).map((r) => r.cents)).toEqual([129999, 129999, 99999]);
  });

  it('objetivo: avisa al cruzar el umbral a la baja y no repite', async () => {
    const { store } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele', '', { targetCents: 100_000 });
    expect((await store.check(w, noText, async () => ficha('1299.99'))).kind).toBe('baseline');
    const o = await store.check(store.get(w.id) as typeof w, noText, async () => ficha('999.99'));
    expect(o).toMatchObject({ kind: 'target', cents: 99999, targetCents: 100_000 });
    expect(describeChange(store.get(w.id) as typeof w, o)).toContain('Objetivo conseguido');
    // Sigue por debajo: no vuelve a avisar de objetivo
    const o2 = await store.check(store.get(w.id) as typeof w, noText, async () => ficha('989.99'));
    expect(o2.kind).toBe('changed');
  });

  it('objetivo ya cumplido en la primera lectura también avisa', async () => {
    const { store } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele', '', { targetCents: 100_000 });
    const o = await store.check(w, noText, async () => ficha('999.99'));
    expect(o.kind).toBe('target');
  });

  it('bajada %: mediana del histórico, anti-repetición y mínimo nuevo', async () => {
    const { store, tick } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele', '', { dropPct: 15 });
    for (let i = 0; i < 3; i++) {
      await store.check(store.get(w.id) as typeof w, noText, async () => ficha('1000.00'));
      tick(7_200_000);
    }
    const o = await store.check(store.get(w.id) as typeof w, noText, async () => ficha('800.00'));
    expect(o).toMatchObject({
      kind: 'drop',
      cents: 80000,
      referenceCents: 100000,
      referenceKind: 'mediana',
      dropPct: 20,
    });
    expect(describeChange(store.get(w.id) as typeof w, o)).toContain('mediana');
    // Misma situación al rato: ya avisado, no repite
    const o2 = await store.check(store.get(w.id) as typeof w, noText, async () => ficha('800.00'));
    expect(o2.kind).toBe('unchanged');
    // Mínimo nuevo: sí vuelve a avisar aunque no haya pasado un día
    const o3 = await store.check(store.get(w.id) as typeof w, noText, async () => ficha('750.00'));
    expect(o3.kind).toBe('drop');
  });

  it('bajada % con una sola lectura previa usa la última y lo dice', async () => {
    const { store } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele', '', { dropPct: 10 });
    await store.check(w, noText, async () => ficha('1000.00'));
    const o = await store.check(store.get(w.id) as typeof w, noText, async () => ficha('850.00'));
    expect(o).toMatchObject({ kind: 'drop', referenceKind: 'ultima' });
    expect(describeChange(store.get(w.id) as typeof w, o)).toContain('última lectura');
  });

  it('fuentes que discrepan: no se guarda ni se avisa un precio inventado', async () => {
    const { store } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele');
    const mal = `<html><head>
<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","priceCurrency":"EUR","price":"100.00"}}</script>
<meta property="product:price:amount" content="120.00">
</head></html>`;
    const o = await store.check(w, noText, async () => mal);
    expect(o.kind).toBe('error');
    expect(o.kind === 'error' && o.message).toContain('no coinciden');
    expect(store.readings(w.id)).toHaveLength(0);
    expect(store.get(w.id)?.lastValue).toBe('');
  });

  it('captcha o bloqueo: fallo honesto, nunca un precio', async () => {
    const { store } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele');
    const o = await store.check(
      w,
      noText,
      async () => '<html>Introduce los caracteres que ves a continuación</html>',
    );
    expect(o.kind).toBe('error');
    expect(o.kind === 'error' && o.message).toContain('captcha');
    expect(store.readings(w.id)).toHaveLength(0);
  });

  it('sin precio claro en la ficha: fallo honesto', async () => {
    const { store } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele');
    const o = await store.check(w, noText, async () => '<html><body>Sin datos</body></html>');
    expect(o.kind).toBe('error');
    expect(o.kind === 'error' && o.message).toContain('no se pudo comprobar');
  });

  it('error de red en la ruta estructurada: cuenta como fallo sin cambiar referencia', async () => {
    const { store } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele');
    await store.check(w, noText, async () => ficha('999.99'));
    const o = await store.check(store.get(w.id) as typeof w, noText, async () => {
      throw new Error('timeout');
    });
    expect(o.kind).toBe('error');
    expect(store.get(w.id)?.lastValue).toBe('999,99 €');
    expect(store.readings(w.id)).toHaveLength(1);
  });

  it('las vigilancias con palabra siguen por la ruta de texto aunque sean de tienda', async () => {
    const { store } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele', 'agotado');
    const o = await store.check(w, async () => 'Quedan unidades');
    expect(o).toEqual({ kind: 'baseline', value: 'ausente' });
  });
});

describe('/precio: resumen del histórico', () => {
  it('min, mediana, máx, gráfica y avisos configurados', async () => {
    const { store, tick } = mk();
    const w = store.add('c', AMAZON_URL, 'Tele', '', { targetCents: 90_000, dropPct: 20 });
    for (const price of ['1000.00', '1200.00', '800.00', '1000.00']) {
      await store.check(store.get(w.id) as typeof w, noText, async () => ficha(price));
      tick(7_200_000);
    }
    const s = store.summary(w.id);
    expect(s).toMatchObject({
      readings: 4,
      minCents: 80000,
      medianCents: 100000,
      maxCents: 120000,
      lastCents: 100000,
      lastInStock: true,
    });
    expect(s?.sparkline).toHaveLength(4);
    const text = describeWatch(store.get(w.id) as typeof w, s);
    expect(text).toContain('Tele (id ');
    expect(text).toContain('Último: 1.000,00 €');
    expect(text).toContain('mín 800,00 €');
    expect(text).toContain('mediana 1.000,00 €');
    expect(text).toContain('máx 1.200,00 €');
    expect(text).toContain('en stock');
    expect(text).toContain('Objetivo: te aviso si baja de 900,00 €');
    expect(text).toContain('baja un 20 %');
  });

  it('sin lecturas aún: lo dice en vez de inventar', () => {
    const { store } = mk();
    const w = store.add('c', 'https://shop.example/p', 'Zapatillas');
    expect(store.summary(w.id)).toBeNull();
    expect(describeWatch(w, null)).toContain('Aún no tengo lecturas');
  });
});

describe('sparkline', () => {
  it('una barra por lectura, plana si no hay variación', () => {
    expect(sparkline([])).toBe('');
    expect(sparkline([100, 100, 100])).toHaveLength(3);
    expect(sparkline([100, 200])).toBe('▁█');
    expect(sparkline([100, 150, 200])).toBe('▁▅█');
  });
});

describe('objetivo y bajada al añadir o reconfigurar', () => {
  it('repetir /vigila con objetivo actualiza la misma vigilancia', () => {
    const { store } = mk();
    const a = store.add('c', AMAZON_URL, 'Tele');
    expect(a.targetCents).toBeNull();
    const b = store.add('c', AMAZON_URL, '', '', { targetCents: 50_000 });
    expect(b.id).toBe(a.id);
    expect(store.get(a.id)?.targetCents).toBe(50_000);
    const c = store.add('c', AMAZON_URL, '', '', { dropPct: 10 });
    expect(c.id).toBe(a.id);
    expect(store.get(a.id)?.dropPct).toBe(10);
    expect(store.get(a.id)?.targetCents).toBeNull();
  });

  it('la tabla antigua sin columnas nuevas se migra', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE page_watches (id TEXT PRIMARY KEY, scope TEXT NOT NULL, url TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '', last_value TEXT NOT NULL DEFAULT '', last_checked_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`);
    const store = new PageWatchStore(db);
    const w = store.add('c', AMAZON_URL, 'Tele', '', { targetCents: 50_000 });
    expect(w.targetCents).toBe(50_000);
    const o = await store.check(w, noText, async () => ficha('499.99'));
    expect(o.kind).toBe('target');
    expect(store.summary(w.id)?.readings).toBe(1);
  });
});

describe('parseVigilaArgs con objetivo y bajada', () => {
  it('parsea objetivo en euros y bajada en %', () => {
    expect(parseVigilaArgs('https://a.es/p objetivo=500€')).toEqual({
      url: 'https://a.es/p',
      keyword: '',
      label: '',
      targetCents: 50_000,
      dropPct: null,
    });
    expect(parseVigilaArgs('https://a.es/p baja=15% Tele')).toMatchObject({
      dropPct: 15,
      label: 'Tele',
    });
    expect(parseVigilaArgs('https://a.es/p objetivo=1.299,50€ baja=10')).toMatchObject({
      targetCents: 129_950,
      dropPct: 10,
    });
    expect(parseVigilaArgs('https://a.es/p objetivo=1299.50')).toMatchObject({
      targetCents: 129_950,
    });
    expect(parseVigilaArgs('https://a.es/p baja=7,5%')).toMatchObject({ dropPct: 7.5 });
  });

  it('objetivo o bajada incomprensibles: error claro, no se ignoran', () => {
    expect(() => parseVigilaArgs('https://a.es/p objetivo=barato')).toThrow(/objetivo/);
    expect(() => parseVigilaArgs('https://a.es/p baja=120%')).toThrow(/1 y 95/);
  });
});
