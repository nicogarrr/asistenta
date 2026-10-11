import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LoginFlow } from '../src/books/userbot.js';

const SESSION_PATH = `/tmp/test-userbot-${process.pid}.session`;

interface FakeClient {
  invokes: unknown[];
  disconnected: boolean;
  session: { save: () => string };
  invoke: (req: unknown) => Promise<unknown>;
  disconnect: () => Promise<void>;
  connect: () => Promise<void>;
}

function fakeClient(): FakeClient {
  return {
    invokes: [],
    disconnected: false,
    session: { save: () => 'SESSION-DATA' },
    invoke: async function (this: FakeClient, req: unknown) {
      this.invokes.push(req);
      return req;
    },
    disconnect: async function (this: FakeClient) {
      this.disconnected = true;
    },
    connect: async () => {},
  };
}

function flowWithClient(client: FakeClient): LoginFlow {
  const flow = new LoginFlow({ apiId: 1, apiHash: 'a'.repeat(32), sessionPath: SESSION_PATH });
  // LoginFlow mantiene UNA conexion entre request y complete: inyectamos el
  // cliente para comprobar que complete usa ese mismo y no uno nuevo.
  (flow as unknown as { client: unknown }).client = client;
  return flow;
}

describe('LoginFlow', () => {
  it('sin codigo pedido, complete falla', async () => {
    const flow = flowWithClient(fakeClient());
    await expect(flow.complete('12345')).rejects.toThrow(/codigo nuevo/i);
  });

  it('pending caducado (10 min) obliga a pedir codigo nuevo', async () => {
    const flow = flowWithClient(fakeClient());
    (flow as unknown as { pending: unknown }).pending = {
      phoneNumber: '+341',
      phoneCodeHash: 'h',
      at: Date.now() - 11 * 60 * 1000,
    };
    await expect(flow.complete('12345')).rejects.toThrow(/caduco/i);
  });

  it('complete usa el MISMO client, persiste sesion 0600 y desconecta', async () => {
    rmSync(SESSION_PATH, { force: true });
    const client = fakeClient();
    const flow = flowWithClient(client);
    (flow as unknown as { pending: unknown }).pending = {
      phoneNumber: '+341',
      phoneCodeHash: 'h',
      at: Date.now(),
    };
    await flow.complete('12345');
    expect(client.invokes).toHaveLength(1);
    expect(client.disconnected).toBe(true);
    const { readFileSync, statSync } = await import('node:fs');
    expect(readFileSync(SESSION_PATH, 'utf8')).toBe('SESSION-DATA');
    expect(statSync(SESSION_PATH).mode & 0o777).toBe(0o600);
    rmSync(SESSION_PATH, { force: true });
  });

  it('requestCode fallido desconecta el client (sin conexion colgada)', async () => {
    const client = fakeClient();
    client.invoke = async function (this: FakeClient, req: unknown) {
      this.invokes.push(req);
      return { not: 'a SentCode' };
    };
    const flow = flowWithClient(client);
    await expect(flow.requestCode('+341')).rejects.toThrow(/envio de codigo/i);
    expect(client.disconnected).toBe(true);
  });

  it('complete con codigo erroneo desconecta y limpia el pending', async () => {
    const client = fakeClient();
    client.invoke = async () => {
      throw new Error('PHONE_CODE_INVALID');
    };
    const flow = flowWithClient(client);
    (flow as unknown as { pending: unknown }).pending = {
      phoneNumber: '+341',
      phoneCodeHash: 'h',
      at: Date.now(),
    };
    await expect(flow.complete('99999')).rejects.toThrow(/PHONE_CODE_INVALID/);
    expect(client.disconnected).toBe(true);
    expect((flow as unknown as { pending: unknown }).pending).toBeUndefined();
  });

  it('TTL vencido tambien desconecta el client abierto', async () => {
    const client = fakeClient();
    const flow = flowWithClient(client);
    (flow as unknown as { pending: unknown }).pending = {
      phoneNumber: '+341',
      phoneCodeHash: 'h',
      at: Date.now() - 11 * 60 * 1000,
    };
    await expect(flow.complete('12345')).rejects.toThrow(/caduco/i);
    expect(client.disconnected).toBe(true);
  });

  it('2FA sin contraseña es error explicito y desconecta', async () => {
    const client = fakeClient();
    client.invoke = async () => {
      throw new Error('SESSION_PASSWORD_NEEDED');
    };
    const flow = flowWithClient(client);
    (flow as unknown as { pending: unknown }).pending = {
      phoneNumber: '+341',
      phoneCodeHash: 'h',
      at: Date.now(),
    };
    await expect(flow.complete('12345')).rejects.toThrow(/2FA/);
  });
});
