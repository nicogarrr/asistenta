import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompraStore, createCompraTool, recetaACompra } from '../src/compra.js';
import {
  cleanIngredient,
  ingredientBase,
  recetaItems,
  recetaUrl,
  recipeFromHtml,
  recipeFromText,
} from '../src/compra-receta.js';

let dir: string;
let store: CompraStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps11-receta-'));
  store = new CompraStore(join(dir, 'lista-compra.json'), 'telegram:1');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PAGE = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"WebPage","name":"x"},
 {"@type":["Recipe","NewsArticle"],"name":"Tortilla de patatas &amp; cebolla",
  "recipeIngredient":["1 kg de patatas","6 huevos","1 cebolla","Aceite de oliva virgen extra","Sal al gusto","<b>200 ml</b> de leche","6 huevos"]}
]}</script></head><body><h1>Tortilla</h1><p>Ingredientes</p></body></html>`;

const TEXTO = `Lentejas de la abuela

Ingredientes (4 personas):
- 300 g de lentejas
- 1 chorizo
- 2 zanahorias

Para el sofrito:
- 1 pimiento verde
- 2 dientes de ajo
- Agua
- Pimienta negra

Preparación
1. Poner las lentejas en remojo con 2 litros de agua.`;

describe('receta → lista de la compra (Muse)', () => {
  it('lee la ficha schema.org Recipe (con @graph, tipo en array y entidades)', () => {
    const r = recipeFromHtml(PAGE);
    expect(r?.title).toBe('Tortilla de patatas & cebolla');
    expect(r?.ingredients).toContain('1 kg de patatas');
    const items = recetaItems({ html: PAGE });
    expect(items.source).toBe('schema');
    expect(items.items).toEqual([
      '1 kg de patatas',
      '6 huevos',
      '1 cebolla',
      'Aceite de oliva virgen extra',
      '200 ml de leche',
    ]);
    expect(items.skipped).toEqual(['Sal']);
  });

  it('JSON-LD roto o sin Recipe → null', () => {
    expect(recipeFromHtml('<script type="application/ld+json">{roto</script>')).toBeNull();
    expect(
      recipeFromHtml('<script type="application/ld+json">{"@type":"Article"}</script>'),
    ).toBeNull();
  });

  it('texto pegado: de «Ingredientes» a «Preparación», con subgrupos, sin lo de casa', () => {
    const r = recetaItems({ text: TEXTO });
    expect(r.source).toBe('texto');
    expect(r.items).toEqual([
      '300 g de lentejas',
      '1 chorizo',
      '2 zanahorias',
      '1 pimiento verde',
      '2 dientes de ajo',
    ]);
    expect(r.skipped).toEqual(['Agua', 'Pimienta negra']);
    expect(r.items.join(' ')).not.toContain('remojo');
  });

  it('«Ingredientes: a, b y c» en una línea y lista sin título con viñetas', () => {
    expect(recipeFromText('Ingredientes: harina, levadura; azúcar').ingredients).toEqual([
      'harina',
      'levadura',
      'azúcar',
    ]);
    expect(recipeFromText('1. Batir los huevos\n2) Freír').ingredients).toEqual([]);
    expect(recipeFromText('• 2 huevos\n• 100 g de azúcar\nMezclar todo').ingredients).toEqual([
      '• 2 huevos',
      '• 100 g de azúcar',
    ]);
  });

  it('limpieza y base del ingrediente', () => {
    expect(cleanIngredient('  • 1 pizca de sal, al gusto')).toBe('1 pizca de sal');
    expect(cleanIngredient('Perejil (opcional)')).toBe('Perejil');
    expect(ingredientBase('2 cucharadas de sal')).toBe('sal');
    expect(ingredientBase('1 diente de ajo')).toBe('ajo');
    const long = cleanIngredient(
      '250 g de harina de trigo de fuerza, tamizada dos veces y reservada en un bol grande aparte',
    );
    expect(long).toBe('250 g de harina de trigo de fuerza');
    expect(recetaUrl('mira https://ejemplo.es/receta-tortilla).')).toBe(
      'https://ejemplo.es/receta-tortilla',
    );
  });

  it('/compra receta <enlace> descarga, apunta y dice lo ya apuntado y lo de casa', async () => {
    store.add(['6 huevos']);
    const urls: string[] = [];
    const view = await recetaACompra(store, 'https://recetas.example/tortilla', async (u) => {
      urls.push(u);
      return PAGE;
    });
    expect(urls).toEqual(['https://recetas.example/tortilla']);
    expect(view.text).toContain('«Tortilla de patatas & cebolla»: apunto 4 ingredientes');
    expect(view.text).toContain('Ya estaba: 6 huevos');
    expect(view.text).toContain('No apunto Sal');
    expect(store.list().map((i) => i.text)).toContain('1 kg de patatas');
    expect(view.buttons.length).toBeGreaterThan(0);
  });

  it('página que no abre o sin ingredientes → pide el texto, sin apuntar nada', async () => {
    const fail = await recetaACompra(store, 'https://x.example/r', async () => {
      throw new Error('403');
    });
    expect(fail.text).toContain('No pude abrir esa receta');
    const empty = await recetaACompra(store, 'https://x.example/r', async () => '<p>hola</p>');
    expect(empty.text).toContain('No encontré los ingredientes');
    expect(store.list()).toEqual([]);
    expect((await recetaACompra(store, '  ')).text).toContain('/compra receta https://');
  });

  it('texto con comas sin título también vale', async () => {
    await recetaACompra(store, 'harina, huevos y leche');
    expect(store.list().map((i) => i.text)).toEqual(['harina', 'huevos', 'leche']);
  });

  it('la herramienta compra con accion=receta (texto leído de una foto)', async () => {
    const tool = createCompraTool(store);
    const r = await tool.execute('t1', { accion: 'receta', receta: TEXTO }, undefined, undefined);
    expect(JSON.stringify(r.content)).toContain('apunto 5 ingredientes');
    expect(store.list()).toHaveLength(5);
  });
});
