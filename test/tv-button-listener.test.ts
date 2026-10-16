/**
 * Tests del listener del boton del mando (:8765).
 *
 * Lo que se fija aqui es el contrato que `scripts/tv/install-magic-mapper.sh`
 * depende: el preflight hace GET a `/tv/button-health` sin credenciales y
 * aborta el despliegue si no responde. Si esa ruta cambia de forma, el
 * instalador falla en la TV y el test tiene que fallo antes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isPrivateRemote,
  signTvButton,
  startTvButtonListener,
  type TvButtonListener,
} from '../src/tv/button-listener.js';

const SECRET = 'secreto';

/** Cabeceras de firma como las genera el magic_mapper parcheado en la tele. */
function signedHeaders(
  method: string,
  path: string,
  opts: { ts?: string; nonce?: string; secret?: string } = {},
): Record<string, string> {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? 'a1b2c3d4e5f60708';
  const secret = opts.secret ?? SECRET;
  return {
    'x-tv-ts': ts,
    'x-tv-nonce': nonce,
    'x-tv-sig': signTvButton(secret, ts, nonce, method, path),
  };
}

let started: TvButtonListener | null = null;

async function listen(
  opts: Partial<Parameters<typeof startTvButtonListener>[0]> = {},
): Promise<{ base: string; onButton: ReturnType<typeof vi.fn> }> {
  const onButton = vi.fn();
  const listener = startTvButtonListener({ port: 0, host: '127.0.0.1', onButton, ...opts });
  started = listener;
  await listener.ready;
  return { base: `http://127.0.0.1:${listener.port}`, onButton };
}

afterEach(async () => {
  await started?.close();
  started = null;
});

describe('isPrivateRemote', () => {
  // Los tests de socket de abajo conectan por loopback y por eso llegaban como
  // ::1, que exercise la primera alternativa del patron y dejaba las ramas IPv4
  // sin comprobar. Una allowlist que rechaza 192.168.x.x es exactamente el fallo
  // que hacia el preflight del installer devolver 403 en una LAN perfectamente
  // normal, asi que estas direcciones se prueban una a una.
  it.each([
    '192.168.1.237',
    '192.168.1.227',
    '192.168.0.1',
    '10.0.0.5',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.255',
    '127.0.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '::1',
    '::ffff:192.168.1.237',
    '::ffff:127.0.0.1',
  ])('acepta la privada %s', (ip) => {
    expect(isPrivateRemote(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '11.0.0.1',
    '192.169.0.1',
    '',
    'no-es-una-ip',
  ])('rechaza la publica o invalida %s', (ip) => {
    expect(isPrivateRemote(ip)).toBe(false);
  });
});

describe('tv button listener', () => {
  it('responde el preflight sin credenciales', async () => {
    const { base } = await listen();
    const res = await fetch(`${base}/tv/button-health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'tv-button' });
  });

  it('el preflight sigue abierto aunque haya token configurado', async () => {
    // El instalador llama al health sin token: si exigiera auth, el despliegue
    // abortaria en la TV aunque el listener este perfecto.
    const { base } = await listen({ token: 'secreto' });
    const res = await fetch(`${base}/tv/button-health`);
    expect(res.status).toBe(200);
  });

  it('el health no filtra el token ni estado interno', async () => {
    const { base } = await listen({ token: 'secreto' });
    const body = await (await fetch(`${base}/tv/button-health`)).text();
    expect(body).not.toContain('secreto');
  });

  it('dispara el boton con GET, que es lo que hace curl con una sola URL', async () => {
    const { base, onButton } = await listen();
    const res = await fetch(`${base}/tv/button`);
    expect(res.status).toBe(202);
    expect(onButton).toHaveBeenCalledTimes(1);
  });

  it('dispara el boton con POST tambien', async () => {
    const { base, onButton } = await listen();
    const res = await fetch(`${base}/tv/button`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(onButton).toHaveBeenCalledTimes(1);
  });

  it('con token, POST sin firma se rechaza y no dispara', async () => {
    const { base, onButton } = await listen({ token: SECRET });
    const res = await fetch(`${base}/tv/button`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(onButton).not.toHaveBeenCalled();
  });

  it('con token, un Bearer con el secreto NO sirve: el token no viaja', async () => {
    // Canario del auditor: la pulsacion no puede mandar el secreto en claro,
    // ni siquiera el correcto - solo vale la firma HMAC de ESTA pulsacion.
    const { base, onButton } = await listen({ token: SECRET });
    const res = await fetch(`${base}/tv/button`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(401);
    expect(onButton).not.toHaveBeenCalled();
  });

  it('con token, una firma valida dispara', async () => {
    const { base, onButton } = await listen({ token: SECRET });
    const res = await fetch(`${base}/tv/button`, {
      method: 'POST',
      headers: signedHeaders('POST', '/tv/button'),
    });
    expect(res.status).toBe(202);
    expect(onButton).toHaveBeenCalledTimes(1);
  });

  it('la firma es por metodo y ruta: la de otra ruta o metodo no vale', async () => {
    const { base, onButton } = await listen({ token: SECRET });
    for (const headers of [
      signedHeaders('POST', '/tv/button-health'),
      signedHeaders('GET', '/tv/button'),
    ]) {
      const res = await fetch(`${base}/tv/button`, { method: 'POST', headers });
      expect(res.status).toBe(401);
    }
    expect(onButton).not.toHaveBeenCalled();
  });

  it('una firma con reloj fuera de la ventana se rechaza', async () => {
    const { base, onButton } = await listen({ token: SECRET });
    const vieja = String(Math.floor(Date.now() / 1000) - 600); // 10 min atras
    const res = await fetch(`${base}/tv/button`, {
      method: 'POST',
      headers: signedHeaders('POST', '/tv/button', { ts: vieja }),
    });
    expect(res.status).toBe(401);
    expect(onButton).not.toHaveBeenCalled();
  });

  it('la misma firma repetida es replay y se rechaza', async () => {
    const { base, onButton } = await listen({ token: SECRET });
    const headers = signedHeaders('POST', '/tv/button');
    expect((await fetch(`${base}/tv/button`, { method: 'POST', headers })).status).toBe(202);
    expect((await fetch(`${base}/tv/button`, { method: 'POST', headers })).status).toBe(401);
    expect(onButton).toHaveBeenCalledTimes(1);
  });

  it('dos pulsaciones en el mismo segundo con nonce distinto pasan las dos', async () => {
    const { base, onButton } = await listen({ token: SECRET });
    const ts = String(Math.floor(Date.now() / 1000));
    for (const nonce of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']) {
      const res = await fetch(`${base}/tv/button`, {
        method: 'POST',
        headers: signedHeaders('POST', '/tv/button', { ts, nonce }),
      });
      expect(res.status).toBe(202);
    }
    expect(onButton).toHaveBeenCalledTimes(2);
  });

  it('sin token configurado acepta cualquiera (misma postura que Glasshouse)', async () => {
    const { base, onButton } = await listen();
    const res = await fetch(`${base}/tv/button`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(onButton).toHaveBeenCalledTimes(1);
  });

  it('ruta desconocida es 404', async () => {
    const { base } = await listen();
    expect((await fetch(`${base}/tv/cualquiera`)).status).toBe(404);
  });

  it('el metodo se ignora en el health pero se rechaza en el boton', async () => {
    const { base, onButton } = await listen();
    expect((await fetch(`${base}/tv/button-health`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/tv/button`, { method: 'DELETE' })).status).toBe(405);
    expect(onButton).not.toHaveBeenCalled();
  });

  it('tolera query string y trailing slash', async () => {
    const { base, onButton } = await listen();
    expect((await fetch(`${base}/tv/button-health?x=1`)).status).toBe(200);
    expect((await fetch(`${base}/tv/button/`)).status).toBe(202);
    expect(onButton).toHaveBeenCalledTimes(1);
  });

  it('un fallo del manejador no tumba el listener', async () => {
    const onButton = vi.fn().mockRejectedValue(new Error('boom'));
    const listener = startTvButtonListener({ port: 0, host: '127.0.0.1', onButton });
    started = listener;
    await listener.ready;
    const base = `http://127.0.0.1:${listener.port}`;
    expect((await fetch(`${base}/tv/button`)).status).toBe(202);
    // El listener sigue sirviendo despues del fallo.
    expect((await fetch(`${base}/tv/button-health`)).status).toBe(200);
  });

  it('close() libera el puerto y resuelve', async () => {
    const { base } = await listen();
    await started?.close();
    started = null;
    await expect(fetch(`${base}/tv/button-health`)).rejects.toThrow();
  });
});
