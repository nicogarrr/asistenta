import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BackgroundJobJournal } from '../src/core/background-journal.js';

const key = 'telegram:1:2#main';

describe('resumeBackgroundJobs reaplica rol y herramientas', () => {
  it('pasa role y tools del original al pool, también tools: []', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-role-'));
    try {
      const j = new BackgroundJobJournal(join(dir, 'jobs.json'));
      j.add({ threadKey: key, task: 'plan', startedAt: Date.now(), role: 'planner', tools: [] });
      const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
      const begin = source.indexOf('  const resumeBackgroundJobs = (): void => {');
      const end = source.indexOf('  const inboundFor =', begin);
      const code = ts.transpileModule(source.slice(begin, end) + '\nresumeBackgroundJobs();', {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText;
      const requests: Record<string, unknown>[] = [];
      const pool = {
        run: async (r: Record<string, unknown>) => {
          requests.push(r);
          return { text: 'ok' };
        },
      };
      let started:
        | { run: (s: AbortSignal) => Promise<string>; role?: string; tools?: string[] }
        | undefined;
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
        async () => ({ chatKey: 'telegram:1:2' }),
        () => {},
        {},
        { pool },
        () => [],
        (_t: unknown, job: typeof started) => {
          started = job;
          return true;
        },
        () => 'empty',
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(started?.role).toBe('planner');
      expect(started?.tools).toEqual([]);
      await started?.run(new AbortController().signal);
      expect(requests[0]).toMatchObject({ role: 'planner', tools: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
