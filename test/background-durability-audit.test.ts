import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BackgroundDelegates } from '../src/core/background-delegate.js';
import { BackgroundJobJournal } from '../src/core/background-journal.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const key = 'telegram:1:2#main';
function journal() {
  const dir = mkdtempSync(join(tmpdir(), 'audit2421-'));
  return {
    j: new BackgroundJobJournal(join(dir, 'jobs.json')),
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}
function startup(
  j: BackgroundJobJournal,
  get: (...args: unknown[]) => Promise<unknown>,
  start: (...args: unknown[]) => boolean,
) {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const begin = source.indexOf('  const resumeBackgroundJobs = (): void => {');
  const end = source.indexOf('  const inboundFor =', begin);
  const code = ts.transpileModule(source.slice(begin, end) + '\nresumeBackgroundJobs();', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const pool = { run: async () => ({ text: 'ok' }) };
  new Function(
    'backgroundJournal',
    'BACKGROUND_JOB_MAX_AGE_MS',
    'log',
    'sliceSafe',
    'getOrCreateThread',
    'delegateTool',
    'config',
    'delegateWiring',
    'defaultDelegateParentTools',
    'startBackgroundDelegate',
    'emptyResultNotice',
    code,
  )(
    j,
    86400000,
    { warn: () => {}, info: () => {} },
    (s: string) => s,
    get,
    () => {},
    {},
    { pool },
    () => [],
    start,
    () => 'empty',
  );
}
describe('audit exact startup and durable delivery', () => {
  it('keeps a completed result durable while delivery is still queued', async () => {
    const { j, clean } = journal();
    let finish!: () => void;
    try {
      new BackgroundDelegates({ journal: j }).start(
        { key, generation: () => 1 },
        { task: 'report', run: async () => 'result' },
        () =>
          new Promise<void>((r) => {
            finish = r;
          }),
      );
      await flush();
      expect(j.all()).toHaveLength(1);
    } finally {
      finish?.();
      clean();
    }
  });
  it('keeps pending startup durable until thread recovery finishes', async () => {
    const { j, clean } = journal();
    let resolve!: (v: unknown) => void;
    try {
      j.add({ threadKey: key, task: 'report', startedAt: Date.now() });
      startup(
        j,
        () =>
          new Promise((r) => {
            resolve = r;
          }),
        () => true,
      );
      expect(j.all()).toHaveLength(1);
    } finally {
      resolve?.({ chatKey: 'telegram:1:2' });
      await flush();
      clean();
    }
  });
  it('keeps the entry if thread recovery rejects', async () => {
    const { j, clean } = journal();
    try {
      j.add({ threadKey: key, task: 'report', startedAt: Date.now() });
      startup(
        j,
        async () => {
          throw Error('thread init failed');
        },
        () => true,
      );
      await flush();
      expect(j.all()).toHaveLength(1);
    } finally {
      clean();
    }
  });
  it('does not forget a second identical active job when the first ends', async () => {
    const { j, clean } = journal();
    let finish!: (s: string) => void;
    try {
      const b = new BackgroundDelegates({ journal: j });
      b.start(
        { key, generation: () => 1 },
        { task: 'same', run: async () => 'one' },
        async () => {},
      );
      b.start(
        { key, generation: () => 1 },
        {
          task: 'same',
          run: () =>
            new Promise((r) => {
              finish = r;
            }),
        },
        async () => {},
      );
      await flush();
      expect(b.count(key)).toBe(1);
      expect(j.all()).toHaveLength(1);
    } finally {
      finish?.('two');
      await flush();
      clean();
    }
  });
});
