/**
 * Catálogo de skills: parser estricto, merge con lo instalado y descarga con
 * fetch inyectado. Ningún test toca la red real.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../src/skills/catalog.js';
import {
  BUILTIN_CATALOG,
  catalogFromInstalled,
  fetchCatalog,
  mergeCatalog,
  parseCatalog,
} from '../src/skills/catalog.js';

const VALID_ENTRY: CatalogEntry = {
  id: 'resumen-de-email',
  name: 'Resumen de email',
  description: 'Resume los correos sin leer',
  url: 'https://example.com/skills/resumen-de-email/SKILL.md',
  tags: ['email', 'resumen'],
  source: 'url',
};

function catalogJson(skills: unknown[]): string {
  return JSON.stringify({ skills });
}

function responseOf(body: string, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return handler(String(input), init ?? {});
  }) as unknown as typeof fetch;
}

describe('parseCatalog', () => {
  it('acepta un catálogo válido, normaliza los campos e infiere source', () => {
    const parsed = parseCatalog(
      catalogJson([
        { ...VALID_ENTRY, name: '  Resumen   de email ', tags: [' email ', 'email', 7] },
        {
          id: 'receta-local',
          name: 'Receta local',
          description: 'Sin source explícito',
          url: 'https://github.com/acme/skills',
        },
        {
          id: 'otra',
          name: 'Otra',
          description: 'Enlace genérico',
          url: 'https://example.com/otra',
        },
      ]),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    expect(parsed.entries).toEqual([
      { ...VALID_ENTRY, name: 'Resumen de email', tags: ['email'] },
      {
        id: 'receta-local',
        name: 'Receta local',
        description: 'Sin source explícito',
        url: 'https://github.com/acme/skills',
        source: 'github',
      },
      {
        id: 'otra',
        name: 'Otra',
        description: 'Enlace genérico',
        url: 'https://example.com/otra',
        source: 'url',
      },
    ]);
  });

  it('rechaza JSON roto, raíz que no es objeto o falta de skills', () => {
    const empty = parseCatalog('');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toMatch(/vacío/);

    const broken = parseCatalog('{no es json');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toMatch(/formato/);

    const notObject = parseCatalog('[]');
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.reason).toMatch(/formato/);

    const noSkills = parseCatalog('{}');
    expect(noSkills.ok).toBe(false);
    if (!noSkills.ok) expect(noSkills.reason).toMatch(/skills/);

    const wrongSkills = parseCatalog('{"skills":{}}');
    expect(wrongSkills.ok).toBe(false);
    if (!wrongSkills.ok) expect(wrongSkills.reason).toMatch(/skills/);
  });

  it('salta entradas inválidas o duplicadas y las cuenta en skipped', () => {
    const parsed = parseCatalog(
      catalogJson([
        { ...VALID_ENTRY, id: 'valida', name: 'Valida' },
        { ...VALID_ENTRY, id: 'MAL' },
        { ...VALID_ENTRY, id: 'http', url: 'http://example.com/SKILL.md' },
        { ...VALID_ENTRY, id: 'sin-descripcion', description: '  ' },
        { ...VALID_ENTRY, id: 'sin-source', source: 'tienda' },
        { ...VALID_ENTRY, id: 'tags-rotos', tags: 'email' },
        'no soy un objeto',
        { ...VALID_ENTRY, id: 'dup', name: 'Dup uno' },
        { ...VALID_ENTRY, id: 'dup', name: 'Dup dos' },
      ]),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map((entry) => entry.id)).toEqual(['valida', 'dup']);
    expect(parsed.entries[0]?.name).toBe('Valida');
    expect(parsed.skipped).toBe(7);
  });

  it('limita el catálogo a 200 entradas', () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      ...VALID_ENTRY,
      id: `skill-${index}`,
    }));

    const tooMany = parseCatalog(catalogJson(many));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason).toMatch(/200|máximo/);

    const exactly = parseCatalog(catalogJson(many.slice(0, 200)));
    expect(exactly.ok).toBe(true);
    if (exactly.ok) expect(exactly.entries).toHaveLength(200);
  });
});

describe('BUILTIN_CATALOG', () => {
  it('parsea sin descartes y trae las skills de ejemplo con https y tags', () => {
    const parsed = parseCatalog(BUILTIN_CATALOG);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(3);
    expect(parsed.entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'resumen-de-email',
        'buscar-en-web',
        'organizar-descargas',
        'revisar-precios',
      ]),
    );
    for (const entry of parsed.entries) {
      expect(entry.url.startsWith('https://')).toBe(true);
      expect(entry.tags?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('mergeCatalog', () => {
  it('marca installed sin mutar las entradas originales', () => {
    const first = { ...VALID_ENTRY, id: 'uno' };
    const second = { ...VALID_ENTRY, id: 'dos', name: 'Dos' };

    const merged = mergeCatalog([first, second], ['dos']);

    expect(merged).toEqual([
      { ...first, installed: false },
      { ...second, installed: true },
    ]);
    expect(Object.hasOwn(first, 'installed')).toBe(false);
  });
});

describe('catalogFromInstalled', () => {
  it('crea entradas locales sin red ni URL inventada', () => {
    const entries = catalogFromInstalled([
      { id: 'uno', name: ' Uno ' },
      { id: 'dos', name: 'Dos', description: ' Dos cosas ' },
    ]);

    expect(entries).toEqual([
      { id: 'uno', name: 'Uno', description: '', url: '', source: 'local' },
      { id: 'dos', name: 'Dos', description: 'Dos cosas', url: '', source: 'local' },
    ]);
    expect(mergeCatalog(entries, ['uno']).map((entry) => entry.installed)).toEqual([true, false]);
  });
});

describe('fetchCatalog', () => {
  it('descarga un catálogo https, lo parsea y pide redirección manual', async () => {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, redirect: init.redirect });
      return responseOf(BUILTIN_CATALOG, { headers: { 'content-type': 'application/json' } });
    });

    const result = await fetchCatalog('https://example.com/catalog.json', { fetchImpl });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries.length).toBeGreaterThanOrEqual(3);
    expect(calls).toEqual([{ url: 'https://example.com/catalog.json', redirect: 'manual' }]);
  });

  it('rechaza http sin llamar a fetch', async () => {
    let called = false;
    const fetchImpl = fakeFetch(() => {
      called = true;
      return responseOf(BUILTIN_CATALOG);
    });

    const result = await fetchCatalog('http://example.com/catalog.json', { fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/https/);
    expect(called).toBe(false);
  });

  it('sigue redirecciones https y rechaza un salto a http', async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      calls.push(url);
      return calls.length === 1
        ? responseOf('', { status: 302, headers: { location: '/catalogo.json' } })
        : responseOf(BUILTIN_CATALOG);
    });

    const result = await fetchCatalog('https://example.com/a/catalog.json', { fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      'https://example.com/a/catalog.json',
      'https://example.com/catalogo.json',
    ]);

    const toHttp = fakeFetch(() =>
      responseOf('', { status: 301, headers: { location: 'http://example.com/catalog.json' } }),
    );
    const rejected = await fetchCatalog('https://example.com/catalog.json', { fetchImpl: toHttp });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toMatch(/https/);
  });

  it('corta después de dos redirecciones', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(() => {
      calls++;
      return responseOf('', { status: 307, headers: { location: 'https://example.com/loop' } });
    });

    const result = await fetchCatalog('https://example.com/catalog.json', { fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/redirecciones/);
    expect(calls).toBe(3);
  });

  it('aplica el timeout y no lanza', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('abortado')));
      })) as unknown as typeof fetch;

    const result = await fetchCatalog('https://example.com/catalog.json', {
      fetchImpl,
      timeoutMs: 25,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/tardado demasiado/);
  });

  it('corta por tamaño y convierte errores de formato, estado o URL en reason', async () => {
    const oversize = fakeFetch(() =>
      responseOf('x'.repeat(500), { headers: { 'content-type': 'application/json' } }),
    );
    const tooBig = await fetchCatalog('https://example.com/catalog.json', {
      fetchImpl: oversize,
      maxBytes: 100,
    });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.reason).toMatch(/demasiado grande/);

    const broken = fakeFetch(() => responseOf('no es json'));
    const bad = await fetchCatalog('https://example.com/catalog.json', { fetchImpl: broken });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/formato/);

    const failing = fakeFetch(() => responseOf('no', { status: 500 }));
    const failed = await fetchCatalog('https://example.com/catalog.json', { fetchImpl: failing });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toMatch(/500/);

    const invalid = await fetchCatalog('no-es-una-url', { fetchImpl: broken });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toMatch(/enlace/);
  });
});
