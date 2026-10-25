import { describe, expect, it } from 'vitest';
import {
  SAFE_PATH,
  buildIconScript,
  parseIconOutput,
  parseLaunchPointsJson,
  readIconCache,
  shellQuote,
  writeIconCache,
  ICON_CACHE_KEY,
} from '../tools/tv-home/src/service/appexec';

function fakeStorage () {
  const store = new Map<string, string>();
  return { store, getItem: (k: string) => (store.has(k) ? store.get(k)! : null), setItem: (k: string, v: string) => { store.set(k, v); } };
}

describe('SAFE_PATH (defensa inyección shell)', () => {
  it('acepta rutas típicas de iconos webOS', () => {
    expect(SAFE_PATH.test('/media/developer/apps/usr/palm/applications/netflix/icon.png')).toBe(true);
    expect(SAFE_PATH.test('/usr/palm/applications/com.webos.app.home/largeIcon.png')).toBe(true);
    expect(SAFE_PATH.test('/media/cryptofs/apps/usr/palm/applications/com.wbd.stream/icon@2x.png')).toBe(true);
  });
  it('rechaza espacios, comillas, metacaracteres, relativas y comandos', () => {
    for (const bad of [
      '/tmp/a b.png', "/tmp/a'b.png", '/tmp/a"b.png', '/tmp/a;rm -rf /', '/tmp/$(id).png',
      '/tmp/`id`.png', 'tmp/a.png', '/tmp/a\nb.png', '/tmp/a|b.png', '/tmp/a>b.png', '',
    ]) expect(SAFE_PATH.test(bad)).toBe(false);
  });
});

describe('shellQuote', () => {
  it('escapa comillas simples', () => {
    expect(shellQuote('/a/b.png')).toBe("'/a/b.png'");
    expect(shellQuote("/a/b'c.png")).toBe(`'/a/b'\\''c.png'`);
  });
});

describe('buildIconScript', () => {
  it('pide iconos por ÍNDICE: los appIds nunca llegan al shell', () => {
    const script = buildIconScript(['/a/one.png', '/b/two.png']);
    expect(script).toContain("printf '%d ' 0");
    expect(script).toContain("printf '%d ' 1");
    expect(script).toContain("readlink -f '/a/one.png'");
    expect(script).toContain('base64');
    expect(script).not.toContain('netflix');
  });
});

describe('parseIconOutput', () => {
  it('mapea por índice e ignora basura, fuera de rango y no-base64', () => {
    const out = '0 iVBORw0KGgoA\nbasura sin sentido\n1 /9j/4AAQ\n7 ZnVl\n2 no-es-b64!!';
    const r = parseIconOutput(out, 2);
    expect(r[0]).toBe('data:image/png;base64,iVBORw0KGgoA');
    expect(r[1]).toBe('data:image/png;base64,/9j/4AAQ');
    expect(r[7]).toBeUndefined();
    expect(r[2]).toBeUndefined();
  });
});

describe('parseLaunchPointsJson', () => {
  it('filtra entradas sin id/título y prefiere largeIcon', () => {
    const out = JSON.stringify({ launchPoints: [
      { id: 'netflix', title: 'Netflix', largeIcon: '/a/big.png', icon: '/a/small.png', removable: true },
      { id: 'sin-titulo' },
      { title: 'sin-id' },
      { id: 'com.dazn.ott.lg', title: 'DAZN', icon: '/b/dazn.png' },
    ]});
    const pts = parseLaunchPointsJson(out);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ id: 'netflix', title: 'Netflix', iconPath: '/a/big.png', removable: true });
    expect(pts[1]).toEqual({ id: 'com.dazn.ott.lg', title: 'DAZN', iconPath: '/b/dazn.png', removable: undefined });
  });
  it('JSON corrupto → lista vacía (el llamador lo trata como fallo)', () => {
    expect(parseLaunchPointsJson('{nope')).toEqual([]);
  });
});

describe('caché de iconos', () => {
  it('write conserva SOLO rutas aún instaladas', () => {
    const s = fakeStorage();
    writeIconCache(s, { '/a/keep.png': 'data:1', '/b/gone.png': 'data:2' }, ['/a/keep.png']);
    expect(readIconCache(s)).toEqual({ '/a/keep.png': 'data:1' });
  });
  it('JSON corrupto → caché vacía', () => {
    const s = fakeStorage();
    s.setItem(ICON_CACHE_KEY, '{{{');
    expect(readIconCache(s)).toEqual({});
  });
  it('valores no-string se descartan', () => {
    const s = fakeStorage();
    s.setItem(ICON_CACHE_KEY, JSON.stringify({ '/a.png': 'data:1', '/b.png': 42 }));
    expect(readIconCache(s)).toEqual({ '/a.png': 'data:1' });
  });
});

import { looksLikeImage, isReadableIconPath, clearIconCache, ICON_MAX_BYTES } from '../tools/tv-home/src/service/appexec';

describe('isReadableIconPath (appinfo no es de fiar)', () => {
  it('acepta iconos de raices de apps', () => {
    expect(isReadableIconPath('/media/developer/apps/usr/palm/applications/netflix/icon.png')).toBe(true);
    expect(isReadableIconPath('/usr/palm/applications/com.webos.app.home/largeIcon.PNG')).toBe(true);
    expect(isReadableIconPath('/mnt/lg/x.png')).toBe(false);
    expect(isReadableIconPath('/media/developer/x.png')).toBe(false);
  });
  it('rechaza traversal, raices ajenas y no imagenes', () => {
    for (const bad of [
      '/usr/palm/applications/x/../../../../etc/shadow.png', '/etc/shadow', '/root/.ssh/id_rsa',
      '/usr/palm/applications/x/secret.txt', '/media/developer/../../etc/passwd.png', '/tmp/a.png',
    ]) expect(isReadableIconPath(bad)).toBe(false);
  });
});

describe('limites', () => {
  it('parseIconOutput descarta iconos sobre el tope', () => {
    const big = 'A'.repeat(Math.ceil(ICON_MAX_BYTES / 3) * 4 + 4);
    expect(parseIconOutput(`0 ${big}\n1 iVBORw0KGgoA`, 2)).toEqual({ 1: 'data:image/png;base64,iVBORw0KGgoA' });
  });
  it('el script comprueba fichero y tamano antes de leer', () => {
    const s = buildIconScript(['/usr/palm/a/i.png']);
    expect(s).toContain('readlink -f');          // ruta canonica (symlinks resueltos)
    expect(s).toContain('exec 3<');              // se abre una vez
    expect(s).toContain('/proc/self/fd/3');      // y se recomprueba el fichero abierto (TOCTOU)
    expect(s).toContain(`head -c ${ICON_MAX_BYTES + 3}`); // tope de lectura
    expect(s).toContain('/usr/palm/applications/*'); // raices canonicas permitidas
  });
  it('clearIconCache borra la clave', () => {
    const st = fakeStorage(); st.setItem(ICON_CACHE_KEY, '{}');
    clearIconCache({ removeItem: (k: string) => void st.store.delete(k) });
    expect(st.store.has(ICON_CACHE_KEY)).toBe(false);
  });
});

describe('magic bytes', () => {
  it('descarta lo que no es imagen aunque se llame .png', () => {
    expect(looksLikeImage('iVBORw0KGgoAAAANS')).toBe(true);
    expect(looksLikeImage('/9j/4AAQ')).toBe(true);
    expect(looksLikeImage('c2VjcmV0Cg==')).toBe(false); // "secret\n"
    expect(parseIconOutput('0 c2VjcmV0Cg==\n1 iVBORw0KGgoAAAANS', 2)).toEqual({ 1: 'data:image/png;base64,iVBORw0KGgoAAAANS' });
  });
});
