import { describe, expect, it } from 'vitest';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
// A public IP literal skips DNS, so this never touches the network.
const URL = 'https://1.1.1.1/media/track';
type RunResult = { stdout: string; stderr: string; code: number | 'ENOENT' };
type RunFn = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;

const fakeRun =
  (title: string): RunFn =>
  async (_file, args) => {
    if (args[0] === '--list-impersonate-targets') return { stdout: '', stderr: '', code: 0 };
    const out = args[args.indexOf('-o') + 1];
    if (!out) throw new Error('args sin -o');
    const path = out.replace('%(ext)s', 'mp3');
    await import('node:fs/promises').then((fs) => fs.writeFile(path, Buffer.from('ID3')));
    return { stdout: `${path}\n${title}\n60\n`, stderr: '', code: 0 };
  };

// asis-bugs-19: el título que da yt-dlp (en TikTok o Instagram es la descripción, larga
// y con emojis) se cortaba a 200 unidades UTF-16 a ciegas; un emoji en el corte dejaba
// medio carácter en el título y en el nombre del .mp3.
describe('descargar audio: título largo sin medio emoji', () => {
  it('emoji justo en el carácter 200', async () => {
    const { downloadAudio, resetDownloadCachesForTests } = await import('../src/media/download.js');
    resetDownloadCachesForTests();
    const r = await downloadAudio(URL, 'yt-dlp-falso', {}, fakeRun(`${'a'.repeat(199)}🎵 más`));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toBe('a'.repeat(199));
    expect(r.title).not.toMatch(LONE);
    expect(r.filename).not.toMatch(LONE);
  });
});
