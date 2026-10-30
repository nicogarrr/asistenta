import { describe, expect, it } from 'vitest';
import { downloadBook } from '../src/books/net.js';

/** A body of `chunks` × 1000 bytes with no Content-Length, counting how much was pulled. */
function endless(chunks: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(new Uint8Array(1000).fill(0x25));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, response: new Response(body, { status: 200 }) };
}

describe('books/net downloadBook: tope de tamaño sin Content-Length', () => {
  it('deja de leer en cuanto pasa del tope, sin cargar todo en memoria', async () => {
    const { state, response } = endless(500);
    await expect(
      downloadBook('https://www.gutenberg.org/x.epub', async () => response, 3000),
    ).rejects.toThrow(/supera 50 MB/);
    expect(state.pulled).toBeLessThan(10);
    expect(state.cancelled).toBe(true);
  });

  it('un archivo dentro del tope se descarga entero', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2500, 0x20)]);
    const res = new Response(new Blob([pdf]).stream(), { status: 200 });
    const out = await downloadBook('https://www.gutenberg.org/x.pdf', async () => res, 3000);
    expect(out.kind).toBe('pdf');
    expect(out.bytes.length).toBe(pdf.length);
  });

  it('Content-Length declarado por encima del tope se rechaza sin leer', async () => {
    const { state, response } = endless(5);
    const res = new Response(response.body, {
      status: 200,
      headers: { 'content-length': '999999' },
    });
    await expect(
      downloadBook('https://www.gutenberg.org/x.epub', async () => res, 3000),
    ).rejects.toThrow(/supera 50 MB/);
    expect(state.pulled).toBeLessThan(3);
  });
});
