import { describe, expect, it } from 'vitest';
import { createBrowserTool } from '../src/tools/browser.js';

const PNG = Buffer.from('png-bytes').toString('base64');
const service = { screenshot: async () => ({ mimeType: 'image/png', data: PNG }) };

async function run(sendImage: ((png: Buffer) => Promise<boolean>) | undefined, send: boolean) {
  const tool = createBrowserTool(service as never, () => 'chat', sendImage);
  const res = await tool.execute('id', { action: 'screenshot', send } as never);
  return (res.content[0] as { text: string }).text;
}

describe('browser screenshot send', () => {
  it('con send envía la imagen del navegador al chat y lo dice', async () => {
    const got: { png?: Buffer } = {};
    const text = await run(async (png) => {
      got.png = png;
      return true;
    }, true);
    expect(got.png?.toString()).toBe('png-bytes');
    expect(text).toContain('Enviada al usuario');
  });

  it('sin send no envía nada', async () => {
    let called = false;
    const text = await run(async () => {
      called = true;
      return true;
    }, false);
    expect(called).toBe(false);
    expect(text).not.toContain('Enviada');
  });

  it('si el envío falla lo reporta como error, no como éxito', async () => {
    const text = await run(async () => {
      throw new Error('telegram caído');
    }, true);
    expect(text).toContain('ERROR');
    expect(text).not.toContain('Enviada');
  });

  it('sin canal de imágenes avisa', async () => {
    expect(await run(undefined, true)).toContain('no admite imágenes');
  });
});
