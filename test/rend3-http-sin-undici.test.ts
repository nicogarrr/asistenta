import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodeHttp from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/node-http.js';

/**
 * `src` no importa `node:http` como valor: el primer `import` de ese módulo
 * arma su fachada ESM y carga undici entero (~10–20 ms por arranque) por los
 * getters de `WebSocket`/`CloseEvent`/`MessageEvent`. Los servidores salen de
 * `src/node-http.ts`, que lo trae por `require` (mismo módulo).
 */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('node:http sin fachada ESM en src', () => {
  it('ningún fichero de src importa node:http salvo tipos', () => {
    const offenders = tsFiles('src').filter((file) => {
      const text = readFileSync(file, 'utf8');
      return (
        /^\s*import\s+(?!type\b)[^;]*from\s+['"](?:node:)?http['"]/m.test(text) ||
        /import\(\s*['"](?:node:)?http['"]\s*\)/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('createServer es la misma función de node:http', () => {
    expect(createServer).toBe(nodeHttp.createServer);
  });

  it('el servidor funciona igual (escucha, responde y cierra)', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(body).toBe('ok');
  });
});
