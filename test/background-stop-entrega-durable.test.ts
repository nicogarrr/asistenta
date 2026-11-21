import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { BackgroundDelegates, backgroundTurnInbound } from '../src/core/background-delegate.js';
import { BackgroundJobJournal } from '../src/core/background-journal.js';
import { queueThreadTurn } from '../src/daemon/inbound.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
it('stop removes a finished job waiting for its delivery turn, before a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit2421-stop-'));
  const j = new BackgroundJobJournal(join(dir, 'jobs.json'));
  const b = new BackgroundDelegates({ journal: j });
  let release!: () => void;
  const thread = {
    key: 'telegram:1:2#main',
    generation: 0,
    tail: new Promise<void>((r) => {
      release = r;
    }),
  };
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const begin = source.indexOf('  const startBackgroundDelegate =');
  const end = source.indexOf('  /**', begin);
  const js = ts.transpileModule(`${source.slice(begin, end)}\nreturn startBackgroundDelegate;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const start = new Function(
    'threadOutputs',
    'backgroundDelegates',
    'queueThreadTurn',
    'backgroundTurnInbound',
    'inboundFor',
    'runTurn',
    js,
  )(
    { get: () => undefined },
    b,
    queueThreadTurn,
    backgroundTurnInbound,
    () => ({
      channel: 'telegram',
      account: 'a',
      chatId: '1',
      userId: '2',
      authorised: true,
      messageId: 'x',
      receivedAt: '',
      text: '',
    }),
    async () => {},
  );
  try {
    start(thread, { task: 'report', run: async () => 'finished' });
    await flush();
    expect(j.all()[0]?.result).toContain('finished');
    // Same stop operations used by cmdStop in cli.ts.
    thread.generation++;
    b.abortThread(thread.key);
    thread.tail = Promise.resolve();
    expect(j.all()).toHaveLength(0);
  } finally {
    release();
    await flush();
    rmSync(dir, { recursive: true, force: true });
  }
});
