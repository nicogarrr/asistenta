import { describe, expect, it, vi } from 'vitest';

// The file is downloaded fine; only the send to Telegram fails.
vi.mock('../src/media/download.js', () => ({
  downloadFromLink: async () => ({
    ok: true,
    kind: 'video',
    bytes: Buffer.alloc(1024),
    seconds: 3,
    title: 'Vídeo',
    filename: 'video.mp4',
  }),
}));

const { createDownloadTool } = await import('../src/tools/download.js');

async function sendFailing(error: Error): Promise<string> {
  const tool = createDownloadTool({
    sendVideo: async () => {
      throw error;
    },
    sendDocument: async () => true,
  });
  const result = await tool.execute(
    't',
    { url: 'https://example.org/v' },
    undefined as never,
    undefined as never,
  );
  return result.content.map((c) => ('text' in c ? c.text : '')).join('');
}

describe('download: a failed send to Telegram in plain Spanish', () => {
  it('a file too big says so, without the raw error', async () => {
    const text = await sendFailing(new Error('413: Request Entity Too Large'));
    expect(text).toContain('pesa demasiado para enviarlo por Telegram');
    expect(text).not.toMatch(/Request Entity|413/);
  });

  it('a network failure is a plain line', async () => {
    const text = await sendFailing(new Error('http transport error: fetch failed'));
    expect(text).toContain('Telegram no aceptó el envío: no hubo respuesta de Telegram');
    expect(text).not.toMatch(/http transport|fetch failed/);
  });

  it('a rate limit asks to wait', async () => {
    const text = await sendFailing(new Error('429: Too Many Requests: retry after 7'));
    expect(text).toContain('prueba otra vez en un minuto');
    expect(text).not.toMatch(/Too Many/);
  });
});
