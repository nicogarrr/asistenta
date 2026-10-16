import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import { PersonalAgent } from '../src/core/agent.js';
import type { Gate } from '../src/permissions.js';

/**
 * P2-17 integration canary with a transport double: a fake `opencode serve`
 * speaking the real session protocol (GET /config, POST /session, POST+GET
 * /session/:id/message). It records the modelID every attempt puts on the
 * wire and scripts replies, so these tests assert what the fallback actually
 * does end to end: a quota error makes the next attempt stream from
 * space-bunny-free on the SAME endpoint with the same context; the next run
 * starts back on deepseek; 5xx/timeouts retry the primary; permanent errors
 * do not retry; and a quota message without a 429 still falls back.
 */

const PRIMARY = 'deepseek-v4.1-flash-free';
const FALLBACK = 'space-bunny-free';

// The certified jail config the real launcher serves; the stream fail-closes
// on anything weaker, so the double serves the real artifact verbatim.
const JAIL_CONFIG = JSON.parse(
  readFileSync(new URL('../scripts/opencode-local/opencode.json', import.meta.url), 'utf8'),
);

type Behavior = 'ok' | 'quota429' | 'quotaPlain' | 'e500' | 'timeout' | 'e401';
const ERROR_TEXT: Record<Exclude<Behavior, 'ok'>, string> = {
  quota429: '429 FreeTierError: daily quota exhausted',
  quotaPlain: 'daily quota exhausted',
  e500: '500 Endpoint is unavailable',
  timeout: 'Requested timed out',
  e401: '401 invalid api key',
};

interface SeenCall {
  modelID: string;
  system: string;
  parts: unknown[];
}

// noUncheckedIndexedAccess: a missing recorded call is a test failure with a
// readable message, not an undefined silently passing through.
function at(i: number): SeenCall {
  const call = seen[i];
  if (!call) throw new Error(`fake serve: no hay llamada registrada en el indice ${i}`);
  return call;
}

const seen: SeenCall[] = [];
let plan: Behavior[] = [];
const sessionBehavior = new Map<string, Behavior>();

let server: Server;
let port = 0;

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => resolve(data));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/config') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(JAIL_CONFIG));
        return;
      }
      if (req.method === 'POST' && url === '/session') {
        const id = `s${seen.length}-${Date.now()}`;
        sessionBehavior.set(id, plan.shift() ?? 'ok');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, directory: '/work' }));
        return;
      }
      const msgMatch = url.match(/^\/session\/([^/]+)\/message$/);
      if (msgMatch && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        seen.push({
          modelID: body.model.modelID,
          system: body.system,
          parts: body.parts,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (msgMatch && req.method === 'GET') {
        const behavior = sessionBehavior.get(msgMatch[1] ?? '') ?? 'ok';
        const payload =
          behavior === 'ok'
            ? [
                {
                  info: {
                    role: 'assistant',
                    finish: 'stop',
                    tokens: { input: 1, output: 1 },
                  },
                  parts: [{ type: 'text', text: 'respuesta de prueba' }],
                },
              ]
            : [
                {
                  info: {
                    role: 'assistant',
                    error: { data: { message: ERROR_TEXT[behavior] } },
                  },
                  parts: [],
                },
              ];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  port = address.port;
});

afterAll(async () => {
  for (const key of [
    'PA_PROVIDER_PRESET',
    'PA_BASE_URL',
    'PA_MODEL',
    'PA_RETRY_ATTEMPTS',
    'PA_RETRY_BASE_MS',
    'PA_RETRY_MAX_MS',
  ]) {
    delete process.env[key];
  }
  resetConfigForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// No tools: the gate never fires, so a stub that always allows is enough and
// the canary stays about the model on the wire, not about permissions.
const gate = {
  check: async () => ({ verdict: 'allow', reason: 'quota canary: no tools declared' }),
} as unknown as Gate;

async function makeAgent(): Promise<PersonalAgent> {
  process.env.PA_PROVIDER_PRESET = 'opencode-local';
  process.env.PA_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.PA_MODEL = PRIMARY;
  process.env.PA_RETRY_ATTEMPTS = '2';
  process.env.PA_RETRY_BASE_MS = '5';
  process.env.PA_RETRY_MAX_MS = '10';
  resetConfigForTests();
  const config = loadConfig();
  expect(config.fallbackModel).toBe(FALLBACK);
  return PersonalAgent.create(config, [], gate, 'test', {
    stream: false,
    sessionId: 'quota-canary',
    desktop: false,
  });
}

describe('quota fallback (P2-17)', () => {
  it('a quota error falls back to space-bunny-free on the same endpoint with the same context, ' +
    'and the next run starts back on the primary', async () => {
    plan = ['quota429', 'ok', 'ok'];
    seen.length = 0;
    const agent = await makeAgent();
    const r1 = await agent.run('primera peticion');
    expect(r1.error).toBeNull();
    expect(r1.attempts).toBe(2);
    const r2 = await agent.run('segunda peticion');
    expect(r2.error).toBeNull();
    expect(r2.attempts).toBe(1);
    expect(seen.map((s) => s.modelID)).toEqual([PRIMARY, FALLBACK, PRIMARY]);
    // Same endpoint by construction (one fake serve) and same context: the
    // system contract and the user's parts travel again on the fallback.
    expect(at(1).system).toBe(at(0).system);
    expect(JSON.stringify(at(1).parts)).toContain('primera peticion');
  }, 30_000);

  it('a 5xx retries the primary, never the fallback', async () => {
    plan = ['e500', 'e500', 'e500'];
    seen.length = 0;
    const agent = await makeAgent();
    const r = await agent.run('peticion con 500');
    expect(r.error).toBeTruthy();
    expect(r.attempts).toBe(3);
    expect(seen.map((s) => s.modelID)).toEqual([PRIMARY, PRIMARY, PRIMARY]);
  }, 30_000);

  it('a permanent error does not retry at all', async () => {
    plan = ['e401'];
    seen.length = 0;
    const agent = await makeAgent();
    const r = await agent.run('peticion con 401');
    expect(r.error).toBeTruthy();
    expect(r.attempts).toBe(1);
    expect(seen.map((s) => s.modelID)).toEqual([PRIMARY]);
  }, 30_000);

  it('a quota message without a 429 still falls back', async () => {
    plan = ['quotaPlain', 'ok'];
    seen.length = 0;
    const agent = await makeAgent();
    const r = await agent.run('cuota sin codigo');
    expect(r.error).toBeNull();
    expect(seen.map((s) => s.modelID)).toEqual([PRIMARY, FALLBACK]);
  }, 30_000);

  it('a timeout retries the same model, never the fallback', async () => {
    plan = ['timeout', 'ok'];
    seen.length = 0;
    const agent = await makeAgent();
    const r = await agent.run('peticion con timeout');
    expect(r.error).toBeNull();
    expect(seen.map((s) => s.modelID)).toEqual([PRIMARY, PRIMARY]);
  }, 30_000);
});
