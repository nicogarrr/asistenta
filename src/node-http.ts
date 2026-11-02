import type * as NodeHttp from 'node:http';
import { createRequire } from 'node:module';

/**
 * `node:http` por `require`, no por `import`. En Node 24, el primer
 * `import … from 'node:http'` arma su fachada ESM leyendo todas sus
 * exportaciones, y entre ellas están los getters perezosos de `WebSocket`,
 * `CloseEvent` y `MessageEvent`, que cargan undici entero (~10–20 ms) aunque
 * nadie los use. Con `require` es el mismo módulo y la misma función
 * `createServer`, sin ese coste en cada arranque de `pa`.
 */
const nodeHttp = createRequire(import.meta.url)('node:http') as typeof NodeHttp;

export const createServer: typeof NodeHttp.createServer = nodeHttp.createServer;
