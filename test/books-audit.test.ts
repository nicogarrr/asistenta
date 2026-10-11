import { expect, it } from 'vitest';
import { startSetupServer } from '../src/books/setup-page.js';
import { LoginFlow } from '../src/books/userbot.js';

it('first time setup starts without preexisting credentials', () => {
  delete process.env.BOOKS_TG_API_ID;
  delete process.env.BOOKS_TG_API_HASH;
  const { server } = startSetupServer(0);
  server.close();
});
it('failed complete disconnects', async () => {
  let disconnected = false;
  const flow = new LoginFlow({
    apiId: 1,
    apiHash: 'a'.repeat(32),
    sessionPath: '/tmp/never-write',
  });
  Object.assign(flow, {
    client: {
      invoke: async () => {
        throw new Error('PHONE_CODE_INVALID');
      },
      disconnect: async () => {
        disconnected = true;
      },
    },
    pending: { phoneNumber: 'fake', phoneCodeHash: 'fake', at: Date.now() },
  });
  await expect(flow.complete('bad')).rejects.toThrow('PHONE_CODE_INVALID');
  expect(disconnected).toBe(true);
});
it('expired pending disconnects', async () => {
  let disconnected = false;
  const flow = new LoginFlow({
    apiId: 1,
    apiHash: 'a'.repeat(32),
    sessionPath: '/tmp/never-write',
  });
  Object.assign(flow, {
    client: {
      disconnect: async () => {
        disconnected = true;
      },
    },
    pending: { phoneNumber: 'fake', phoneCodeHash: 'fake', at: Date.now() - 700000 },
  });
  await expect(flow.complete('bad')).rejects.toThrow('caduco');
  expect(disconnected).toBe(true);
});
