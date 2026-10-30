import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { initIgnoreStore } from '../src/ojo-ignore.js';
import { formatOverview, fromOjoRules } from '../src/watch/overview.js';
import { collectWatches, readOjoRules } from '../src/watch/overview-cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function addRule(
  db: DatabaseSync,
  key: string,
  kind: string,
  src: string,
  pattern: string,
  status: string,
) {
  db.prepare(
    'INSERT INTO vigilante_rules (class_key, kind, src, pattern, status, created_at) VALUES (?, ?, ?, ?, ?, 0)',
  ).run(key, kind, src, pattern, status);
}

describe('pa vigilancias: reglas «no avisar» del ojo', () => {
  it('base sin la tabla: ninguna regla', () => {
    const db = new DatabaseSync(':memory:');
    expect(readOjoRules(db)).toEqual([]);
    db.close();
  });

  it('salen en su propio grupo; las propuestas en pausa y sin «aún no se ha ejecutado»', () => {
    const txt = formatOverview(
      fromOjoRules([
        {
          id: 1,
          kind: 'correo',
          src: 'news@tienda.es',
          pattern: 'Ofertas de la semana',
          status: 'activa',
        },
        { id: 2, kind: 'cargo', src: '', pattern: 'Spotify', status: 'propuesta' },
      ]),
    );
    expect(txt).toContain('Ojo: «no avisar» (silencios) (2)');
    expect(txt).toContain('• Ofertas de la semana — correo de news@tienda.es');
    expect(txt).toContain('• Spotify — cargo (propuesta, sin confirmar) [en pausa]');
    expect(txt).not.toContain('aún no se ha ejecutado');
  });

  it('collectWatches las lee de memory.db sin modificar la base', () => {
    const state = mkdtempSync(join(tmpdir(), 'pa-ov-rules-'));
    dirs.push(state);
    const file = join(state, 'memory.db');
    const db = new DatabaseSync(file);
    initIgnoreStore(db);
    addRule(db, 'k1', 'correo', 'a@b.es', 'Boletín', 'activa');
    db.close();
    const before = new DatabaseSync(file);
    const changesBefore = (
      before.prepare('SELECT count(*) AS n FROM vigilante_rules').get() as { n: number }
    ).n;
    before.close();
    const { entries, errors } = collectWatches({
      stateDir: state,
      agentDb: join(state, 'agent.db'),
      priceConfig: join(state, 'pricewatch.json'),
    });
    expect(errors).toEqual([]);
    const rules = entries.filter((e) => e.kind === 'silencio');
    expect(rules.map((e) => [e.id, e.label, e.enabled])).toEqual([['silencio:1', 'Boletín', true]]);
    const after = new DatabaseSync(file);
    expect(
      (after.prepare('SELECT count(*) AS n FROM vigilante_rules').get() as { n: number }).n,
    ).toBe(changesBefore);
    after.close();
  });
});
