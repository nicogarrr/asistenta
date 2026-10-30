import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { batteryRunnerFromEnv, modelKeyName } from '../src/evolve/run.js';

// El evaluador por defecto recibe la clave del modelo leída del almacén real, en memoria:
// nunca a disco, nunca en la salida, y solo esa clave. Modelo y red siempre simulados.

const SENTINEL = 'sk-centinela-7f3a9c';
const CASE = { id: 'k1', prompt: 'hola', machine: {} };

/** Ficheros (recursivo) cuyo contenido contiene la clave. */
function filesWith(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) hits.push(...filesWith(p, needle));
    else if (e.isFile() && statSync(p).size < 50_000_000 && readFileSync(p).includes(needle))
      hits.push(p);
  }
  return hits;
}

/** Una copia falsa del código medido: su evaluador cuenta qué variables secretas le llegan. */
function fakeCopy(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pa-battery-key-'));
  mkdirSync(join(cwd, 'scripts'));
  writeFileSync(
    join(cwd, 'scripts', 'evolve-battery-case.mjs'),
    `import { createHash } from 'node:crypto';
const h = (v) => (v ? createHash('sha256').update(v).digest('hex') : null);
const names = Object.keys(process.env).filter((k) => /SECRET|KEY|TOKEN|PASS/i.test(k)).sort();
const k = process.env.PA_SECRET_PROVIDER_APIKEY ?? process.env.PA_SECRET_PROVIDER_OPENROUTERKEY ?? null;
const reply = JSON.stringify({ names, ok: h(k) === ${JSON.stringify(createHash('sha256').update(SENTINEL).digest('hex'))}, manual: k === 'sk-manual', model: process.env.PA_MODEL ?? null });
process.stdout.write(JSON.stringify({ reply, toolCalls: [], approvalsAsked: 0 }) + '\\n');
`,
  );
  return cwd;
}

function deps(baseUrl: string, asked: string[], fail = false) {
  return {
    baseUrl: () => baseUrl,
    readSecret: async (k: string) => {
      asked.push(k);
      if (fail) throw new Error('almacén bloqueado');
      return k.startsWith('provider:') ? SENTINEL : 'otro-secreto';
    },
  };
}

const OTHER_SECRETS = {
  PATH: process.env.PATH,
  PA_SECRET_TELEGRAM_BOTTOKEN: 'tg-token',
  OPENROUTER_API_KEY: 'or-key',
  PA_SECRETS_FILE: '/no/existe.json',
  PA_MODEL: 'modelo-1',
};

describe('clave del modelo para el evaluador de la batería', () => {
  it('lee del almacén real SOLO la clave del modelo y se la pasa al hijo por entorno', async () => {
    const asked: string[] = [];
    const cwd = fakeCopy();
    const run = batteryRunnerFromEnv(OTHER_SECRETS, deps('https://opencode.ai/zen/v1', asked));
    const out = JSON.parse((await run?.(CASE, cwd))?.reply ?? '{}');
    expect(asked).toEqual(['provider:apiKey']);
    expect(out.names).toEqual(['PA_SECRET_PROVIDER_APIKEY']);
    expect(out.ok).toBe(true);
    expect(out.model).toBe('modelo-1');
    expect(filesWith(cwd, SENTINEL)).toEqual([]);
  });

  it('PA_SECRET_PROVIDER_APIKEY definida a mano gana y no se lee el almacén', async () => {
    const asked: string[] = [];
    const run = batteryRunnerFromEnv(
      { ...OTHER_SECRETS, PA_SECRET_PROVIDER_APIKEY: 'sk-manual' },
      deps('https://opencode.ai/zen/v1', asked),
    );
    const out = JSON.parse((await run?.(CASE, fakeCopy()))?.reply ?? '{}');
    expect(asked).toEqual([]);
    expect(out.manual).toBe(true);
  });

  it('OpenRouter usa su propia clave; un endpoint propio no recibe ninguna del almacén', async () => {
    const asked: string[] = [];
    const or = batteryRunnerFromEnv(OTHER_SECRETS, deps('https://openrouter.ai/api/v1', asked));
    const a = JSON.parse((await or?.(CASE, fakeCopy()))?.reply ?? '{}');
    expect(asked).toEqual(['provider:openrouterKey']);
    expect(a.names).toEqual(['PA_SECRET_PROVIDER_OPENROUTERKEY']);
    asked.length = 0;
    const own = batteryRunnerFromEnv(OTHER_SECRETS, deps('http://127.0.0.1:8080/v1', asked));
    const b = JSON.parse((await own?.(CASE, fakeCopy()))?.reply ?? '{}');
    expect(asked).toEqual([]);
    expect(b.names).toEqual([]);
    expect(modelKeyName('https://generativelanguage.googleapis.com/v1beta')).toBe(
      'provider:geminiKey',
    );
  });

  it('si el almacén no se puede leer, el caso corre igual sin clave', async () => {
    const asked: string[] = [];
    const run = batteryRunnerFromEnv(
      OTHER_SECRETS,
      deps('https://opencode.ai/zen/v1', asked, true),
    );
    const out = JSON.parse((await run?.(CASE, fakeCopy()))?.reply ?? '{}');
    expect(asked).toEqual(['provider:apiKey']);
    expect(out.names).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'un evaluador propio (PA_EVOLVE_BATTERY) no recibe la clave',
    async () => {
      const asked: string[] = [];
      const cwd = fakeCopy();
      const own = join(cwd, 'own.mjs');
      writeFileSync(
        own,
        `#!${process.execPath}\n${readFileSync(join(cwd, 'scripts', 'evolve-battery-case.mjs'), 'utf8')}`,
      );
      chmodSync(own, 0o755);
      const run = batteryRunnerFromEnv(
        { ...OTHER_SECRETS, PA_EVOLVE_BATTERY: own },
        deps('https://opencode.ai/zen/v1', asked),
      );
      const out = JSON.parse((await run?.(CASE, cwd))?.reply ?? '{}');
      expect(asked).toEqual([]);
      expect(out.names).toEqual([]);
    },
  );
});

// Precarga de prueba para el script real: la red es falsa (apunta si la clave llegó al
// modelo) y, justo antes de borrar su carpeta temporal, se mira si la clave está en algún
// fichero de ella. Solo escribe booleanos y rutas, nunca la clave.
const PRELOAD = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const K = process.env.PA_SECRET_PROVIDER_APIKEY;
const rep = { fetchCalls: 0, sawKey: false, scanned: 0, hits: [] };
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name);
  if (e.isDirectory()) walk(p); else if (e.isFile()) { rep.scanned++; if (fs.readFileSync(p).includes(K)) rep.hits.push(p); } } };
globalThis.fetch = async (input, init) => {
  rep.fetchCalls++;
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (K && [...h.values()].some((v) => v.includes(K))) rep.sawKey = true;
  return new Response('{"error":{"message":"simulado"}}', { status: 401, headers: { 'content-type': 'application/json' } });
};
const rm = fs.rmSync;
fs.rmSync = (p, o) => { try { walk(String(p)); } catch {} return rm(p, o); };
syncBuiltinESMExports();
process.on('exit', () => fs.writeFileSync(process.env.TEST_KEY_REPORT, JSON.stringify(rep)));
`;

describe('el script real del evaluador con la clave en el entorno', () => {
  it('la clave llega al modelo (simulado) pero no toca el disco ni la salida', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pa-battery-real-'));
    const tmp = join(root, 'tmp');
    mkdirSync(tmp);
    const preload = join(root, 'preload.mjs');
    writeFileSync(preload, PRELOAD);
    const report = join(root, 'report.json');
    const script = join(process.cwd(), 'scripts', 'evolve-battery-case.mjs');
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, script], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        PA_BATTERY_CASE: JSON.stringify(CASE),
        PA_SECRET_PROVIDER_APIKEY: SENTINEL,
        TEST_KEY_REPORT: report,
      },
    });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
    });
    child.stderr.on('data', (d) => {
      output += d;
    });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    const rep = JSON.parse(readFileSync(report, 'utf8'));
    expect(rep.fetchCalls).toBeGreaterThan(0);
    expect(rep.sawKey).toBe(true);
    expect(rep.scanned).toBeGreaterThan(0);
    expect(rep.hits).toEqual([]);
    expect(output).not.toContain(SENTINEL);
    expect(filesWith(tmp, SENTINEL)).toEqual([]);
    expect(code === 0 || code === 1).toBe(true);
  }, 150_000);
});
