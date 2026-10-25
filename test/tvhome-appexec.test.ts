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
    expect(script).toContain("base64 '/a/one.png'");
    expect(script).not.toContain('netflix');
  });
});

describe('parseIconOutput', () => {
  it('mapea por índice e ignora basura, fuera de rango y no-base64', () => {
    const out = '0 aGVsbG8=\nbasura sin sentido\n1 Y2hhdQ==\n7 ZnVl\n2 no-es-b64!!';
    const r = parseIconOutput(out, 2);
    expect(r[0]).toBe('data:image/png;base64,aGVsbG8=');
    expect(r[1]).toBe('data:image/png;base64,Y2hhdQ==');
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
