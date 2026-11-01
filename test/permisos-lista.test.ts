import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatPermisosLista, permisosListaReply } from '../src/channels/permisos-lista.js';
import { Gate } from '../src/permissions.js';

const YES = () => true;
const DAY = Date.UTC(2026, 9, 30, 12, 0, 0);

describe('/permisos lista: herramienta, dónde vale y desde cuándo (solo lectura)', () => {
  let dir = '';
  let dbPath = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-permisos-lista-'));
    dbPath = join(dir, 'approvals.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const gateIn = (chat: string) =>
    new Gate({ allow: ['read'], approver: YES, dbPath, approvalChat: chat });

  it('una línea por permiso, el chat actual como «este chat» y con fecha', () => {
    const a = gateIn('telegram:111');
    a.registerSession('s');
    a.setScope('s', 'exec', 'always');
    const b = gateIn('telegram:222');
    b.registerSession('s');
    b.setScope('s', 'fetch', 'always');
    const text = permisosListaReply([], dbPath, 'telegram:111');
    const today = new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
    expect(text).toContain('Permisos «siempre» (2):');
    expect(text).toContain(`• exec — este chat — desde ${today}`);
    expect(text).toContain(`• fetch — chat telegram:222 — desde ${today}`);
    expect(text).toContain('/permisos revocar');
  });

  it('solo nombres de herramienta: nunca la clave guardada con sus argumentos', () => {
    const text = formatPermisosLista(
      [{ tool: 'exec', chat: 'telegram:1', since: DAY }],
      'telegram:1',
    );
    expect(text).toBe(
      [
        'Permisos «siempre» (1):',
        '• exec — este chat — desde 30/10/2026',
        'Para quitar uno, dime cuál, por ejemplo /permisos revocar exec (o añade «este chat» para quitarlo solo aquí).',
      ].join('\n'),
    );
  });

  it('un «Siempre» que solo está en la memoria de un gate sale sin fecha', () => {
    const gate = {
      listPersistedAlwaysWithChat: () => [{ tool: 'shell', chat: 'local' }],
    };
    expect(permisosListaReply([gate], dbPath, 'telegram:9')).toContain(
      '• shell — consola local — fecha desconocida',
    );
  });

  it('vacío lo dice y una lista muy larga se recorta para caber en Telegram', () => {
    expect(permisosListaReply([], dbPath)).toBe('No me has dado ningún permiso «siempre».');
    const many = Array.from({ length: 60 }, (_, i) => ({
      tool: `herramienta_${String(i).padStart(2, '0')}`,
      chat: 'telegram:1',
      since: DAY,
    }));
    const text = formatPermisosLista(many, 'telegram:1');
    expect(text).toContain('… y 20 más.');
    expect(text.length).toBeLessThan(4000);
  });
});
