import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROCESS_TIMEOUT_MS,
  type ProcesarDeps,
  processItem,
  TRANSCRIBE_BUDGET_MS,
} from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { getVideoText } from '../src/media/resumen-video.js';
import type { Runner } from '../src/media/transcript.js';

// bugs-32 (11 nov 2026): la bandeja transcribe «hasta 3 h», pero cortaba cada cosa a los
// 15 min con «tardaba demasiado» (el whisper del PC va en CPU) y el whisper seguía en
// segundo plano: el corte no le llegaba, gastaba CPU y su texto se tiraba.

/** yt-dlp y ffmpeg de mentira (como en resumen-video.test.ts). */
function fakeRunner(durationSec: number) {
  const calls: { file: string; args: string[] }[] = [];
  const runner: Runner = async (file, args) => {
    calls.push({ file, args });
    const out = args[args.indexOf('-o') + 1] ?? args[args.length - 1] ?? '';
    if (file === 'ffmpeg') {
      await writeFile(args[args.length - 1] as string, Buffer.alloc(64_000, 1));
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args.includes('--skip-download'))
      return { stdout: `Podcast largo\tCanal\t${durationSec}\n`, stderr: '', code: 0 };
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out.replace('%(ext)s', 'm4a'), 'audio');
    return { stdout: '', stderr: '', code: 0 };
  };
  return { runner, calls };
}

describe('audio largo: el corte llega al whisper', () => {
  it('cortado a mitad: para de transcribir y devuelve lo oído, «solo los primeros N min»', async () => {
    const { runner, calls } = fakeRunner(3600);
    const ctl = new AbortController();
    let pieces = 0;
    const r = await getVideoText('https://x.com/u/status/1850000000000000000', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      env: { PA_RESUMEN_MAX_MIN: '180', PA_RESUMEN_CHUNK_MIN: '10' },
      signal: ctl.signal,
      transcribe: async () => {
        pieces++;
        if (pieces === 2) ctl.abort();
        return `trozo ${pieces}`;
      },
    });
    expect(pieces).toBe(2);
    expect(calls.filter((c) => c.file === 'ffmpeg')).toHaveLength(2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('trozo 2');
      expect(r.cappedAtMin).toBe(20);
    }
  });

  it('cortado antes de oír nada: no lo da por bueno', async () => {
    const { runner } = fakeRunner(3600);
    const ctl = new AbortController();
    ctl.abort();
    const r = await getVideoText('https://x.com/u/status/1850000000000000000', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      signal: ctl.signal,
      transcribe: async () => 'no debería',
    });
    expect(r).toEqual({ ok: false, reason: 'se acabó el tiempo antes de transcribir nada' });
  });

  it('sin corte, igual que antes (tope de PA_RESUMEN_MAX_MIN)', async () => {
    const { runner } = fakeRunner(1800);
    const r = await getVideoText('https://x.com/u/status/1850000000000000000', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      env: { PA_RESUMEN_MAX_MIN: '180', PA_RESUMEN_CHUNK_MIN: '10' },
      signal: new AbortController().signal,
      transcribe: async () => 'texto',
    });
    expect(r.ok && r.cappedAtMin).toBeFalsy();
  });
});

describe('bandeja: tope de transcripción por debajo del de la cosa', () => {
  let dir: string;
  let store: BandejaStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bugs32-audio-'));
    store = new BandejaStore(join(dir, 'bandeja.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('los topes dejan hora y pico al whisper, con margen para el modelo', () => {
    expect(TRANSCRIBE_BUDGET_MS).toBeGreaterThanOrEqual(30 * 60_000);
    expect(PROCESS_TIMEOUT_MS - TRANSCRIBE_BUDGET_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it('a la hora del tope, la transcripción se corta y la cosa se juzga con lo oído', async () => {
    const { item } = store.add(
      '111',
      { kind: 'youtube', url: 'https://youtu.be/AAAAAAAAAAA' },
      new Date('2026-11-11T09:00:00Z'),
      '2026-11-11',
    );
    const seen: string[] = [];
    const deps: ProcesarDeps = {
      transcribeBudgetMs: 30,
      complete: async () => async (_s, user) => {
        seen.push(user);
        return 'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 6\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';
      },
      fetchRaw: async (url) => {
        throw new Error(`sin red: ${url}`);
      },
      videoText: (_url, opts) =>
        new Promise((resolve) => {
          opts?.signal?.addEventListener('abort', () =>
            resolve({
              ok: true,
              meta: { title: 'Podcast de 4 h', author: 'Canal', durationSeconds: 4 * 3600 },
              text: '[00:00] lo que dio tiempo a oír',
              source: 'audio',
              cappedAtMin: 52,
            }),
          );
        }),
    };
    const r = await processItem(item, deps);
    expect(r.verdict).toBe('ideas');
    expect(seen[0]).toContain('lo que dio tiempo a oír');
    expect(seen[0]).toContain('solo los primeros 52 min');
  });

  it('el daemon le pasa el corte de la bandeja a getVideoText', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const at = src.indexOf('const bandejaProcDeps: ProcesarDeps');
    expect(src.slice(at, at + 900)).toMatch(/opts\?\.signal \? \{ signal: opts\.signal \}/);
  });
});
