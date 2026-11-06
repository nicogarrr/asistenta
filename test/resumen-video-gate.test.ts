import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalChoice } from '../src/channels/telegram.js';
import { approvalsDbPath, createDaemonGate } from '../src/daemon/gate.js';

const OWNER = 'telegram:dm:1';
let dir = '';
let asked: string[] = [];
const ask = (_k: string, tool: string): Promise<ApprovalChoice> => {
  asked.push(tool);
  return Promise.resolve({ approved: true, scope: 'once' });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-resumen-gate-'));
  asked = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resumen_video no pide permiso', () => {
  it('un vídeo de X (id de 19 cifras) no cuenta como «dinero o credenciales»', async () => {
    const gate = createDaemonGate({
      threadKey: OWNER,
      dbPath: approvalsDbPath(dir),
      ask,
      ownerChat: true,
    });
    for (const url of [
      'https://x.com/jonfortt/status/2112533633500086754',
      'https://www.youtube.com/watch?v=oLawzD19_fI',
    ]) {
      const d = await gate.check(OWNER, {
        tool: 'resumen_video',
        args: { url },
        actor: 'asistenta',
      });
      expect(d.verdict, url).toBe('allow');
    }
    expect(asked).toEqual([]);
  });

  it('una tarjeta de verdad en la consulta de la URL sí pregunta', async () => {
    const gate = createDaemonGate({
      threadKey: OWNER,
      dbPath: approvalsDbPath(dir),
      ask,
      ownerChat: true,
    });
    await gate.check(OWNER, {
      tool: 'resumen_video',
      args: { url: 'https://x.com/u/status/2112533633500086754?c=4111111111111111' },
      actor: 'asistenta',
    });
    expect(asked).toEqual(['resumen_video']);
  });
});
