import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setupEmailChannel } from '../src/channels/email-setup.js';
import {
  type CommandImap,
  loadCommandCursor,
  pollCommandMail,
  saveCommandCursor,
} from '../src/mail/command-inbox.js';

const read = { address: 'asis@gmail.com', password: 'x', imapHost: 'h', imapPort: 993 } as never;
const send = { address: 'asis@gmail.com' } as never;

function deps(env: NodeJS.ProcessEnv) {
  return {
    env,
    stateDir: '/tmp/x',
    loadRead: async () => read,
    loadSend: async () => send,
    send: vi.fn(async () => ({ ok: true })),
    poll: vi.fn(async () => []),
    audit: vi.fn(),
  };
}

describe('setupEmailChannel', () => {
  it('apagado por defecto', async () => {
    expect(await setupEmailChannel(deps({}))).toEqual({
      channel: null,
      reason: 'apagado (PA_CORREO_CANAL)',
    });
  });
  it('sin lista de remitentes no arranca', async () => {
    const r = await setupEmailChannel(deps({ PA_CORREO_CANAL: '1' }));
    expect(r.channel).toBeNull();
  });
  it('sin cuentas no arranca', async () => {
    const d = {
      ...deps({ PA_CORREO_CANAL: '1', PA_CORREO_CANAL_REMITENTES: 'n@gmail.com' }),
      loadRead: async () => null,
    };
    expect((await setupEmailChannel(d)).channel).toBeNull();
  });
  it('con todo, registra el canal con el cursor en el estado', async () => {
    const d = deps({ PA_CORREO_CANAL: '1', PA_CORREO_CANAL_REMITENTES: 'n@gmail.com' });
    const r = await setupEmailChannel(d);
    expect(r.channel?.name).toBe('correo');
    await r.channel?.start({ onMessage: () => {} } as never);
    await r.channel?.stop();
    expect(d.poll).toHaveBeenCalledWith(read, '/tmp/x/correo-canal.json');
  });
});

function fakeImap(validity: number, uidNext: number, mails: Record<number, string>): CommandImap {
  return {
    open: async () => ({ uidValidity: BigInt(validity), uidNext }),
    search: async (from) =>
      Object.keys(mails)
        .map(Number)
        .filter((u) => u >= from),
    fetch: async (uid) => ({
      headers: `Subject: [asistenta] ${uid}`,
      source: `Subject: x\r\n\r\n${mails[uid]}`,
      size: 100,
    }),
  };
}

describe('pollCommandMail', () => {
  it('la primera vez arranca al final del buzón: el correo viejo no es un turno', async () => {
    const r = await pollCommandMail(fakeImap(5, 11, { 3: 'viejo', 10: 'viejo' }), null);
    expect(r).toEqual({ mails: [], cursor: { validity: '5', next: 11 } });
  });
  it('lee solo lo nuevo, en orden, y avanza el cursor', async () => {
    const r = await pollCommandMail(fakeImap(5, 14, { 10: 'viejo', 12: 'uno', 13: 'dos' }), {
      validity: '5',
      next: 11,
    });
    expect(r.mails.map((m) => [m.uid, m.text])).toEqual([
      ['12', 'uno'],
      ['13', 'dos'],
    ]);
    expect(r.cursor).toEqual({ validity: '5', next: 14 });
  });
  it('si cambia UIDVALIDITY vuelve a empezar por el final', async () => {
    const r = await pollCommandMail(fakeImap(6, 3, { 1: 'x', 2: 'y' }), {
      validity: '5',
      next: 40,
    });
    expect(r).toEqual({ mails: [], cursor: { validity: '6', next: 3 } });
  });
  it('el cursor se guarda y se lee; uno corrupto cuenta como ninguno', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-correo-'));
    const f = join(dir, 'c.json');
    expect(loadCommandCursor(f)).toBeNull();
    saveCommandCursor(f, { validity: '5', next: 9 });
    expect(loadCommandCursor(f)).toEqual({ validity: '5', next: 9 });
  });
});

describe('cableado en el daemon', () => {
  it('un turno de correo se marca como contenido externo justo después de limpiar la marca', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const clear = cli.indexOf('thread.gate.clearTaint(thread.key);');
    const mark = cli.indexOf(
      'if (inbound.channel === EMAIL_CHANNEL) thread.gate.markTainted(thread.key, EMAIL_TAINT_SOURCE);',
    );
    expect(clear).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(clear);
    expect(mark - clear).toBeLessThan(300);
    expect(cli).toContain('registry.register(emailSetup.channel)');
  });
});
