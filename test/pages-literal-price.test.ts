import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PageWatchStore, sameWatchValue, watchValue } from '../src/watch/pages.js';

// «1,459» es ambiguo (miles en inglés o decimales de combustible): se guarda tal cual.
// Lo que no debe pasar es que la forma del símbolo cuente como cambio de precio.
describe('vigilancia de páginas: precio ambiguo guardado literal', () => {
  it('la misma cifra con el símbolo escrito distinto es el mismo valor', () => {
    for (const t of ['Gasóleo 1,459€', 'Gasóleo 1,459 EUR', 'Gasóleo €1,459', 'Gasóleo € 1,459']) {
      expect(watchValue(t)).toBe('1,459 €');
    }
  });

  const mk = () => {
    const db = new DatabaseSync(':memory:');
    const store = new PageWatchStore(db, () => 1_000);
    const w = store.add('chat1', 'https://gasolinera.example/precios', 'Gasóleo');
    return { db, store, id: w.id };
  };

  it('la siguiente lectura no avisa si solo cambia cómo se escribe el euro', async () => {
    const { store, id } = mk();
    expect((await store.check(store.get(id) as never, async () => 'Gasóleo 1,459€')).kind).toBe(
      'baseline',
    );
    const o = await store.check(store.get(id) as never, async () => 'Gasóleo 1,459 EUR');
    expect(o.kind).toBe('unchanged');
  });

  it('un literal guardado por una versión anterior no da un falso cambio tras actualizar', async () => {
    const { db, store, id } = mk();
    db.prepare('UPDATE page_watches SET last_value = ? WHERE id = ?').run('1,459€', id);
    const o = await store.check(store.get(id) as never, async () => 'Gasóleo 1,459 €');
    expect(o.kind).toBe('unchanged');
    db.prepare('UPDATE page_watches SET last_value = ? WHERE id = ?').run('1,459 EUR', id);
    expect((await store.check(store.get(id) as never, async () => 'Gasóleo €1,459')).kind).toBe(
      'unchanged',
    );
  });

  it('un cambio real de cifra sí avisa', async () => {
    const { store, id } = mk();
    await store.check(store.get(id) as never, async () => 'Gasóleo 1,459 €');
    const o = await store.check(store.get(id) as never, async () => 'Gasóleo 1,529 €');
    expect(o).toMatchObject({ kind: 'changed', from: '1,459 €', to: '1,529 €' });
  });

  it('sameWatchValue no mezcla textos, palabras clave ni importes distintos', () => {
    expect(sameWatchValue('presente', 'ausente')).toBe(false);
    expect(sameWatchValue('texto:abc', 'texto:abd')).toBe(false);
    expect(sameWatchValue('1459,00 €', '1,459 €')).toBe(false);
    expect(sameWatchValue('19,99 €', '19,99 €')).toBe(true);
  });
});
