import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildIconScript,
  ICON_CACHE_KEY,
  parseIconOutput,
  parseLaunchPointsJson,
  readIconCache,
  SAFE_PATH,
  shellQuote,
  writeIconCache,
} from '../tools/tv-home/src/service/appexec.js';

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

describe('SAFE_PATH (defensa inyección shell)', () => {
  it('acepta rutas típicas de iconos webOS', () => {
    expect(SAFE_PATH.test('/media/developer/apps/usr/palm/applications/netflix/icon.png')).toBe(
      true,
    );
    expect(SAFE_PATH.test('/usr/palm/applications/com.webos.app.home/largeIcon.png')).toBe(true);
    expect(
      SAFE_PATH.test('/media/cryptofs/apps/usr/palm/applications/com.wbd.stream/icon@2x.png'),
    ).toBe(true);
  });
  it('rechaza espacios, comillas, metacaracteres, relativas y comandos', () => {
    for (const bad of [
      '/tmp/a b.png',
      "/tmp/a'b.png",
      '/tmp/a"b.png',
      '/tmp/a;rm -rf /',
      '/tmp/$(id).png',
      '/tmp/`id`.png',
      'tmp/a.png',
      '/tmp/a\nb.png',
      '/tmp/a|b.png',
      '/tmp/a>b.png',
      '',
    ])
      expect(SAFE_PATH.test(bad)).toBe(false);
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
    const out = JSON.stringify({
      launchPoints: [
        {
          id: 'netflix',
          title: 'Netflix',
          largeIcon: '/a/big.png',
          icon: '/a/small.png',
          removable: true,
        },
        { id: 'sin-titulo' },
        { title: 'sin-id' },
        { id: 'com.dazn.ott.lg', title: 'DAZN', icon: '/b/dazn.png' },
      ],
    });
    const pts = parseLaunchPointsJson(out);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({
      id: 'netflix',
      title: 'Netflix',
      iconPath: '/a/big.png',
      removable: true,
    });
    expect(pts[1]).toEqual({
      id: 'com.dazn.ott.lg',
      title: 'DAZN',
      iconPath: '/b/dazn.png',
      removable: undefined,
    });
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

import {
  clearIconCache,
  decodedLength,
  ICON_MAX_BYTES,
  ICON_MAX_COUNT,
  ICON_OUTPUT_MAX_CHARS,
  ICON_TOTAL_MAX_BYTES,
  isReadableIconPath,
  looksLikeImage,
} from '../tools/tv-home/src/service/appexec.js';

describe('isReadableIconPath (appinfo no es de fiar)', () => {
  it('acepta iconos de raices de apps', () => {
    expect(isReadableIconPath('/media/developer/apps/usr/palm/applications/netflix/icon.png')).toBe(
      true,
    );
    expect(isReadableIconPath('/usr/palm/applications/com.webos.app.home/largeIcon.PNG')).toBe(
      true,
    );
    expect(isReadableIconPath('/mnt/lg/x.png')).toBe(false);
    expect(isReadableIconPath('/media/developer/x.png')).toBe(false);
  });
  it('rechaza traversal, raices ajenas y no imagenes', () => {
    for (const bad of [
      '/usr/palm/applications/x/../../../../etc/shadow.png',
      '/etc/shadow',
      '/root/.ssh/id_rsa',
      '/usr/palm/applications/x/secret.txt',
      '/media/developer/../../etc/passwd.png',
      '/tmp/a.png',
    ])
      expect(isReadableIconPath(bad)).toBe(false);
  });
});

describe('limites', () => {
  it('parseIconOutput descarta iconos sobre el tope', () => {
    const big = 'A'.repeat(Math.ceil(ICON_MAX_BYTES / 3) * 4 + 4);
    expect(parseIconOutput(`0 ${big}\n1 iVBORw0KGgoA`, 2)).toEqual({
      1: 'data:image/png;base64,iVBORw0KGgoA',
    });
  });
  it('el script comprueba fichero y tamano antes de leer', () => {
    const s = buildIconScript(['/usr/palm/a/i.png']);
    expect(s).toContain('readlink -f'); // ruta canonica (symlinks resueltos)
    expect(s).toContain('exec 3<'); // se abre una vez
    expect(s).toContain('/proc/self/fd/3'); // y se recomprueba el fichero abierto (TOCTOU)
    expect(s).toContain(`head -c ${ICON_MAX_BYTES + 1}`); // tope de lectura
    expect(s).toContain('/usr/palm/applications/*'); // raices canonicas permitidas
  });
  it('clearIconCache borra la clave', () => {
    const st = fakeStorage();
    st.setItem(ICON_CACHE_KEY, '{}');
    clearIconCache({ removeItem: (k: string) => void st.store.delete(k) });
    expect(st.store.has(ICON_CACHE_KEY)).toBe(false);
  });
});

describe('magic bytes', () => {
  it('descarta lo que no es imagen aunque se llame .png', () => {
    expect(looksLikeImage('iVBORw0KGgoAAAAN')).toBe(true);
    expect(looksLikeImage('/9j/4AAQ')).toBe(true);
    expect(looksLikeImage('c2VjcmV0Cg==')).toBe(false); // "secret\n"
    expect(parseIconOutput('0 c2VjcmV0Cg==\n1 iVBORw0KGgoAAAAN', 2)).toEqual({
      1: 'data:image/png;base64,iVBORw0KGgoAAAAN',
    });
  });
});

describe('tamano exacto y presupuesto (script real en sh)', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mk = (n: number) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, n - PNG.length), 7)]);
  const shells = ['/bin/sh', '/usr/bin/dash', '/usr/bin/busybox'].filter(
    (s) => spawnSync(s, s.endsWith('busybox') ? ['sh', '-c', 'true'] : ['-c', 'true']).status === 0,
  );
  const run = (sh: string, script: string) => {
    const r = spawnSync(sh, sh.endsWith('busybox') ? ['sh', '-c', script] : ['-c', script], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return r.stdout;
  };
  const withDir = (fn: (dir: string, root: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'icons-'));
    const root = join(dir, 'apps') + '/';
    mkdirSync(root);
    try {
      fn(dir, root);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // En Windows no hay /bin/sh (y el target de la TV sí es POSIX): el test de
  // "hay shell" solo tiene sentido donde existe, y los de script real se saltan.
  it.skipIf(process.platform === 'win32')('hay al menos una shell para probar', () => {
    expect(shells.length).toBeGreaterThan(0);
  });

  it('decodedLength: exacto con y sin relleno', () => {
    expect(decodedLength('QUJD')).toBe(3);
    expect(decodedLength('QUI=')).toBe(2);
    expect(decodedLength('QQ==')).toBe(1);
    expect(decodedLength('QUJ')).toBe(-1);
    expect(decodedLength('QQ=A')).toBe(-1);
    expect(decodedLength('')).toBe(-1);
    expect(decodedLength(Buffer.alloc(ICON_MAX_BYTES + 1).toString('base64'))).toBe(
      ICON_MAX_BYTES + 1,
    );
  });

  for (const sh of shells) {
    it(`bordes de tamano en ${sh}: tope, +1, +2, +3 y mucho mayor`, () =>
      withDir((_dir, root) => {
        const sizes = [
          ICON_MAX_BYTES - 1,
          ICON_MAX_BYTES,
          ICON_MAX_BYTES + 1,
          ICON_MAX_BYTES + 2,
          ICON_MAX_BYTES + 3,
          ICON_MAX_BYTES * 3,
        ];
        const paths = sizes.map((n, i) => {
          const p = join(root, `i${i}.png`);
          writeFileSync(p, mk(n));
          return p;
        });
        const out = run(sh, buildIconScript(paths, [root]));
        const parsed = parseIconOutput(out, paths.length);
        expect(Object.keys(parsed).map(Number).sort()).toEqual([0, 1]); // solo <= tope exacto
        const first = parsed[1] ?? '';
        expect(decodedLength(first.replace('data:image/png;base64,', ''))).toBe(ICON_MAX_BYTES);
        // el script ya los descarta aunque el parser no existiera
        const raw = out
          .split('\n')
          .filter((l) => /^\d+ \S+$/.test(l))
          .map((l) => Number(l.split(' ')[0]));
        expect(raw).toEqual([0, 1]);
      }));

    it(`muchos iconos en ${sh}: tope por comando y presupuesto agregado, salida acotada`, () =>
      withDir((_dir, root) => {
        const paths = Array.from({ length: 40 }, (_, i) => {
          const p = join(root, `m${i}.png`);
          writeFileSync(p, mk(200_000));
          return p;
        });
        const script = buildIconScript(paths, [root]);
        const out = run(sh, script);
        const parsed = parseIconOutput(out, paths.length);
        const n = Object.keys(parsed).length;
        expect(n).toBeLessThanOrEqual(ICON_MAX_COUNT);
        const bytes = (Object.values(parsed) as string[]).reduce(
          (s, v) => s + decodedLength(v.replace('data:image/png;base64,', '')),
          0,
        );
        expect(bytes).toBeLessThanOrEqual(ICON_TOTAL_MAX_BYTES);
        expect(n).toBeGreaterThan(0); // degrada: algunos si, el resto monograma
        expect(out.length).toBeLessThanOrEqual(ICON_OUTPUT_MAX_CHARS); // salida del shell acotada
      }));

    it(`symlinks y rutas fuera de raiz siguen descartados en ${sh}`, () =>
      withDir((dir, root) => {
        const secret = join(dir, 'secret.png');
        writeFileSync(secret, mk(1000));
        symlinkSync(secret, join(root, 'link.png'));
        const ok = join(root, 'ok.png');
        writeFileSync(ok, mk(1000));
        const out = run(sh, buildIconScript([join(root, 'link.png'), ok], [root]));
        expect(Object.keys(parseIconOutput(out, 2)).map(Number)).toEqual([1]);
      }));
  }

  it('parseIconOutput: presupuesto agregado, indices repetidos y exceso de lineas', () => {
    const one = Buffer.concat([PNG, Buffer.alloc(300_000 - PNG.length)])
      .toString('base64')
      .slice(0, 0); // (no usado)
    const ok = (n: number) => mk(n).toString('base64');
    const lines = Array.from({ length: 10 }, (_, i) => `${i} ${ok(250_000)}`).join('\n');
    const parsed = parseIconOutput(lines, 10);
    expect(Object.keys(parsed).length).toBe(Math.floor(ICON_TOTAL_MAX_BYTES / 250_000));
    expect(parseIconOutput(`0 ${ok(1000)}\n0 ${ok(2000)}`, 1)[0]).toContain(ok(1000).slice(0, 20));
    expect(
      Object.keys(
        parseIconOutput(Array.from({ length: 50 }, (_, i) => `${i} ${ok(100)}`).join('\n'), 50),
      ).length,
    ).toBeLessThanOrEqual(ICON_MAX_COUNT);
    expect(one).toBe('');
  });
  it('exceso de bytes exacto en parseIconOutput (+1)', () => {
    const exact = mk(ICON_MAX_BYTES).toString('base64');
    const over = mk(ICON_MAX_BYTES + 1).toString('base64');
    expect(Object.keys(parseIconOutput(`0 ${exact}\n1 ${over}`, 2))).toEqual(['0']);
  });
});
