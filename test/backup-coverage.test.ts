import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runBackup } from '../src/backup.js';

// Ida y vuelta: lo que solo existe en el directorio de estado tiene que estar en la
// copia del día, y la copia tiene que abrirse como el original.
describe('copia de seguridad: todo lo que no tiene otra copia', () => {
  it('incluye agenda local, perfil, alertas de precio (json + sqlite) y servicios', () => {
    const state = mkdtempSync(join(tmpdir(), 'pa-bk-state-'));
    mkdirSync(join(state, 'calendar'));
    writeFileSync(
      join(state, 'calendar', 'local.ics'),
      'BEGIN:VCALENDAR\nSUMMARY:Dentista\nEND:VCALENDAR\n',
    );
    mkdirSync(join(state, 'profile'));
    writeFileSync(join(state, 'profile', 'local.json'), '{"nombre":"Nico"}');
    mkdirSync(join(state, 'services'));
    writeFileSync(join(state, 'services', 'web.json'), '{"puerto":8080}');
    writeFileSync(join(state, 'pricewatch.json'), '{"alertas":[{"url":"https://x.es","max":100}]}');
    const pw = new DatabaseSync(join(state, 'pricewatch.sqlite'));
    pw.exec(
      'PRAGMA journal_mode = WAL; CREATE TABLE precios (p REAL); INSERT INTO precios VALUES (99.5)',
    );
    // Abierta y en WAL, como con el daemon en marcha.
    const agent = new DatabaseSync(join(state, 'agent.db'));
    agent.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('hola')");

    const r = runBackup({ stateDir: state, now: new Date(2026, 9, 30, 4, 0) });
    pw.close();
    agent.close();

    expect(readFileSync(join(r.dir, 'calendar', 'local.ics'), 'utf8')).toContain('Dentista');
    expect(readFileSync(join(r.dir, 'profile', 'local.json'), 'utf8')).toContain('Nico');
    expect(existsSync(join(r.dir, 'services', 'web.json'))).toBe(true);
    expect(readFileSync(join(r.dir, 'pricewatch.json'), 'utf8')).toContain('x.es');
    expect(r.databases).toEqual(expect.arrayContaining(['agent.db', 'pricewatch.sqlite']));
    const pwCopy = new DatabaseSync(join(r.dir, 'pricewatch.sqlite'), { readOnly: true });
    expect(pwCopy.prepare('SELECT p FROM precios').get()).toEqual({ p: 99.5 });
    pwCopy.close();
    const agentCopy = new DatabaseSync(join(r.dir, 'agent.db'), { readOnly: true });
    expect(agentCopy.prepare('SELECT v FROM t').get()).toEqual({ v: 'hola' });
    agentCopy.close();
  });

  it('no copia el vault ni ficheros sueltos que no son estado', () => {
    const state = mkdtempSync(join(tmpdir(), 'pa-bk-state-'));
    writeFileSync(join(state, 'vault.enc'), 'secreto');
    writeFileSync(join(state, 'agent.pid'), '123');
    const r = runBackup({ stateDir: state, now: new Date(2026, 9, 30, 4, 0) });
    expect(existsSync(join(r.dir, 'vault.enc'))).toBe(false);
    expect(existsSync(join(r.dir, 'agent.pid'))).toBe(false);
  });
});
