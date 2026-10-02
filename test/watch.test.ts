import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FileEvent, FileWatcher, isInterestingFile } from '../src/watch/files.js';

// Stubbed so a test run cannot append watcher chatter to the real daily log
// under the state dir.
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/**
 * Short enough to keep the suite fast, long enough that a normal write has gone
 * quiet before the settle. The gap between the two stability stats is the
 * watcher's business; the test only has to out-wait the OS delivering events.
 */
const DEBOUNCE_MS = 60;
/** Longer than debounce + 2 * the internal probe, so a duplicate would have landed. */
const QUIET_MS = 400;

let dir = '';
const open: FileWatcher[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-watch-'));
});

afterEach(() => {
  for (const watcher of open.splice(0)) watcher.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Polls instead of sleeping a fixed amount, because the delay between writing a
 * file and the watcher hearing about it is the OS's, not this test's. A fixed
 * sleep has to cover the slowest loaded machine and still be a coin flip there;
 * polling fails fast when things work and gives a readable timeout when not.
 */
async function waitFor(probe: () => boolean, deadlineMs = 6000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (probe()) return;
    await delay(20);
  }
  throw new Error(`timed out after ${deadlineMs}ms waiting for the watcher`);
}

function startWatcher(
  overrides: Partial<{
    debounceMs: number;
    ignore: (path: string) => boolean;
    maxEventsPerMinute: number;
  }> = {},
): { watcher: FileWatcher; seen: FileEvent[] } {
  const seen: FileEvent[] = [];
  const watcher = new FileWatcher({
    dirs: [dir],
    debounceMs: DEBOUNCE_MS,
    ...overrides,
    onEvent: (event) => {
      seen.push(event);
    },
  });
  watcher.start();
  open.push(watcher);
  return { watcher, seen };
}

describe('FileWatcher', () => {
  it('reports a created file once even when the write fires a burst of events', async () => {
    const { watcher, seen } = startWatcher();
    const path = join(dir, 'informe.pdf');
    // Several rapid writes: on Windows each one is several fs.watch events, and
    // every one of them must fold into a single settled report.
    writeFileSync(path, 'a');
    writeFileSync(path, 'ab');
    writeFileSync(path, 'abc');
    await waitFor(() => seen.length > 0);
    await delay(QUIET_MS);
    expect(seen).toHaveLength(1);
    const event = seen[0];
    expect(event?.kind).toBe('created');
    expect(event?.path).toBe(path);
    expect(event?.bytes).toBe(3);
    expect(event?.extension).toBe('.pdf');
    expect(Number.isNaN(Date.parse(event?.at ?? ''))).toBe(false);
    expect(watcher.events()).toHaveLength(1);
    expect(watcher.suppressed()).toBe(0);
  });

  it('never reports a file that is still growing, only the final size', async () => {
    const { seen } = startWatcher({ debounceMs: 30 });
    const path = join(dir, 'grande.zip');
    const fd = openSync(path, 'w');
    const chunk = 'z'.repeat(256);
    const writes = 20;
    try {
      for (let i = 0; i < writes; i += 1) {
        writeSync(fd, chunk);
        // Faster than the watcher's stability gap, so any two size samples taken
        // mid-write straddle at least one chunk and must disagree. Slower than
        // the debounce, so a settle does start mid-write and has to hold.
        await delay(40);
      }
    } finally {
      closeSync(fd);
    }
    // The file stopped growing a moment ago. A report would already be in here
    // if any partial state had been announced during the writing.
    expect(seen).toHaveLength(0);
    await waitFor(() => seen.length > 0);
    await delay(QUIET_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('created');
    expect(seen[0]?.bytes).toBe(writes * chunk.length);
  });

  it('reports a change to a file it already announced', async () => {
    const { seen } = startWatcher();
    const path = join(dir, 'nota.txt');
    writeFileSync(path, 'v1');
    await waitFor(() => seen.length > 0);
    writeFileSync(path, 'v2 con contenido nuevo');
    await waitFor(() => seen.length > 1);
    await delay(QUIET_MS);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.kind).toBe('created');
    expect(seen[1]?.kind).toBe('changed');
    expect(seen[1]?.path).toBe(path);
    expect(seen[1]?.bytes).toBe('v2 con contenido nuevo'.length);
  });

  it('drops events past maxEventsPerMinute and counts them in suppressed()', async () => {
    const { watcher, seen } = startWatcher({ debounceMs: 30, maxEventsPerMinute: 2 });
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(dir, `f${i}.pdf`), String(i));
    }
    await waitFor(() => seen.length + watcher.suppressed() >= 5);
    await delay(50);
    expect(seen).toHaveLength(2);
    expect(watcher.suppressed()).toBe(3);
    expect(watcher.events()).toHaveLength(2);
  });

  it('stops idempotently and delivers nothing after stop', async () => {
    const { watcher, seen } = startWatcher({ debounceMs: 30 });
    // Written before stop: its debounce timer is armed and must be cancelled.
    writeFileSync(join(dir, 'pendiente.pdf'), 'x');
    watcher.stop();
    expect(() => watcher.stop()).not.toThrow();
    writeFileSync(join(dir, 'tarde.pdf'), 'y');
    await delay(QUIET_MS);
    expect(seen).toEqual([]);
    expect(watcher.events()).toEqual([]);
  });

  it('reports a removal', async () => {
    const { seen } = startWatcher();
    const path = join(dir, 'borrar.txt');
    writeFileSync(path, 'contenido');
    await waitFor(() => seen.some((e) => e.kind === 'created'));
    unlinkSync(path);
    await waitFor(() => seen.some((e) => e.kind === 'removed'));
    await delay(QUIET_MS);
    const removed = seen.filter((e) => e.kind === 'removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.path).toBe(path);
    expect(removed[0]?.bytes).toBeUndefined();
    expect(removed[0]?.extension).toBe('.txt');
    expect(Number.isNaN(Date.parse(removed[0]?.at ?? ''))).toBe(false);
  });

  it('honours the ignore veto', async () => {
    const { seen } = startWatcher({ ignore: (p) => p.endsWith('.log') });
    writeFileSync(join(dir, 'ruido.log'), 'x'.repeat(64));
    writeFileSync(join(dir, 'informe.pdf'), 'y'.repeat(64));
    await waitFor(() => seen.length > 0);
    await delay(QUIET_MS);
    expect(seen.map((e) => e.path)).toEqual([join(dir, 'informe.pdf')]);
  });

  it('keeps at most the last 200 events in events()', async () => {
    const total = 210;
    const { watcher, seen } = startWatcher({ debounceMs: 25, maxEventsPerMinute: 1000 });
    for (let i = 0; i < total; i += 1) {
      writeFileSync(join(dir, `bulk${i}.pdf`), String(i));
      // Periodic pauses so the OS watch buffer can drain instead of dropping
      // notifications this test would then wait for forever.
      if (i % 25 === 24) await delay(5);
    }
    await waitFor(() => seen.length >= total, 10_000);
    expect(watcher.events()).toHaveLength(200);
    expect(watcher.events()[199]?.path).toBe(seen[seen.length - 1]?.path);
    expect(watcher.suppressed()).toBe(0);
  });
});

describe('isInterestingFile', () => {
  it('accepts the document and media types the agent handles', () => {
    for (const name of [
      'informe.pdf',
      'doc.docx',
      'hoja.xlsx',
      'datos.csv',
      'nota.txt',
      'foto.png',
      'foto.jpg',
      'foto.jpeg',
      'foto.webp',
      'video.mp4',
      'audio.mp3',
      'archivo.zip',
      'FOTO.JPG',
    ]) {
      expect(isInterestingFile(join(dir, name)), name).toBe(true);
    }
  });

  it('treats an unknown extension as interesting', () => {
    expect(isInterestingFile(join(dir, 'nuevoformato.desconocido'))).toBe(true);
    expect(isInterestingFile(join(dir, 'sin-extension'))).toBe(true);
  });

  it('rejects in-progress and lock files', () => {
    for (const name of [
      'copia.tmp',
      'descarga.part',
      'algo.partial',
      'video.mp4.crdownload',
      '~$foo.docx',
      'algo.lock',
    ]) {
      expect(isInterestingFile(join(dir, name)), name).toBe(false);
    }
    expect(isInterestingFile(join(dir, '.git', 'objects', 'xx'))).toBe(false);
    expect(isInterestingFile('C:\\repo\\.git\\objects\\xx')).toBe(false);
  });

  it('rejects a zero-byte placeholder but accepts the same name with content', () => {
    const empty = join(dir, 'vacio.pdf');
    writeFileSync(empty, '');
    expect(isInterestingFile(empty)).toBe(false);
    const full = join(dir, 'lleno.pdf');
    writeFileSync(full, 'x');
    expect(isInterestingFile(full)).toBe(true);
  });
});
