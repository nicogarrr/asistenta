/**
 * S5 semantic recall: hybrid lexical+embedding ranking. The embedder is always
 * a fake here — the local model is verified on the PC, not in CI.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearEmbedCache,
  cosine,
  createLocalEmbedder,
  type Embedder,
  hybridRank,
  semanticFromEnv,
} from '../src/memory/semantic.js';

/** Vectors chosen by hand: `near` points like the query, `far` does not. */
function fakeEmbedder(map: Record<string, number[]>): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    embed: async (texts) => {
      calls.push([...texts]);
      return texts.map((t) => {
        const v = map[t];
        if (!v) throw new Error(`texto inesperado: ${t}`);
        return v;
      });
    },
  };
}

beforeEach(() => clearEmbedCache());

describe('cosine', () => {
  it('identical vectors score 1, orthogonal 0', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('hybridRank', () => {
  it('rescues a paraphrase the lexical scorer misses', async () => {
    // Query about "tren"; entry A paraphrases (lexical 0, coseno ~1), entry B
    // repeats a token but is semantically off. Semantic weight must win.
    const emb = fakeEmbedder({
      'cuando sale el tren': [1, 0],
      'el AVE a Madrid sale a las 9': [1, 0],
      'tren de mercancias descarrilo en 1984': [0, 1],
    });
    const items = [
      { text: 'el AVE a Madrid sale a las 9', tags: [] },
      { text: 'tren de mercancias descarrilo en 1984', tags: [] },
    ];
    const hits = await hybridRank({
      query: 'cuando sale el tren',
      items,
      text: (e) => e.text,
      lexical: (e, q) => (e.text.includes(q.split(' ').at(-1) ?? '') ? 1 : 0), // 'tren'
      embedder: emb,
      limit: 10,
    });
    expect(hits[0]?.text).toBe('el AVE a Madrid sale a las 9');
  });

  it('keeps a pure lexical hit when all cosines are 0', async () => {
    const emb = fakeEmbedder({ q: [1, 0], alfa: [0, 1], beta: [0, 1] });
    const hits = await hybridRank({
      query: 'q',
      items: [{ text: 'beta' }, { text: 'alfa' }],
      text: (e) => e.text,
      lexical: (e) => (e.text === 'beta' ? 4 : 0),
      embedder: emb,
      limit: 10,
    });
    expect(hits.map((h) => h.text)).toEqual(['beta']);
  });

  it('returns [] for no items and respects limit', async () => {
    const emb = fakeEmbedder({});
    expect(
      await hybridRank({
        query: 'q',
        items: [],
        text: (e: string) => e,
        lexical: () => 1,
        embedder: emb,
        limit: 5,
      }),
    ).toEqual([]);
  });

  it('drops items scoring 0 even with a positive cosine floor of 0', async () => {
    const emb = fakeEmbedder({ q: [1, 0], nada: [-1, 0] });
    const hits = await hybridRank({
      query: 'q',
      items: [{ text: 'nada' }],
      text: (e) => e.text,
      lexical: () => 0,
      embedder: emb,
      limit: 10,
    });
    expect(hits).toEqual([]);
  });

  it('caches vectors: a repeated text is not embedded twice', async () => {
    const emb = fakeEmbedder({ q: [1, 0], a: [1, 0] });
    const run = () =>
      hybridRank({
        query: 'q',
        items: [{ text: 'a' }],
        text: (e) => e.text,
        lexical: () => 1,
        embedder: emb,
        limit: 5,
      });
    await run();
    await run();
    expect(emb.calls).toEqual([['q', 'a']]);
  });
});

describe('createLocalEmbedder / semanticFromEnv', () => {
  it('stays disabled without PA_SEMANTIC_RECALL=1', () => {
    expect(semanticFromEnv('/tmp/models', {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      semanticFromEnv('/tmp/models', { PA_SEMANTIC_RECALL: '1' } as NodeJS.ProcessEnv),
    ).toBeDefined();
  });

  it('createLocalEmbedder defers the heavy import until first embed', () => {
    const emb = createLocalEmbedder('/tmp/models');
    expect(typeof emb.embed).toBe('function');
  });
});
