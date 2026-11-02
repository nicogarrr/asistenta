import { describe, expect, it } from 'vitest';
import { pdfToEpub } from '../src/books/convert.js';
import { AudioRecall } from '../src/media/recall.js';
import { createMediaTool } from '../src/tools/media.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// asis-bugs-20: el título que se pasa a Calibre (200) y la transcripción que la lista de
// audios enseña (80) se cortaban a ciegas; un emoji en el corte dejaba medio carácter
// (en el EPUB, «�» en el título del libro).
describe('libros y audios: cortes sin medio emoji', () => {
  it('título del libro para Calibre', async () => {
    let title = '';
    await pdfToEpub(
      Buffer.from('%PDF-1.4 fake'),
      `${'l'.repeat(199)}📚 tomo 2`,
      async (_cmd, args) => {
        title = args[args.indexOf('--title') + 1] ?? '';
        return { code: 1, stderr: 'fallo' };
      },
      'ebook-convert',
    );
    expect(title).toBe('l'.repeat(199));
  });

  it('lista de audios: transcripción larga', async () => {
    const CHAT = 'telegram:personal:1';
    const recall = new AudioRecall({});
    recall.record(CHAT, {
      fileId: 'F1',
      mimeType: 'audio/ogg',
      messageId: '10',
      transcript: `${'d'.repeat(79)}🎤 y más`,
    });
    const tool = createMediaTool({
      chatKey: CHAT,
      recall,
      downloadAudio: async () => null,
      chatId: '1',
      maxEdge: 1280,
      sendPhoto: async () => '1',
      sendVideo: async () => true,
      sendVoice: async () => true,
    });
    const r = await tool.execute('c', { action: 'list_audio' } as never);
    const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
    expect(text).toContain(`dijo: "${'d'.repeat(79)}"`);
    expect(text).not.toMatch(LONE);
  });
});
