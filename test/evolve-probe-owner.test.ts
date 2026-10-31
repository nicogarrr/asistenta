import { createServer, request } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { connectionFromBrowser } from '../evolve/probe-owner.js';

// La sonda pregunta al sistema qué proceso abrió cada conexión a su servidor de pruebas.
// Una petición hecha desde Node (como haría el código de un intento que se hace pasar por
// el navegador) no es del navegador, diga lo que diga su User-Agent.
describe('quién abrió la conexión a la sonda', () => {
  it.runIf(process.platform === 'linux')(
    'una petición desde Node no es del navegador',
    async () => {
      let verdict: boolean | null | undefined;
      const server = createServer((_req, res) => res.end('ok'));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      server.on('connection', (s: Socket) => {
        verdict = connectionFromBrowser(s.remotePort ?? 0, port);
      });
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/',
            headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          },
        );
        req.on('error', reject);
        req.end();
      });
      server.close();
      expect(verdict).toBe(false);
    },
  );

  it('un puerto que nadie usa no se atribuye a nadie', () => {
    expect(connectionFromBrowser(1, 2)).toBeNull();
  });
});
