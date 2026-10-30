import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalChoice } from '../src/channels/telegram.js';
import { approvalsDbPath, createDaemonGate } from '../src/cli.js';

// «Siempre» en un clic de «Enviar» del navegador autorizaba a partir de ahí CUALQUIER
// clic que envía, borra o reserva, en cualquier chat (cli.ts guardaba el scope por
// herramienta). Ahora el «Siempre» es de esa acción concreta.
const A = 'telegram:main:42#main';
const B = 'telegram:main:-100777#main';
let dir = '';
let asked: string[] = [];
const always = (): Promise<ApprovalChoice> => {
  asked.push('q');
  return Promise.resolve({ approved: true, scope: 'always' });
};
const click = (selector: string, label: string) => ({
  tool: 'browser',
  args: { action: 'click', selector, _target: `button | ${label}` },
  actor: 'asistenta',
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-scope-action-'));
  asked = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('«Siempre» vale para una acción, no para toda la herramienta', () => {
  // Cada comprobación usa una Gate nueva sobre el mismo disco: es «otro turno» (sin la
  // marca de contenido externo de F2, que ya quita los permisos dentro del turno).
  const fresh = (key: string) =>
    createDaemonGate({ threadKey: key, dbPath: approvalsDbPath(dir), ask: always });

  it('un «Siempre» en «Enviar» no cubre «Borrar cuenta» ni «Publicar» (ni en otro chat)', async () => {
    expect((await fresh(A).check(A, click('#b1', 'Enviar'))).verdict).toBe('allow');
    expect(asked).toHaveLength(1);
    // La misma acción exacta, otro turno: el «Siempre» sigue valiendo.
    expect((await fresh(A).check(A, click('#b1', 'Enviar'))).verdict).toBe('allow');
    expect(asked).toHaveLength(1);
    // Otra acción con efecto vuelve a preguntar, aquí y en otro chat.
    await fresh(A).check(A, click('#b2', 'Borrar cuenta'));
    expect(asked).toHaveLength(2);
    await fresh(B).check(B, click('#b3', 'Publicar'));
    expect(asked).toHaveLength(3);
  });

  it('servicio y windows tampoco heredan un «Siempre» de otra acción', async () => {
    await fresh(A).check(A, {
      tool: 'windows',
      args: { action: 'focus', title: 'Bloc' },
      actor: 'a',
    });
    expect(asked).toHaveLength(1);
    await fresh(A).check(A, {
      tool: 'windows',
      args: { action: 'close', title: 'Banco' },
      actor: 'a',
    });
    expect(asked).toHaveLength(2);
  });
});
