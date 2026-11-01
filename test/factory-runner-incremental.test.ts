// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que runner.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The parent side of the factory sandbox measures the collected output
 * incrementally (bytes as they arrive), not by re-measuring everything
 * collected so far on every chunk, and decodes UTF-8 across chunk boundaries.
 */
void FACTORY_TEST_STATE_DIR;
const store = await import('../src/factory/store.js');
const runner = await import('../src/factory/runner.js');

const HEAD =
  "export const name='t'; export const description='d'; export const parameters={type:'object'};";

function install(id: string, body: string): void {
  const code = `${HEAD}\n${body}`;
  const now = new Date().toISOString();
  store.writeFactoryTool(
    {
      id,
      name: id,
      description: 'd',
      whenToUse: 'w',
      version: 1,
      status: 'built',
      createdAt: now,
      updatedAt: now,
      codeSha256: store.sha256(code),
      testedSha256: null,
      lastTestAt: null,
      lastTestOk: false,
      contract: null,
    },
    code,
    '',
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('factory runner: incremental output accounting', () => {
  it('does not re-measure all collected output on every chunk', async () => {
    // ~400 KB of multi-byte output arriving in many pipe chunks, then hang.
    install(
      'log-many-chunks',
      "export async function run(){ for (let i = 0; i < 200; i++) console.log('\u00e1'.repeat(1000)); await new Promise(()=>{}); }",
    );
    let measured = 0;
    const real = Buffer.byteLength.bind(Buffer);
    vi.spyOn(Buffer, 'byteLength').mockImplementation(((s: string, enc?: BufferEncoding) => {
      if (typeof s === 'string') measured += s.length;
      return real(s, enc);
    }) as typeof Buffer.byteLength);
    const r = await runner.runFactoryToolSandboxed('log-many-chunks', {}, { timeoutMs: 3_000 });
    expect(r.stage).toBe('timeout');
    // Linear accounting measures each byte at most once; the old loop measured
    // the whole accumulated string again on every chunk (quadratic).
    expect(measured).toBeLessThan(450_000);
  }, 30_000);

  it('counts bytes, not characters, and keeps a character split across chunks intact', () => {
    const c = runner.createOutputCollector(10);
    const a = Buffer.from('\u00e1\u00e1\u00e1'); // 6 bytes, 3 chars
    expect(c.push(a.subarray(0, 3))).toBe(false); // splits the 2nd «á»
    expect(c.push(a.subarray(3))).toBe(false);
    expect(c.text()).toBe('\u00e1\u00e1\u00e1');
    expect(c.bytes).toBe(6);
    expect(c.push(Buffer.from('\u00f1\u00f1\u00f1'))).toBe(true); // 12 bytes > 10
    expect(c.text()).not.toContain('\ufffd');
  });

  it('keeps separate decoders per stream so stdout and stderr chunks do not corrupt each other', () => {
    const c = runner.createOutputCollector(1000);
    const a = Buffer.from('\u00e1');
    const out = c.stream();
    const err = c.stream();
    out(a.subarray(0, 1));
    err(Buffer.from('x'));
    out(a.subarray(1));
    expect(c.text()).toBe('x\u00e1');
  });
});
