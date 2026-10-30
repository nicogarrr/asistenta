import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { HELP_SECTIONS } from '../src/channels/telegram-help.js';
import {
  ERASE_PROMPT,
  ERASE_TTL_MS,
  EraseConfirm,
  eraseChat,
  scopesOfChat,
} from '../src/erase-command.js';
import { SessionStore } from '../src/memory/sessions.js';
import { memoryFile } from '../src/memory.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('EraseConfirm: /borrar_chat exige escribir BORRAR', () => {
  it('sin petición previa no intercepta nada, ni siquiera «BORRAR»', () => {
    expect(new EraseConfirm().consume('c1', 'BORRAR')).toBeNull();
  });
  it('«BORRAR» exacto dentro del plazo confirma, y solo una vez', () => {
    let t = 0;
    const e = new EraseConfirm(ERASE_TTL_MS, () => t);
    e.request('c1');
    t = ERASE_TTL_MS - 1;
    expect(e.consume('c1', '  BORRAR ')).toBe('confirmed');
    expect(e.consume('c1', 'BORRAR')).toBeNull();
  });
  it('minúsculas, «sí» u otro texto cancelan', () => {
    const e = new EraseConfirm();
    for (const txt of ['borrar', 'sí', 'BORRAR todo', '/borrar_chat']) {
      e.request('c1');
      expect(e.consume('c1', txt)).toBe('cancelled');
    }
  });
  it('pasado el plazo no borra: el mensaje sigue su camino', () => {
    let t = 0;
    const e = new EraseConfirm(1000, () => t);
    e.request('c1');
    t = 1001;
    expect(e.consume('c1', 'BORRAR')).toBeNull();
  });
  it('la petición de un chat no sirve en otro', () => {
    const e = new EraseConfirm();
    e.request('c1');
    expect(e.consume('c2', 'BORRAR')).toBeNull();
    expect(e.consume('c1', 'BORRAR')).toBe('confirmed');
  });
  it('el aviso nombra la palabra y que no se puede deshacer', () => {
    expect(ERASE_PROMPT).toContain('BORRAR');
    expect(ERASE_PROMPT).toContain('No se puede deshacer');
  });
});

describe('eraseChat: todos los temas del chat y nada de otros', () => {
  it('borra sesiones y memoria de cada tema del chat, no de un chat con prefijo común', () => {
    const stateDir = tempDir('pa-erase-chat-');
    const memoryDir = join(stateDir, 'memory');
    mkdirSync(memoryDir);
    mkdirSync(join(stateDir, 'profile'));
    const ck = 'telegram:main:111';
    const main = `${ck}#main`;
    const tema = `${ck}#viaje`;
    const ajeno = 'telegram:main:1112#main';
    for (const s of [main, tema, ajeno]) writeFileSync(memoryFile(memoryDir, s), `# ${s}\n`);
    const db = memoryDb();
    const store = new SessionStore({ db });
    for (const s of [main, tema, ajeno]) store.end(store.begin(s, s), 'fin');

    expect(scopesOfChat(ck, [], db).sort()).toEqual([main, tema].sort());
    const r = eraseChat({ stateDir, chatKey: ck, liveScopes: [main], db });
    expect(r).toMatchObject({ scopes: 2, sessions: 2, memoryFiles: 2 });
    expect(existsSync(memoryFile(memoryDir, main))).toBe(false);
    expect(existsSync(memoryFile(memoryDir, tema))).toBe(false);
    expect(readFileSync(memoryFile(memoryDir, ajeno), 'utf8')).toContain(ajeno);
    expect(store.recent(ajeno)).toHaveLength(1);
  });
  it('sin base de datos borra al menos el tema principal y los vivos', () => {
    expect(scopesOfChat('x', ['x#a', 'y#b']).sort()).toEqual(['x#a', 'x#main']);
  });
});

describe('cableado', () => {
  it('/borrar_chat está en la ayuda de Telegram', () => {
    const cmds = HELP_SECTIONS.flatMap((s) => s.entries.map((e) => e.command));
    expect(cmds).toContain('borrar_chat');
  });
  it('cli.ts: el dueño en privado, y la confirmación se mira antes que cualquier comando', () => {
    const src = readFileSync(join(__dirname, '../src/cli.ts'), 'utf8');
    expect(src).toMatch(/case 'borrar_chat':\s*return cmdBorrarChat\(inbound\)/);
    const consume = src.indexOf('eraseConfirm.consume(');
    const parse = src.indexOf('parseCommand(inbound.text)');
    expect(consume).toBeGreaterThan(0);
    expect(consume).toBeLessThan(parse);
    const body = src.slice(src.indexOf('const cmdBorrarChatConfirmado'), src.indexOf('// F13:'));
    expect(body).toContain('isOwnerDm(inbound, vigilanteOwnerId)');
    expect(body).toContain('t.active');
  });
});
