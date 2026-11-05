import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { helpText } from '../src/channels/telegram-help.js';
import { createRoutineFire, type RoutineDone } from '../src/daemon/routine-fire.js';
import type { Routine, Store } from '../src/db.js';
import {
  parseScriptName,
  scriptArgv,
  scriptMatches,
  scriptsCommand,
  UserScripts,
  userScriptsTimeoutMs,
} from '../src/scripts-eventos.js';

let dir: string;
let logFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-valor6-scripts-'));
  logFile = join(dir, 'log', 'scripts.log');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Script de Node que deja en out.json lo que recibió por el entorno. */
const ECHO = `require('node:fs').writeFileSync(require('node:path').join(__dirname, 'out.json'), JSON.stringify({ evento: process.env.ASISTENTA_EVENTO, texto: process.env.ASISTENTA_TEXTO, ok: process.env.ASISTENTA_OK, token: process.env.FAKE_BOT_TOKEN ?? null }));console.log('hecho');`;

function scripts(over: Partial<ConstructorParameters<typeof UserScripts>[0]> = {}) {
  return new UserScripts({
    dir: join(dir, 'scripts'),
    logFile,
    enabled: () => true,
    timeoutMs: () => 10_000,
    platform: 'linux',
    ...over,
  });
}

function put(name: string, body: string) {
  const us = scripts();
  us.ensureDir();
  writeFileSync(join(dir, 'scripts', name), body);
}

const out = () => JSON.parse(readFileSync(join(dir, 'scripts', 'out.json'), 'utf8'));

describe('scripts del usuario: nombres', () => {
  it('el nombre dice el evento y las palabras', () => {
    expect(parseScriptName('rutina.ps1')).toMatchObject({ event: 'rutina', words: '' });
    expect(parseScriptName('mensaje-buenas-noches.ps1')).toMatchObject({
      event: 'mensaje',
      words: 'buenas noches',
    });
    expect(parseScriptName('Recordatorio_Pastilla.JS')).toMatchObject({
      event: 'recordatorio',
      words: 'pastilla',
    });
    expect(parseScriptName('LEEME.txt')).toBeNull();
    expect(parseScriptName('borrar-todo.ps1')).toBeNull();
    expect(parseScriptName('.aprobados.json')).toBeNull();
  });

  it('casa sin tildes ni mayúsculas', () => {
    const f = parseScriptName('mensaje-buenas-noches.ps1');
    if (!f) throw new Error('null');
    expect(scriptMatches(f, 'mensaje', '¡Buenas   NOCHES, Asistenta!')).toBe(true);
    expect(scriptMatches(f, 'mensaje', 'buenos días')).toBe(false);
    expect(scriptMatches(f, 'rutina', 'buenas noches')).toBe(false);
    const g = parseScriptName('recordatorio-medicacion.js');
    if (!g) throw new Error('null');
    expect(scriptMatches(g, 'recordatorio', 'tomar la medicación')).toBe(true);
  });

  it('se lanza sin shell: intérprete + ruta', () => {
    expect(scriptArgv('C:\\s\\a b.ps1', 'win32')).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\s\\a b.ps1',
    ]);
    expect(scriptArgv('C:\\s\\x.bat', 'win32')).toEqual(['cmd.exe', '/d', '/c', 'C:\\s\\x.bat']);
    expect(scriptArgv('/s/x.js', 'linux', '/usr/bin/node')).toEqual(['/usr/bin/node', '/s/x.js']);
    expect(scriptArgv('/s/x.bat', 'linux')).toBeNull();
  });

  it('tope de tiempo: 30 s por defecto, de 1 a 300', () => {
    expect(userScriptsTimeoutMs({})).toBe(30_000);
    expect(userScriptsTimeoutMs({ PA_SCRIPTS_TIMEOUT: '5' })).toBe(5_000);
    expect(userScriptsTimeoutMs({ PA_SCRIPTS_TIMEOUT: '9999' })).toBe(300_000);
    expect(userScriptsTimeoutMs({ PA_SCRIPTS_TIMEOUT: 'x' })).toBe(30_000);
  });
});

describe('scripts del usuario: ejecución', () => {
  it('sin aprobar no se ejecuta y avisa una sola vez; aprobado sí, con el evento en el entorno', async () => {
    put('rutina.js', ECHO);
    const notify = vi.fn();
    const us = scripts({ notify });
    const first = await us.fire('rutina', 'informe diario', { ASISTENTA_OK: '1' });
    expect(first).toEqual([{ name: 'rutina.js', outcome: 'sin-aprobar', detail: 'pendiente' }]);
    await us.fire('rutina', 'informe diario');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0])).toContain('/scripts aprobar rutina.js');

    expect(await scriptsCommand(us, 'aprobar rutina')).toContain('aprobado');
    const r = await us.fire('rutina', 'informe diario', { ASISTENTA_OK: '1' });
    expect(r[0]?.outcome).toBe('ok');
    expect(out()).toMatchObject({ evento: 'rutina', texto: 'informe diario', ok: '1' });
    expect(readFileSync(logFile, 'utf8')).toMatch(/rutina\.js \[rutina\] ok .* hecho/);
  });

  it('si el fichero cambia tras aprobarlo, deja de ejecutarse hasta aprobarlo otra vez', async () => {
    put('github-rojo.js', ECHO);
    const us = scripts();
    us.approve('github-rojo.js');
    writeFileSync(join(dir, 'scripts', 'github-rojo.js'), `${ECHO}\n// cambiado`);
    expect(us.find('github-rojo')?.state).toBe('cambiado');
    const r = await us.fire('github', '🔴 CI en rojo en nicogarrr/asistenta');
    expect(r[0]?.outcome).toBe('sin-aprobar');
  });

  it('solo los que casan, y el entorno va sin credenciales', async () => {
    put('mensaje-luces.js', ECHO);
    put('mensaje-musica.js', 'process.exit(3)');
    const us = scripts();
    await scriptsCommand(us, 'aprobar todos');
    process.env.FAKE_BOT_TOKEN = 'secreto';
    try {
      const r = await us.fire('mensaje', 'Enciende las LUCES');
      expect(r.map((x) => x.name)).toEqual(['mensaje-luces.js']);
      expect(out().token).toBeNull();
    } finally {
      delete process.env.FAKE_BOT_TOKEN;
    }
    const bad = await us.test('mensaje-musica');
    expect(bad).toMatchObject({ outcome: 'fallo', detail: 'código 3' });
  });

  it('un script que no termina se corta al tope', async () => {
    put('descarga.js', 'setInterval(() => {}, 1000);');
    const us = scripts({ timeoutMs: () => 500 });
    us.approve('descarga.js');
    const r = await us.fire('descarga', 'factura.pdf');
    expect(r[0]).toMatchObject({ outcome: 'fallo', detail: 'cortado a los 1 s' });
  });

  it('apagado (sin PA_SCRIPTS=1) no lanza nada y /scripts explica cómo encenderlo', async () => {
    put('rutina.js', ECHO);
    const us = scripts({ enabled: () => false });
    us.approve('rutina.js');
    expect(await us.fire('rutina', 'x')).toEqual([]);
    expect(await scriptsCommand(us, '')).toContain('PA_SCRIPTS=1');
  });

  it('/scripts lista el estado y /scripts quitar deja de ejecutarlo', async () => {
    put('recordatorio-pastilla.js', ECHO);
    const us = scripts();
    expect(await scriptsCommand(us, '')).toMatch(
      /recordatorio-pastilla\.js — cuando suena un recordatorio que diga «pastilla» · ⏳/,
    );
    us.approve('recordatorio-pastilla.js');
    expect(await scriptsCommand(us, '')).toContain('«pastilla» · ✅');
    expect(await scriptsCommand(us, 'quitar recordatorio-pastilla')).toContain(
      'ya no se ejecutará',
    );
    expect((await us.fire('recordatorio', 'la pastilla'))[0]?.outcome).toBe('sin-aprobar');
  });
});

describe('scripts del usuario: rutinas y recordatorios avisan al terminar', () => {
  const base: Routine = {
    id: 'r1',
    scope: 'telegram:dm:42',
    name: 'recordatorio: tomar la pastilla [0 9 * * *]',
    kind: 'schedule',
    params: null,
    steps: null,
    prompt: 'tomar la pastilla',
    schedule: '0 9 * * *',
    enabled: true,
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T08:00:00.000Z',
    lastRunAt: null,
  };
  function deps(onDone: (d: RoutineDone) => void) {
    return {
      store: { saveRoutine: vi.fn(), deleteRoutine: vi.fn() } as unknown as Store,
      tickGoal: vi.fn(async () => {}),
      runTask: vi.fn(async () => 'Tienes 3 correos nuevos'),
      send: vi.fn(async () => ({})),
      delivery: {
        get: () => ({ target: 'chat' as const, soloSiCambia: false }),
        commit: vi.fn(),
      } as never,
      outputDir: '/nonexistent/salidas',
      sync: vi.fn(),
      droppedRemindersPath: '/nonexistent/dropped.jsonl',
      onDone,
    };
  }
  it('un recordatorio que suena avisa con su texto', async () => {
    const seen: RoutineDone[] = [];
    await createRoutineFire(deps((d) => seen.push(d)))('', { scope: base.scope, routine: base });
    expect(seen).toEqual([
      expect.objectContaining({ reminder: true, text: 'tomar la pastilla', ok: true }),
    ]);
  });
  it('una rutina que termina avisa con su nombre y su salida; un fallo del aviso no la tumba', async () => {
    const r = { ...base, name: 'informe', prompt: 'resume el correo' };
    const seen: RoutineDone[] = [];
    const d = deps((x) => {
      seen.push(x);
      throw new Error('boom');
    });
    await createRoutineFire(d)('', { scope: r.scope, routine: r });
    expect(seen[0]).toMatchObject({
      reminder: false,
      text: 'informe',
      ok: true,
      salida: 'Tienes 3 correos nuevos',
    });
    expect(d.send).toHaveBeenCalledTimes(1);
  });
});

describe('/ayuda', () => {
  it('menciona /scripts y sigue cabiendo en un mensaje', () => {
    const text = helpText();
    expect(text).toContain('/scripts [aprobar]');
    expect(Array.from(text).length).toBeLessThan(4000);
  });
});
