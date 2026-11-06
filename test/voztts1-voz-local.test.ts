import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSherpaTts, type SherpaModulo } from '../src/voice/sherpa.js';
import type { Tts, TtsAudio } from '../src/voice/tts.js';
import {
  asegurarVozLocal,
  carpetaVozLocal,
  createTtsConVozLocal,
  type Extraer,
  REINTENTO_DESCARGA_MS,
  VOCES_LOCALES,
  type VozLocal,
  vozLocalDesdeEnv,
  vozLocalLista,
} from '../src/voice/voz-local.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const CONTENIDO = Buffer.from('archivo de voz de prueba '.repeat(400));

function voz(contenido = CONTENIDO): VozLocal {
  return {
    clave: 'prueba',
    id: 'vits-prueba',
    url: 'https://example.invalid/vits-prueba.tar.bz2',
    sha256: sha(contenido),
    bytes: contenido.length,
    onnx: 'prueba.onnx',
    sid: 0,
  };
}

const raices: string[] = [];
function raiz(): string {
  const r = mkdtempSync(join(tmpdir(), 'pa-voztts1-'));
  raices.push(r);
  return r;
}
afterEach(() => {
  vi.restoreAllMocks();
});

/** Lo que haría tar: deja la carpeta del modelo dentro del destino. */
const extraerFalso =
  (id = 'vits-prueba', onnx = 'prueba.onnx'): Extraer =>
  async (_archivo, destino) => {
    const dir = join(destino, id);
    mkdirSync(join(dir, 'espeak-ng-data'), { recursive: true });
    writeFileSync(join(dir, onnx), 'onnx');
    writeFileSync(join(dir, 'tokens.txt'), 'tokens');
  };

type Llamada = { url: string; range?: string };
function fetchFalso(
  responder: (llamada: Llamada) => Response | Promise<Response>,
): typeof fetch & { llamadas: Llamada[] } {
  const llamadas: Llamada[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const llamada = { url: String(url), range: headers.Range };
    llamadas.push(llamada);
    return responder(llamada);
  }) as typeof fetch & { llamadas: Llamada[] };
  f.llamadas = llamadas;
  return f;
}

const fake = (name: string, fail = false): Tts & { calls: number } => {
  const t = {
    name,
    calls: 0,
    async speak(): Promise<TtsAudio> {
      t.calls++;
      if (fail) throw new Error(`${name} roto`);
      return {
        durationSeconds: 1,
        data: Buffer.from(name),
        mimeType: 'audio/mpeg',
        format: 'mp3',
        text: 'x',
        truncated: false,
      };
    },
  };
  return t;
};

describe('asegurarVozLocal: descarga fijada y comprobada', () => {
  it('descarga, comprueba el SHA-256 y coloca el modelo de golpe', async () => {
    const r = raiz();
    const v = voz();
    const lineas: string[] = [];
    const f = fetchFalso(() => new Response(CONTENIDO, { status: 200 }));
    const lista = await asegurarVozLocal(r, v, {
      fetchImpl: f,
      extraer: extraerFalso(),
      progreso: (l) => lineas.push(l),
    });
    expect(f.llamadas).toEqual([{ url: v.url, range: undefined }]);
    expect(lista.dir).toBe(carpetaVozLocal(r, v));
    expect(readFileSync(join(lista.dir, '.ok'), 'utf8')).toBe(v.sha256);
    expect(existsSync(`${lista.dir}.tar.bz2.partial`)).toBe(false);
    expect(lineas[0]).toMatch(/descargando .* en segundo plano/);
    expect(lineas.at(-1)).toMatch(/lista/);
    expect(vozLocalLista(r, v)?.onnx).toBe(join(lista.dir, 'prueba.onnx'));
  });

  it('un SHA-256 distinto se rechaza: no se descomprime ni queda nada', async () => {
    const r = raiz();
    const v = voz();
    const otro = Buffer.alloc(CONTENIDO.length, 7);
    const extraer = vi.fn(extraerFalso());
    await expect(
      asegurarVozLocal(r, v, {
        fetchImpl: fetchFalso(() => new Response(otro, { status: 200 })),
        extraer,
        progreso: () => {},
      }),
    ).rejects.toThrow(/no coincide con la fijada/);
    expect(extraer).not.toHaveBeenCalled();
    expect(vozLocalLista(r, v)).toBeNull();
    expect(existsSync(carpetaVozLocal(r, v))).toBe(false);
    expect(existsSync(`${carpetaVozLocal(r, v)}.tar.bz2.partial`)).toBe(false);
  });

  it('reanuda una descarga a medias pidiendo solo lo que falta', async () => {
    const r = raiz();
    const v = voz();
    const mitad = Math.floor(CONTENIDO.length / 2);
    mkdirSync(join(r, 'tts'), { recursive: true });
    writeFileSync(`${carpetaVozLocal(r, v)}.tar.bz2.partial`, CONTENIDO.subarray(0, mitad));
    const f = fetchFalso(() => new Response(CONTENIDO.subarray(mitad), { status: 206 }));
    const lineas: string[] = [];
    await asegurarVozLocal(r, v, {
      fetchImpl: f,
      extraer: extraerFalso(),
      progreso: (l) => lineas.push(l),
    });
    expect(f.llamadas[0]?.range).toBe(`bytes=${mitad}-`);
    expect(lineas[0]).toMatch(/sigo la descarga/);
    expect(vozLocalLista(r, v)).not.toBeNull();
  });

  it('si el servidor no reanuda (200), empieza de cero sin mezclar trozos', async () => {
    const r = raiz();
    const v = voz();
    mkdirSync(join(r, 'tts'), { recursive: true });
    writeFileSync(`${carpetaVozLocal(r, v)}.tar.bz2.partial`, Buffer.alloc(100, 1));
    const f = fetchFalso(() => new Response(CONTENIDO, { status: 200 }));
    await asegurarVozLocal(r, v, { fetchImpl: f, extraer: extraerFalso(), progreso: () => {} });
    expect(f.llamadas[0]?.range).toBe('bytes=100-');
    expect(vozLocalLista(r, v)).not.toBeNull();
  });

  it('cambiar el modelo fijado obliga a bajarlo otra vez y borra el anterior', async () => {
    const r = raiz();
    const v1 = voz();
    const deps = { extraer: extraerFalso(), progreso: () => {} };
    await asegurarVozLocal(r, v1, {
      ...deps,
      fetchImpl: fetchFalso(() => new Response(CONTENIDO, { status: 200 })),
    });
    const nuevo = Buffer.from('otra versión del modelo '.repeat(300));
    const v2 = voz(nuevo);
    expect(vozLocalLista(r, v2)).toBeNull();
    const f = fetchFalso(() => new Response(nuevo, { status: 200 }));
    await asegurarVozLocal(r, v2, { ...deps, fetchImpl: f });
    expect(f.llamadas).toHaveLength(1);
    expect(vozLocalLista(r, v2)).not.toBeNull();
    expect(existsSync(carpetaVozLocal(r, v1))).toBe(false);
  });
});

describe('createTtsConVozLocal: nunca espera a la descarga', () => {
  it('mientras falta el modelo habla la voz de siempre y descarga una sola vez', async () => {
    const r = raiz();
    const respaldo = fake('sapi');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let soltar: (res: Response) => void = () => {};
    const f = fetchFalso(
      () =>
        new Promise<Response>((ok) => {
          soltar = ok;
        }),
    );
    const tts = createTtsConVozLocal(
      { PA_TTS_LOCAL: 'sharvard' },
      {
        respaldo,
        raiz: r,
        crearLocal: () => fake('local'),
        descarga: { fetchImpl: f, extraer: extraerFalso(), progreso: () => {} },
      },
    );
    expect((await tts.speak('hola')).data.toString()).toBe('sapi');
    expect((await tts.speak('otra')).data.toString()).toBe('sapi');
    expect(f.llamadas).toHaveLength(1);
    expect(f.llamadas[0]?.url).toBe(VOCES_LOCALES.sharvard?.url);
    soltar(new Response('corto', { status: 200 }));
    // La descarga en curso termina (aquí con un SHA-256 malo) y se descarta.
    expect(await tts.precargar()).toBe(false);
  });

  it('sin red: sigue con la voz de siempre y reintenta pasados 10 minutos', async () => {
    const r = raiz();
    let t = 1_000_000;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = fetchFalso(() => Promise.reject(new TypeError('fetch failed')));
    const tts = createTtsConVozLocal(
      { PA_TTS_LOCAL: 'davefx' },
      {
        respaldo: fake('sapi'),
        raiz: r,
        ahora: () => t,
        descarga: { fetchImpl: f, extraer: extraerFalso(), progreso: () => {} },
      },
    );
    expect(await tts.precargar()).toBe(false);
    expect((await tts.speak('hola')).data.toString()).toBe('sapi');
    expect(await tts.precargar()).toBe(false);
    expect(f.llamadas).toHaveLength(1);
    t += REINTENTO_DESCARGA_MS + 1;
    expect(await tts.precargar()).toBe(false);
    expect(f.llamadas).toHaveLength(2);
  });

  it('con el modelo listo usa la voz local; si falla, la de siempre, y tras 3 fallos la deja', async () => {
    const r = raiz();
    const v = VOCES_LOCALES.sharvard as VozLocal;
    // Coloca el modelo como si ya se hubiera descargado.
    const dir = carpetaVozLocal(r, v);
    mkdirSync(join(dir, 'espeak-ng-data'), { recursive: true });
    writeFileSync(join(dir, v.onnx), 'onnx');
    writeFileSync(join(dir, 'tokens.txt'), 't');
    writeFileSync(join(dir, '.ok'), v.sha256);
    const f = fetchFalso(() => new Response('x', { status: 500 }));
    const bien = createTtsConVozLocal(
      { PA_TTS_LOCAL: 'sharvard' },
      {
        respaldo: fake('sapi'),
        raiz: r,
        plataforma: 'win32',
        crearLocal: () => fake('local'),
        descarga: { fetchImpl: f },
      },
    );
    expect(await bien.precargar()).toBe(true);
    expect((await bien.speak('hola')).data.toString()).toBe('local');
    expect(f.llamadas).toHaveLength(0);

    const roto = fake('local', true);
    const respaldo = fake('sapi');
    const onFallback = vi.fn();
    const mal = createTtsConVozLocal(
      { PA_TTS_LOCAL: 'sharvard' },
      { respaldo, raiz: r, plataforma: 'win32', crearLocal: () => roto, onFallback },
    );
    for (let i = 0; i < 4; i++) expect((await mal.speak('hola')).data.toString()).toBe('sapi');
    expect(roto.calls).toBe(3);
    expect(onFallback).toHaveBeenCalledTimes(3);
  });

  it('apagada (off, PA_TTS=sapi/piper o fuera de Windows sin pedirla) es la voz de siempre tal cual', async () => {
    const f = fetchFalso(() => new Response('x'));
    for (const env of [{ PA_TTS_LOCAL: 'off' }, { PA_TTS: 'sapi' }, { PA_TTS: 'piper' }, {}]) {
      const tts = createTtsConVozLocal(env, {
        respaldo: fake('sapi'),
        raiz: raiz(),
        plataforma: 'linux',
        descarga: { fetchImpl: f },
      });
      expect(tts.name).toBe('sapi');
      expect((await tts.speak('hola')).data.toString()).toBe('sapi');
      expect(await tts.precargar()).toBe(false);
    }
    expect(f.llamadas).toHaveLength(0);
  });
});

describe('vozLocalDesdeEnv', () => {
  it('supertonic-f2 por defecto en Windows; davefx si se pide; desconocida = la de por defecto', () => {
    expect(vozLocalDesdeEnv({}, 'win32')?.clave).toBe('supertonic-f2');
    expect(vozLocalDesdeEnv({ PA_TTS_LOCAL: 'DaveFX' }, 'win32')?.clave).toBe('davefx');
    expect(vozLocalDesdeEnv({ PA_TTS_LOCAL: 'rara' }, 'win32')?.clave).toBe('supertonic-f2');
    expect(vozLocalDesdeEnv({}, 'linux')).toBeNull();
    expect(vozLocalDesdeEnv({ PA_TTS_LOCAL: 'sharvard' }, 'linux')?.clave).toBe('sharvard');
    expect(vozLocalDesdeEnv({ PA_TTS_LOCAL: 'off' }, 'win32')).toBeNull();
    expect(vozLocalDesdeEnv({ PA_TTS: 'piper' }, 'win32')).toBeNull();
  });

  it('solo voces castellanas, fijadas a la release oficial con SHA-256, y el paquete a una versión exacta', () => {
    expect(Object.keys(VOCES_LOCALES).sort()).toEqual([
      'davefx',
      'kokoro',
      'kokoro-alex',
      'kokoro-santa',
      'sharvard',
      'supertonic',
      'supertonic-f2',
      'supertonic-f5',
    ]);
    for (const v of Object.values(VOCES_LOCALES)) {
      expect(v.url).toMatch(
        /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/tts-models\//,
      );
      expect(v.url.endsWith(`/${v.id}.tar.bz2`)).toBe(true);
      expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies['sherpa-onnx-node']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('createSherpaTts (módulo nativo falso)', () => {
  const modelo = { onnx: '/m/v.onnx', tokens: '/m/tokens.txt', datos: '/m/espeak-ng-data' };

  it('carga el modelo una vez y devuelve audio', async () => {
    const configs: unknown[] = [];
    const generateAsync = vi.fn(async (_req: { text: string; sid: number }) => ({
      samples: new Float32Array(2205).fill(0.1),
      sampleRate: 22050,
    }));
    const cargar = (): SherpaModulo => ({
      OfflineTts: {
        createAsync: async (c: unknown) => {
          configs.push(c);
          return { generateAsync };
        },
      },
    });
    const tts = createSherpaTts({ modelo, cargar, hilos: 2, sid: 1 });
    const audio = await tts.speak('  Hola,\n Nico.  ');
    await tts.speak('otra');
    expect(configs).toEqual([
      {
        model: {
          vits: { model: modelo.onnx, tokens: modelo.tokens, dataDir: modelo.datos },
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
        maxNumSentences: 1,
      },
    ]);
    expect(generateAsync.mock.calls[0]?.[0]).toMatchObject({ text: 'Hola, Nico.', sid: 1 });
    expect(audio.format).toBe('mp3');
    expect(audio.durationSeconds).toBeCloseTo(0.1, 2);
  });

  it('si el módulo no carga, falla claro y la siguiente frase lo reintenta', async () => {
    let intentos = 0;
    const cargar = (): SherpaModulo => {
      intentos++;
      throw new Error('Cannot find module sherpa-onnx-node');
    };
    const tts = createSherpaTts({ modelo, cargar, hilos: 1 });
    await expect(tts.speak('hola')).rejects.toThrow(/la voz local fallo: Cannot find module/);
    await expect(tts.speak('hola')).rejects.toThrow();
    expect(intentos).toBe(2);
  });

  it('cancelar corta la síntesis en curso', async () => {
    const ctl = new AbortController();
    let progreso: number | undefined;
    const cargar = (): SherpaModulo => ({
      OfflineTts: {
        createAsync: async () => ({
          generateAsync: async (req) => {
            ctl.abort();
            progreso = req.onProgress?.({ samples: new Float32Array(1), progress: 0.5 });
            return { samples: new Float32Array(10), sampleRate: 22050 };
          },
        }),
      },
    });
    const tts = createSherpaTts({ modelo, cargar, hilos: 1 });
    await expect(tts.speak('hola', { signal: ctl.signal })).rejects.toThrow(/cancelo/);
    expect(progreso).toBe(0);
  });
});
