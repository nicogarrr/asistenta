import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { diagnoseTv, diagnosticTarget, TelnetText } from '../src/tv/diagnostics.js';

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))),
  );
});
async function fixture(handle: (socket: Socket) => void): Promise<number> {
  const server = createServer((s) => {
    sockets.push(s);
    s.on('error', () => {});
    handle(s);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  return address.port;
}
it.each(['8.8.8.8', '192.168.1.237; reboot', 'tv.local', '', '::1', '100.128.1.1'])(
  'rejects invalid target %s',
  (host) => {
    expect(() => diagnosticTarget(host)).toThrow();
  },
);
it.each([0, -1, 65536, 1.5, Number.NaN])('rejects invalid port %s', (port) => {
  expect(() => diagnosticTarget('127.0.0.1', port)).toThrow();
});
it.each(['127.0.0.1', '192.168.1.237', '172.16.1.2', '10.1.2.3', '100.76.209.20'])(
  'accepts private target %s',
  (host) => {
    expect(() => diagnosticTarget(host)).not.toThrow();
  },
);
it('consumes split Telnet negotiation and subnegotiation without exposing it', () => {
  const p = new TelnetText();
  expect(p.feed(Buffer.from([255])).text).toBe('');
  expect([...p.feed(Buffer.from([251, 1, 255, 253, 3])).replies]).toEqual([
    255, 254, 1, 255, 252, 3,
  ]);
  expect(p.feed(Buffer.from([255, 250, 24, 50, 255])).text).toBe('');
  expect(p.feed(Buffer.from([240, 65])).text).toBe('A');
});
it('uses only fixed read commands, drops echo, sanitizes terminal controls, and completes', async () => {
  let command = '';
  const port = await fixture((s) => {
    s.write('~ # ');
    s.on('data', (d) => {
      command += d.toString();
      const marker = command.match(/PA_DIAG_END_[a-f0-9]{32}/)?.[0];
      if (!marker) return;
      s.write(command);
      s.write(`uid=0(root)\nLinux webOS\n\x1b[31mTEST\n${marker}\n~ # `);
    });
  });
  const report = await diagnoseTv('127.0.0.1', port);
  expect(report).toContain('uid=0(root)');
  expect(report).toContain('\\x1b[31mTEST');
  expect(report).not.toContain('PA_DIAG_END_');
  expect(command).toMatch(/^id; uname -a; for t in python3 curl openssl sha256sum;/);
  expect(command).not.toMatch(/rm |wget|reboot|kill|passwd|tailscale|curl https/);
});
it('never sends login credentials or commands when login is required', async () => {
  let received = '';
  const port = await fixture((s) => {
    s.on('data', (d) => {
      received += d.toString();
    });
    s.write('login: ');
  });
  await expect(diagnoseTv('127.0.0.1', port)).rejects.toThrow('credenciales');
  expect(received).toBe('');
});
it('rejects an early close instead of claiming success', async () => {
  const port = await fixture((s) => s.end('banner\n'));
  await expect(diagnoseTv('127.0.0.1', port)).rejects.toThrow('sin completar');
});
it('bounds untrusted data', async () => {
  const port = await fixture((s) => s.write('x'.repeat(40_000)));
  await expect(diagnoseTv('127.0.0.1', port)).rejects.toThrow('demasiado grande');
});
it('has an absolute deadline even when the peer keeps sending small chunks', async () => {
  const port = await fixture((s) => {
    const timer = setInterval(() => s.write('x'), 40);
    s.on('close', () => clearInterval(timer));
  });
  await expect(diagnoseTv('127.0.0.1', port)).rejects.toThrow('plazo');
});
