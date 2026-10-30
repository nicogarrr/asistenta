import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionLog } from '../src/audit/log.js';
import {
  EMAIL_CHANNEL,
  EMAIL_TOO_BIG_TEXT,
  emailAuditRecord,
  type RawCommandMail,
  taintEmailTurn,
} from '../src/channels/email.js';
import { setupEmailChannel } from '../src/channels/email-setup.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import type { Inbound } from '../src/channels/types.js';
import type { SendRequest } from '../src/mail/types.js';
import { Gate } from '../src/permissions.js';
import { stateEntry } from '../src/state-files.js';

/**
 * Escenario de punta a punta del correo como canal (F10), con las mismas piezas
 * que monta el daemon: setupEmailChannel → ChannelRegistry → turno marcado como
 * externo y privado → respuesta en el mismo hilo; lo ignorado acaba en el
 * registro de auditoría. Buzón y SMTP falsos; nada sale a la red.
 */
const ENV = { PA_CORREO_CANAL: '1', PA_CORREO_CANAL_REMITENTES: 'nico@gmail.com' };
const auth = (domain: string) =>
  `Authentication-Results: mx.google.com;\r\n  dkim=pass header.i=@${domain} header.s=s1`;

function raw(
  uid: string,
  over: { from?: string; dkim?: boolean; subject?: string; size?: number } = {},
): RawCommandMail {
  const from = over.from ?? 'nico@gmail.com';
  return {
    uid,
    headers: [
      ...(over.dkim === false ? [] : [auth(from.split('@')[1] ?? '')]),
      `From: Nico <${from}>`,
      `Subject: ${over.subject ?? '[asistenta] qué tengo mañana'}`,
      `Message-ID: <m${uid}@mail.gmail.com>`,
    ].join('\r\n'),
    text: '¿Qué tengo mañana?',
    size: over.size ?? 3000,
  };
}

describe('e2e: correo como canal', () => {
  let dir = '';
  let actions: ActionLog;
  let inbox: RawCommandMail[];
  let sent: SendRequest[];
  let cursorSeen: string[];

  const setup = (env: NodeJS.ProcessEnv = ENV) =>
    setupEmailChannel({
      env,
      stateDir: dir,
      loadRead: async () => ({ address: 'asistenta@gmail.com' }) as never,
      loadSend: async () => ({ address: 'asistenta@gmail.com' }) as never,
      send: async (_account, req) => {
        sent.push(req);
        return { ok: true, id: `<r${sent.length}@asistenta>` };
      },
      poll: async (_account, cursorFile) => {
        cursorSeen.push(cursorFile);
        return inbox.splice(0);
      },
      // El mismo cableado que src/cli.ts.
      audit: (e) => {
        if (!e.accepted) actions.record(emailAuditRecord(e));
      },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-e2e-correo-'));
    actions = new ActionLog({ file: join(dir, 'actions.jsonl') });
    inbox = [];
    sent = [];
    cursorSeen = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('apagado por defecto: sin PA_CORREO_CANAL no hay canal', async () => {
    const r = await setup({ PA_CORREO_CANAL_REMITENTES: 'nico@gmail.com' });
    expect(r.channel).toBeNull();
  });

  it('un correo de Nico entra como turno marcado, se responde en el hilo y lo falso se audita', async () => {
    const r = await setup();
    if (!r.channel) throw new Error('el canal debería arrancar');
    const registry = new ChannelRegistry();
    registry.register(r.channel);

    const asked: string[] = [];
    const gate = new Gate({
      protectedPaths: [],
      allow: ['fetch'],
      egressTaint: true,
      approver: (_c, reason) => {
        asked.push(reason);
        return true;
      },
    });

    inbox.push(
      raw('1'),
      raw('2', { dkim: false }),
      raw('3', { from: 'intruso@gmail.com' }),
      raw('4', { subject: 'sin etiqueta' }),
      raw('5', { size: 6 * 1024 * 1024 }),
    );
    const turns: Inbound[] = [];
    await registry.startAll({
      onMessage: async (inbound: Inbound) => {
        turns.push(inbound);
        // Lo mismo que hace el daemon antes de correr el agente.
        if (inbound.channel === EMAIL_CHANNEL) taintEmailTurn(gate, inbound.chatId);
        const adapter = registry.get(inbound.channel, inbound.account);
        await adapter?.send({
          channel: inbound.channel,
          account: inbound.account,
          chatId: inbound.chatId,
          threadId: inbound.threadId,
          text: 'Mañana: dentista a las 10.',
        });
      },
    } as never);
    await registry.stopAll();

    // Solo el correo bueno es un turno.
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      channel: 'correo',
      chatId: 'correo:nico@gmail.com',
      threadId: '<m1@mail.gmail.com>',
      authorised: true,
    });

    // El turno queda externo + privado: una salida con datos a un dominio nuevo pregunta.
    expect(gate.privateTaintOf('correo:nico@gmail.com')).toMatch(/correo/);
    await gate.check('correo:nico@gmail.com', {
      tool: 'fetch',
      args: { url: 'https://nuevo.example/x?d=dentista10' },
      actor: 'me',
    });
    expect(asked).toHaveLength(1);

    // Respuesta en el mismo hilo y aviso por tamaño; a los no verificados, nada.
    expect(sent.map((s) => s.to)).toEqual([['nico@gmail.com'], ['nico@gmail.com']]);
    const reply = sent.find((s) => s.text.startsWith('Mañana'));
    expect(reply).toMatchObject({
      subject: 'Re: [asistenta] qué tengo mañana',
      inReplyTo: '<m1@mail.gmail.com>',
    });
    expect(sent.find((s) => s.text === EMAIL_TOO_BIG_TEXT)?.inReplyTo).toBe('<m5@mail.gmail.com>');

    // Lo ignorado está en pa auditoria, con su motivo.
    const ignored = actions.recent(50, { action: 'correo.ignorado' });
    expect(ignored.map((e) => e.target).sort()).toEqual(['uid:2', 'uid:3', 'uid:4', 'uid:5']);
    expect(ignored.every((e) => e.result === 'blocked' && e.actor === 'correo')).toBe(true);
    expect(ignored.find((e) => e.target === 'uid:5')?.detail).toContain(
      'aviso al remitente enviado',
    );
  });

  it('el cursor del buzón vive en correo-canal.json, que la copia de seguridad incluye', async () => {
    const r = await setup();
    await r.channel?.start({ onMessage: async () => {} } as never);
    await r.channel?.stop();
    expect(cursorSeen[0]).toBe(join(dir, 'correo-canal.json'));
    expect(stateEntry('correo-canal.json')?.backup).toBe('file');
  });
});
