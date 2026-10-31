import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import {
  formatOverview,
  forScope,
  fromPageWatches,
  fromRoutines,
  fromTriggers,
} from '../src/watch/overview.js';
import { collectWatches, vigilanciasCommand } from '../src/watch/overview-cli.js';
import { PageWatchStore } from '../src/watch/pages.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pa-overview-'));
  dirs.push(d);
  return d;
}

describe('vista única de vigilancias: lectores puros', () => {
  it('sin nada que vigilar lo dice claro', () => {
    expect(formatOverview([], NOW)).toBe('No hay ninguna vigilancia activa.');
  });

  it('una página con objetivo de precio cuenta como «precio»; sin él, «pagina»', () => {
    const base = {
      scope: 'tg:1',
      lastValue: '',
      failures: 0,
      createdAt: NOW,
      active: true,
      keyword: '',
      dropPct: null,
      lastAlertAt: 0,
      lastAlertCents: null,
      mutedUntil: 0,
    };
    const e = fromPageWatches([
      {
        ...base,
        id: 'a',
        url: 'https://x.es/p',
        label: 'Tele',
        lastCheckedAt: NOW - 3_600_000,
        targetCents: 45_000,
      },
      { ...base, id: 'b', url: 'https://y.es', label: '', lastCheckedAt: 0, targetCents: null },
    ]);
    expect(e.map((x) => x.kind)).toEqual(['precio', 'pagina']);
    expect(e[0]?.detail).toContain('450,00 €');
    expect(e[1]?.label).toBe('https://y.es');
    expect(e[1]?.lastRunMs).toBeUndefined();
    const txt = formatOverview(e, NOW);
    expect(txt).toContain('Vigilancias: 2 (2 activas)');
    expect(txt).toContain('hace 1 h');
    expect(txt).toContain('aún no se ha ejecutado');
  });

  it('solo las rutinas con cron aparecen; las pausadas se marcan', () => {
    const r = (over: object) => ({
      id: 'r',
      scope: 'tg:1',
      name: 'resumen',
      kind: 'schedule' as const,
      params: null,
      steps: null,
      prompt: 'x',
      schedule: '0 8 * * *',
      enabled: true,
      createdAt: '',
      updatedAt: '',
      lastRunAt: null,
      ...over,
    });
    const e = fromRoutines([
      r({}),
      r({ id: 'p', kind: 'procedure', schedule: null }),
      r({ id: 'z', enabled: false }),
    ]);
    expect(e.map((x) => x.id)).toEqual(['r', 'z']);
    const txt = formatOverview(e, NOW);
    expect(txt).toContain('1 en pausa');
    expect(txt).toContain('[en pausa]');
  });

  it('una fecha ISO rota en last_fired_at no inventa una hora', () => {
    const [t] = fromTriggers([
      {
        id: 't',
        scope: '',
        routine: 'descargas',
        event: 'archivo',
        match: 'factura',
        args: null,
        enabled: true,
        cooldownSeconds: 300,
        lastFiredAt: 'nunca',
        createdAt: '',
      },
    ]);
    expect(t?.lastRunMs).toBeUndefined();
    expect(t?.detail).toBe('si contiene «factura»');
  });

  it('forScope deja las del chat y las globales', () => {
    const mk = (scope: string) => ({
      kind: 'rutina' as const,
      id: scope,
      label: scope,
      target: '',
      scope,
      enabled: true,
    });
    expect(forScope([mk('a'), mk('b'), mk('')], 'a').map((e) => e.id)).toEqual(['a', '']);
    expect(forScope([mk('a'), mk('b')]).length).toBe(2);
  });
});

describe('pa vigilancias: lee las bases reales sin modificar nada', () => {
  it('junta páginas (memory.db) y rutinas (agent.db); un pricewatch.json viejo se ignora', async () => {
    const dir = tmp();
    const mem = new DatabaseSync(join(dir, 'memory.db'));
    new PageWatchStore(mem).add('tg:1', 'https://tienda.es/tv', 'Tele salón');
    mem.close();
    const agentDb = join(dir, 'agent.db');
    const store = new Store(agentDb);
    store.close();
    // El vigilante de precios automático se quitó: su fichero, si quedó, no se lista.
    writeFileSync(
      join(dir, 'pricewatch.json'),
      JSON.stringify({ products: [{ name: 'ps5', urls: { amazon: 'B0CL5KNB9M' } }] }),
    );
    const src = { stateDir: dir, agentDb };
    const { entries, errors } = collectWatches(src);
    expect(errors).toEqual([]);
    expect(
      entries
        .filter((e) => e.kind !== 'ojo')
        .map((e) => e.kind)
        .sort(),
    ).toEqual(['pagina']);
    let out = '';
    expect(
      await vigilanciasCommand([], src, (s) => {
        out += s;
      }),
    ).toBe(0);
    expect(out).toContain('Tele salón');
    expect(out).not.toContain('ps5');
  });

  it('un pricewatch.json roto que quedó de antes no da error', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'pricewatch.json'), '{roto');
    const src = { stateDir: dir, agentDb: join(dir, 'no-existe.db') };
    expect(collectWatches(src)).toEqual({ entries: [], errors: [] });
    let out = '';
    expect(
      await vigilanciasCommand(['--json'], src, (s) => {
        out += s;
      }),
    ).toBe(0);
    expect(JSON.parse(out).errors.length).toBe(0);
  });

  it('sin estado no crea ficheros nuevos', () => {
    const dir = tmp();
    const src = { stateDir: dir, agentDb: join(dir, 'agent.db') };
    expect(collectWatches(src)).toEqual({ entries: [], errors: [] });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('argumento desconocido → uso y código 2', async () => {
    expect(await vigilanciasCommand(['--xyz'], { stateDir: tmp(), agentDb: 'x' }, () => {})).toBe(
      2,
    );
  });
});
