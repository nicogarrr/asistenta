// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PlaybookStore,
  canonicalPlaybookDomain,
  containsVaultValue,
  parsePlaybook,
  renderPlaybook,
} from '../src/gestor/playbooks.js';
import { GestorStore } from '../src/gestor/store.js';
import { siteKey } from '../src/gestor/login.js';
import { createGestionTool } from '../src/tools/gestion.js';
import { clearVaultCache, envSecretName, vaultSet } from '../src/vault.js';

const CANARY_PASS = 'CAN4RY-playbook-pass-sintetico';
const CANARY_USER = 'CAN4RY-playbook-user';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-playbooks-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
  clearVaultCache();
  delete process.env.PA_VAULT_BACKEND;
  delete process.env.PA_SECRETS_FILE;
  delete process.env.PA_SECRET_SITE_EXAMPLE_COM_PASSWORD;
});

async function seedVault(entries: Record<string, string>) {
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = join(tmp(), 'secrets.json');
  for (const [k, v] of Object.entries(entries)) await vaultSet(k, v);
}

function setup() {
  const dir = tmp();
  const playbooks = new PlaybookStore({ dir });
  const gestor = new GestorStore({ db: new DatabaseSync(':memory:') });
  const tool = createGestionTool({ gestor, scopeOf: () => 'scope', playbooks });
  const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
  const text = (r: { content: { type: string; text?: string }[] }) =>
    r.content.map((c) => c.text ?? '').join('\n');
  return { dir, playbooks, gestor, run, text };
}

const base = {
  action: 'preparar' as const,
  titulo: 'Vida laboral',
  encargo: 'descárgame la vida laboral',
  pasos: [{ texto: 'Entrar y descargar el PDF', efecto: 'lee' }],
};

describe('canonicalPlaybookDomain', () => {
  it('www., URL y puerto canonicalizan al mismo dominio; basura se rechaza', () => {
    expect(canonicalPlaybookDomain('seg-social.es')).toBe('seg-social.es');
    expect(canonicalPlaybookDomain('www.seg-social.es')).toBe('seg-social.es');
    expect(canonicalPlaybookDomain('https://seg-social.es/login?x=1')).toBe('seg-social.es');
    expect(canonicalPlaybookDomain('seg-social.es:8443')).toBe('seg-social.es');
    // Sin host representable -> null: nunca un playbook huérfano ni un nombre inseguro.
    expect(canonicalPlaybookDomain('')).toBeNull();
    expect(canonicalPlaybookDomain('bad..name')).toBeNull();
    expect(canonicalPlaybookDomain('../../etc')).toBeNull();
    // Una ruta URL se queda en su host (misma convención que login.ts): el
    // fichero siempre es <host>.md bajo el dir, nunca una ruta anidada.
    expect(canonicalPlaybookDomain('foo/bar')).toBe('foo');
  });
});

describe('PlaybookStore', () => {
  it('guarda y lee en round-trip; las variantes del dominio dan al mismo fichero', async () => {
    const { playbooks, dir } = setup();
    playbooks.save({
      domain: canonicalPlaybookDomain('https://www.seg-social.es/login') ?? '',
      updatedAt: '2026-10-12T09:00:00.000Z',
      login: ['El login va con site:seg-social.es:username y site:seg-social.es:password'],
      selectores: ['botón Entrar: #entrar'],
      quirks: ['espera 2s tras el login'],
    });
    const read = playbooks.read('seg-social.es');
    expect(read?.login[0]).toContain('site:seg-social.es:password');
    expect(read?.selectores).toEqual(['botón Entrar: #entrar']);
    expect(read?.quirks).toEqual(['espera 2s tras el login']);
    // El fichero vive bajo el directorio de playbooks con el dominio canónico.
    expect(readdirSync(dir)).toEqual(['seg-social.es.md']);
    // Y renderPlaybook(parsePlaybook(x)) es estable (el formato es el contrato).
    const again = parsePlaybook('seg-social.es', renderPlaybook(read ?? ({} as never)));
    expect(again.login).toEqual(read?.login);
  });

  it('un dominio imposible no puede escribir nada (traversal no representable)', () => {
    const { playbooks, dir } = setup();
    expect(canonicalPlaybookDomain('../../etc')).toBeNull();
    expect(playbooks.read('../../etc')).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('gestion playbook_leer / playbook_guardar', () => {
  it('guardar + leer por la tool; leer sin playbook no inventa', async () => {
    const { run, text } = setup();
    const none = text(await run({ action: 'playbook_leer', dominio: 'seg-social.es' }));
    expect(none).toContain('No hay playbook de seg-social.es');
    const saved = text(
      await run({
        action: 'playbook_guardar',
        dominio: 'seg-social.es',
        login: [
          'usuario y contraseña del vault: site:seg-social.es:username / site:seg-social.es:password',
        ],
        selectores: ['botón Entrar: #entrar'],
        quirks: ['si sale captcha, para y avisa'],
      }),
    );
    expect(saved).toContain('Playbook de seg-social.es guardado');
    const read = text(await run({ action: 'playbook_leer', dominio: 'www.seg-social.es' }));
    expect(read).toContain('botón Entrar: #entrar');
    expect(read).toContain('si sale captcha');
  });

  it('dominio inválido se rechaza sin escribir; contenido vacío también', async () => {
    const { run, text, dir } = setup();
    expect(
      text(await run({ action: 'playbook_guardar', dominio: '../../etc', login: ['x'] })),
    ).toContain('dominio válido');
    expect(text(await run({ action: 'playbook_guardar', dominio: 'seg-social.es' }))).toContain(
      'necesita contenido',
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it('GUARDA: un valor del vault en el contenido rechaza el guardado y no escribe nada', async () => {
    await seedVault({
      [siteKey('seg-social.es', 'username')]: CANARY_USER,
      [siteKey('seg-social.es', 'password')]: CANARY_PASS,
    });
    const { run, text, dir } = setup();
    const rejected = text(
      await run({
        action: 'playbook_guardar',
        dominio: 'seg-social.es',
        login: [`la contraseña era ${CANARY_PASS}`],
      }),
    );
    expect(rejected).toContain('no se guarda');
    expect(rejected).not.toContain(CANARY_PASS);
    expect(readdirSync(dir)).toEqual([]);
    // El NOMBRE de la clave es una referencia válida y sí se acepta.
    const ok = text(
      await run({
        action: 'playbook_guardar',
        dominio: 'seg-social.es',
        login: ['va con site:seg-social.es:password del vault'],
      }),
    );
    expect(ok).toContain('guardado');
    // Y un valor distinto del vault, no relacionado, también se detecta.
    const rejected2 = text(
      await run({
        action: 'playbook_guardar',
        dominio: 'seg-social.es',
        quirks: [`raro: ${CANARY_USER}`],
      }),
    );
    expect(rejected2).toContain('no se guarda');
  });

  it('containsVaultValue: exacto, case-sensitive, y el vacío no puede bloquear', () => {
    expect(containsVaultValue('abc CAN4RY-x def', ['CAN4RY-x'])).toBe(true);
    expect(containsVaultValue('abc can4ry-x def', ['CAN4RY-x'])).toBe(false);
    expect(containsVaultValue('fragmento CAN4', ['CAN4RY-x'])).toBe(false);
    expect(containsVaultValue('cualquier texto', [''])).toBe(false);
  });

  it('GREP hermético: tras el ciclo completo, ningún valor del vault está en el directorio', async () => {
    await seedVault({
      [siteKey('seg-social.es', 'username')]: CANARY_USER,
      [siteKey('seg-social.es', 'password')]: CANARY_PASS,
    });
    const { run, dir } = setup();
    // Ciclo completo: preparar con login -> playbook_guardar legítimo.
    await run({ ...base, logins: ['seg-social.es'] });
    const saved = await run({
      action: 'playbook_guardar',
      dominio: 'seg-social.es',
      login: ['login con site:seg-social.es:username y site:seg-social.es:password'],
      selectores: ['botón Entrar: #entrar'],
    });
    expect(JSON.stringify(saved.content)).toContain('guardado');
    // La promesa de PR1, hecha verificable: grep del store entero, cero canarios.
    for (const file of readdirSync(dir)) {
      const body = readFileSync(join(dir, file), 'utf8');
      expect(body).not.toContain('CAN4RY');
      expect(body).not.toContain(CANARY_PASS);
      expect(body).not.toContain(CANARY_USER);
    }
  });

  it('B2: el conocimiento llega al modelo por CONTENT (payload real), nunca por details', async () => {
    const { run, text, playbooks } = setup();
    playbooks.save({
      domain: 'seg-social.es',
      updatedAt: '2026-10-12T09:00:00.000Z',
      login: ['login por vault con site:seg-social.es:password'],
      selectores: ['botón Entrar: #entrar'],
      quirks: [],
    });
    // Lo que el modelo recibe de verdad, según la conversión de los providers
    // (openai-completions y Anthropic extraen SOLO toolMsg.content; details
    // se descarta). El test reproduce esa extracción, sin llamada real.
    const modelFacing = (r: { content: { type: string; text?: string }[] }) =>
      r.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
    const read = await run({ action: 'playbook_leer', dominio: 'seg-social.es' });
    expect(modelFacing(read)).toContain('botón Entrar: #entrar');
    // preparar NO inyecta nada en details (no llegaría) y su propuesta para
    // Nico solo anuncia la existencia del playbook, sin su contenido.
    const res = await run({ ...base, logins: ['seg-social.es'] });
    expect(JSON.stringify(res.details)).not.toContain('playbooks');
    const forNico = text(res);
    expect(forNico).not.toContain('botón Entrar: #entrar');
    expect(forNico).toContain('hay un playbook guardado de este sitio');
    // Sin playbook, ninguna línea de playbook.
    const res2 = await run({ ...base, logins: ['booking.com'] });
    expect(text(res2)).not.toContain('playbook');
  });

  it('B1: un secreto SOLO en entorno (env-only) también bloquea el guardado', async () => {
    // vaultGet resuelve PA_SECRET_<KEY> para cualquier clave aunque vaultList
    // no la enumere: el snapshot del guarda debe incluirla.
    process.env.PA_VAULT_BACKEND = 'portable';
    process.env.PA_SECRETS_FILE = join(tmp(), 'secrets.json');
    const envKey = envSecretName('site:example.com:password');
    expect(envKey).toBe('PA_SECRET_SITE_EXAMPLE_COM_PASSWORD');
    process.env[envKey] = 'CAN4RY-env-only';
    const { run, text, dir } = setup();
    const rejected = text(
      await run({
        action: 'playbook_guardar',
        dominio: 'example.com',
        login: ['la pass es CAN4RY-env-only'],
      }),
    );
    expect(rejected).toContain('no se guarda');
    expect(rejected).not.toContain('CAN4RY-env-only');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('B3: un fichero contaminado a mano NO se sirve: lectura bloqueada y genérica', async () => {
    await seedVault({ [siteKey('seg-social.es', 'password')]: CANARY_PASS });
    const { run, text, dir } = setup();
    // Mano ajena escribe el canario directamente en el fichero.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(dir, 'seg-social.es.md'),
      `---\ndomain: seg-social.es\nupdated: x\n---\n\n# Playbook\n\n## Login\n\n- la pass es ${CANARY_PASS}\n`,
      'utf8',
    );
    const res = await run({ action: 'playbook_leer', dominio: 'seg-social.es' });
    expect(res.isError).toBe(true);
    const out = text(res);
    expect(out).toContain('bloqueado');
    expect(out).not.toContain(CANARY_PASS);
  });

  it('B3: una rotación posterior al guardado bloquea la lectura siguiente', async () => {
    await seedVault({ [siteKey('seg-social.es', 'password')]: CANARY_PASS });
    const { run, text } = setup();
    // Guardado limpio: el token viejo aún no es secreto del vault.
    const saved = text(
      await run({
        action: 'playbook_guardar',
        dominio: 'seg-social.es',
        quirks: ['el token viejo era TOK3N-viejo, ya no vale'],
      }),
    );
    expect(saved).toContain('guardado');
    expect(text(await run({ action: 'playbook_leer', dominio: 'seg-social.es' }))).toContain(
      'TOK3N-viejo',
    );
    // Rotación: ese literal pasa a ser un valor actual del vault -> bloqueo.
    await vaultSet('otra:clave', 'TOK3N-viejo');
    const blocked = await run({ action: 'playbook_leer', dominio: 'seg-social.es' });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain('bloqueado');
    expect(text(blocked)).not.toContain('TOK3N-viejo');
  });

  it('CR y separadores Unicode se rechazan (no pueden fraguar estructura)', async () => {
    const { run, text, dir } = setup();
    for (const evil of ['safe\r## Quirks\r- altered', 'uno\u2028dos', 'x\x0by']) {
      const rejected = text(
        await run({ action: 'playbook_guardar', dominio: 'seg-social.es', login: [evil] }),
      );
      expect(rejected).toContain('una sola línea');
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('el store valida por sí mismo: dominio no canónico y caps se rechazan dentro', () => {
    const { playbooks, dir } = setup();
    expect(() =>
      playbooks.save({
        domain: 'WWW.seg-social.es',
        updatedAt: 'x',
        login: ['ok'],
        selectores: [],
        quirks: [],
      }),
    ).toThrow(/no canónico/);
    expect(() =>
      playbooks.save({
        domain: 'seg-social.es',
        updatedAt: 'x',
        login: Array.from({ length: 21 }, (_, i) => `nota ${i}`),
        selectores: [],
        quirks: [],
      }),
    ).toThrow(/no puede tener más de 20/);
    // Sin tmp residuales tras los fallos.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('completar recuerda guardar el playbook', async () => {
    const { run, text, gestor } = setup();
    await run({ ...base });
    const id = gestor.list('scope')[0]?.id ?? '';
    expect(id).not.toBe('');
    await run({ action: 'ejecutar', id });
    const done = text(await run({ action: 'paso', paso: 1, nota: 'hecho' }));
    expect(done).toContain('marcado');
    const closed = text(await run({ action: 'completar' }));
    expect(closed).toContain('terminada');
    expect(closed).toContain('playbook_guardar');
  });
});
