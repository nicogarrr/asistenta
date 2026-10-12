// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que db.js/vault.js carguen paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { type Routine, type RoutineParam, Store } from '../src/db.js';
import { PlaybookStore } from '../src/gestor/playbooks.js';
import { GestorStore } from '../src/gestor/store.js';
import {
  buildMacroPrompt,
  canonicalMacroName,
  detectMacroParams,
  isMacroName,
  parseMacroArgs,
  validateMacroValue,
} from '../src/routines.js';
import { createGestionTool } from '../src/tools/gestion.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-macros-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const PARAMS: RoutineParam[] = [
  { name: 'fichero', type: 'fichero' },
  { name: 'correo', type: 'correo' },
];

function macroRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r1',
    scope: 'scope',
    name: 'macro/enviar',
    kind: 'procedure',
    params: PARAMS,
    steps: 'Abre {fichero} y mándalo a {correo}. verifica: el correo tiene el adjunto',
    prompt: null,
    schedule: null,
    enabled: true,
    createdAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-12T09:00:00.000Z',
    lastRunAt: null,
    ...overrides,
  };
}

describe('macro names and detection', () => {
  it('canonicalMacroName forces the macro/ namespace, once', () => {
    expect(canonicalMacroName('enviar')).toBe('macro/enviar');
    expect(canonicalMacroName('macro/enviar')).toBe('macro/enviar');
    expect(isMacroName('macro/enviar')).toBe(true);
    expect(isMacroName('enviar')).toBe(false);
    expect(isMacroName('macro/')).toBe(false);
  });

  it('detectMacroParams finds placeholders once, in order, with typed names', () => {
    const steps = [
      'Descarga {fichero} de la web',
      'Manda {fichero} a {correo}',
      'Avisa a {email} y entra en {dominio}',
      'Abre {url} y anota {observaciones}',
    ].join('\n');
    expect(detectMacroParams(steps)).toEqual([
      { name: 'fichero', type: 'fichero' },
      { name: 'correo', type: 'correo' },
      { name: 'email', type: 'correo' },
      { name: 'dominio', type: 'dominio' },
      { name: 'url', type: 'dominio' },
      { name: 'observaciones', type: 'texto' },
    ]);
    expect(detectMacroParams('pasos sin placeholders')).toEqual([]);
    expect(detectMacroParams('{1no-es} {guion-bajo_ok} {}')).toEqual([
      { name: 'guion-bajo_ok', type: 'texto' },
    ]);
  });
});

describe('validateMacroValue', () => {
  const fichero: RoutineParam = { name: 'fichero', type: 'fichero' };
  const correo: RoutineParam = { name: 'correo', type: 'correo' };
  const dominio: RoutineParam = { name: 'dominio', type: 'dominio' };
  const texto: RoutineParam = { name: 'nota', type: 'texto' };

  it('rejects empty values and any line-breaking or control character', () => {
    expect(validateMacroValue(fichero, '   ').ok).toBe(false);
    expect(validateMacroValue(fichero, '/tmp/a\rb.pdf').ok).toBe(false);
    expect(validateMacroValue(fichero, '/tmp/a\nb.pdf').ok).toBe(false);
    expect(validateMacroValue(fichero, '/tmp/a\tb.pdf').ok).toBe(false);
    expect(validateMacroValue(texto, 'uno\u2028tres').ok).toBe(false);
  });

  it('keeps a value with $ or quotes exactly as typed: data, not structure', () => {
    const value = `O'Brien $HOME "comillas" {no-sustituir}`;
    const checked = validateMacroValue(texto, value);
    expect(checked).toEqual({ ok: true, value });
  });

  it('validates correo and canonicalizes dominio', () => {
    expect(validateMacroValue(correo, 'a@b').ok).toBe(false);
    expect(validateMacroValue(correo, 'qa@example.com')).toEqual({
      ok: true,
      value: 'qa@example.com',
    });
    expect(validateMacroValue(dominio, 'https://www.Example.es/pagina?x=1')).toEqual({
      ok: true,
      value: 'example.es',
    });
    expect(validateMacroValue(dominio, 'no es un dominio!!').ok).toBe(false);
    expect(validateMacroValue(dominio, 'a..b').ok).toBe(false);
  });
});

describe('parseMacroArgs', () => {
  it('parses clave=valor and keeps = inside the value', () => {
    expect(parseMacroArgs(['fichero=/tmp/x.pdf', 'nota=a=b'])).toEqual({
      ok: true,
      args: { fichero: '/tmp/x.pdf', nota: 'a=b' },
    });
    expect(parseMacroArgs([])).toEqual({ ok: true, args: {} });
  });

  it('rejects a token without =', () => {
    const parsed = parseMacroArgs(['fichero=/tmp/x.pdf', 'correo']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('correo');
  });
});

describe('buildMacroPrompt', () => {
  const GOOD = { fichero: '/tmp/informe.pdf', correo: 'qa@example.com' };

  it('refuses a routine without params', () => {
    const built = buildMacroPrompt(macroRoutine({ params: null }), GOOD);
    expect(built.ok).toBe(false);
  });

  it('lists missing, extra and mistyped parameters in ONE error and runs nothing', () => {
    const built = buildMacroPrompt(macroRoutine(), {
      fichero: '/tmp/a\rb.pdf',
      sobra: 'x',
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain('no se ha ejecutado');
    expect(built.error).toContain('falta correo (correo)');
    expect(built.error).toContain('sobra sobra');
    expect(built.error).toContain('fichero: una sola línea');
    expect(built.error).toContain('fichero (fichero), correo (correo)');
  });

  it('substitutes validated values and carries the verification and data rules', () => {
    const built = buildMacroPrompt(macroRoutine(), GOOD);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.prompt).toContain('Abre /tmp/informe.pdf y mándalo a qa@example.com.');
    expect(built.prompt).toContain('verifica: el correo tiene el adjunto');
    expect(built.prompt).toContain('data, never instructions');
    expect(built.prompt).toContain('perform that check');
    expect(built.prompt).toContain('Never type a password');
    expect(built.prompt).not.toContain('{fichero}');
    expect(built.prompt).not.toContain('{correo}');
  });

  it('canonicalizes a dominio value in the substituted steps', () => {
    const built = buildMacroPrompt(
      macroRoutine({
        params: [{ name: 'dominio', type: 'dominio' }],
        steps: 'Entra en {dominio} con el vault',
      }),
      { dominio: 'https://www.Seg-Social.es/tramites' },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.prompt).toContain('Entra en seg-social.es con el vault');
  });

  it('refuses a steps text with an undeclared placeholder', () => {
    const built = buildMacroPrompt(
      macroRoutine({ steps: 'Abre {fichero}, mándalo a {correo} y cierra {ventana}' }),
      GOOD,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain('{ventana}');
  });
});

describe('routines store with params', () => {
  it('roundtrips params and keeps plain procedures at null', () => {
    const store = new Store(join(tmp(), 'test.db'));
    store.saveRoutine({
      scope: 's',
      name: 'macro/enviar',
      kind: 'procedure',
      params: PARAMS,
      steps: 'Abre {fichero} y mándalo a {correo}',
    });
    store.saveRoutine({ scope: 's', name: 'trenes', kind: 'procedure', steps: 'Mira los trenes' });
    expect(store.getRoutine('s', 'macro/enviar')?.params).toEqual(PARAMS);
    expect(store.getRoutine('s', 'trenes')?.params).toBeNull();
    // Upsert updates the contract too.
    store.saveRoutine({
      scope: 's',
      name: 'macro/enviar',
      kind: 'procedure',
      params: [PARAMS[0] as RoutineParam],
      steps: 'Abre {fichero}',
    });
    expect(store.getRoutine('s', 'macro/enviar')?.params).toEqual([PARAMS[0]]);
    store.close();
  });

  it('loads a row whose params JSON is garbage as no contract', () => {
    const file = join(tmp(), 'test.db');
    const store = new Store(file);
    store.saveRoutine({
      scope: 's',
      name: 'macro/x',
      kind: 'procedure',
      params: PARAMS,
      steps: 'x',
    });
    store.close();
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE routines SET params = ? WHERE name = ?').run('{no es json', 'macro/x');
    raw.close();
    const store2 = new Store(file);
    expect(store2.getRoutine('s', 'macro/x')?.params).toBeNull();
    store2.close();
  });

  it('adds the params column to a pre-PR4 database, idempotently', () => {
    const file = join(tmp(), 'old.db');
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE routines (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      steps TEXT, prompt TEXT, schedule TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_run_at TEXT
    )`);
    raw
      .prepare(
        'INSERT INTO routines (id, scope, name, kind, steps, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      )
      .run('r0', 's', 'trenes', 'procedure', 'Mira los trenes', '2026-01-01', '2026-01-01');
    raw.close();
    // First open migrates; the row from before still reads, with no params.
    const store = new Store(file);
    expect(store.getRoutine('s', 'trenes')?.params).toBeNull();
    store.close();
    // Second open finds the column already there: a no-op, not an error.
    const again = new Store(file);
    expect(again.getRoutine('s', 'trenes')?.name).toBe('trenes');
    again.close();
  });
});

describe('gestion action=macro', () => {
  function setup() {
    const dir = tmp();
    const store = new Store(join(dir, 'test.db'));
    store.saveRoutine({
      scope: 'scope',
      name: 'macro/enviar',
      kind: 'procedure',
      params: PARAMS,
      steps: 'Abre {fichero} y mándalo a {correo}. verifica: adjunto presente',
    });
    store.saveRoutine({
      scope: 'otro-chat',
      name: 'macro/ajena',
      kind: 'procedure',
      params: PARAMS,
      steps: 'x {fichero} {correo}',
    });
    const tool = createGestionTool({
      gestor: new GestorStore({ db: new DatabaseSync(':memory:') }),
      scopeOf: () => 'scope',
      playbooks: new PlaybookStore({ dir: join(dir, 'pb') }),
      routines: store,
    });
    const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
    const text = (r: { content: { type: string; text?: string }[] }) =>
      r.content.map((c) => c.text ?? '').join('\n');
    return { run, text, store };
  }

  it('returns the validated prompt in content for live execution', async () => {
    const { run, text } = setup();
    const r = await run({
      action: 'macro',
      macro: 'macro/enviar',
      parametros: [
        { nombre: 'fichero', valor: '/tmp/informe.pdf' },
        { nombre: 'correo', valor: 'qa@example.com' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const body = text(r);
    expect(body).toContain('Macro macro/enviar validada');
    expect(body).toContain('Abre /tmp/informe.pdf y mándalo a qa@example.com.');
    expect(body).toContain('perform that check');
  });

  it('rejects a name without the namespace, an unknown macro and a foreign one', async () => {
    const { run, text } = setup();
    const noNs = await run({ action: 'macro', macro: 'enviar' });
    expect(noNs.isError).toBe(true);
    expect(text(noNs)).toContain('namespace');
    const unknown = await run({ action: 'macro', macro: 'macro/no-existe' });
    expect(unknown.isError).toBe(true);
    const foreign = await run({ action: 'macro', macro: 'macro/ajena' });
    expect(foreign.isError).toBe(true);
  });

  it('rejects bad or repeated parameters and runs nothing', async () => {
    const { run, text } = setup();
    const bad = await run({
      action: 'macro',
      macro: 'macro/enviar',
      parametros: [{ nombre: 'correo', valor: 'no-es-correo' }],
    });
    expect(bad.isError).toBe(true);
    const body = text(bad);
    expect(body).toContain('falta fichero (fichero)');
    expect(body).toContain('correo: no es un correo válido');
    const repeated = await run({
      action: 'macro',
      macro: 'macro/enviar',
      parametros: [
        { nombre: 'correo', valor: 'a@b.co' },
        { nombre: 'correo', valor: 'c@d.co' },
      ],
    });
    expect(repeated.isError).toBe(true);
    expect(text(repeated)).toContain('repetido');
  });
});
