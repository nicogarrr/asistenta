import { describe, expect, it } from 'vitest';
import * as cli from '../src/cli.js';
import * as cron from '../src/daemon/cron-command.js';

// P2 (ARCHITECTURE.md): /cron and its routine helpers live in src/daemon/cron-command.ts;
// cli.ts re-exports the very same functions, so every existing import keeps working.
describe('cron-command module', () => {
  it('cli.ts re-exports the same functions (pure move)', () => {
    const pairs = [
      [cli.runCronCommand, cron.runCronCommand],
      [cli.routineNameFromPrompt, cron.routineNameFromPrompt],
      [cli.formatNextRun, cron.formatNextRun],
      [cli.inChatScope, cron.inChatScope],
      [cli.uniqueRoutineName, cron.uniqueRoutineName],
      [cli.commandRoutineTag, cron.commandRoutineTag],
      [cli.nextRunLabel, cron.nextRunLabel],
      [cli.scheduledAgendaText, cron.scheduledAgendaText],
    ] as const;
    for (const [fromCli, fromModule] of pairs) {
      expect(typeof fromModule).toBe('function');
      expect(fromCli).toBe(fromModule);
    }
  });

  it('keeps the module-private helpers private', () => {
    expect('goalRoutineCronRefusal' in cron).toBe(false);
    expect('SCHEDULE_WORDS' in cron).toBe(false);
  });

  it('inChatScope and routineNameFromPrompt behave as before', () => {
    expect(cron.inChatScope('telegram:a:1#main', 'telegram:a:1')).toBe(true);
    expect(cron.inChatScope('telegram:a:12#main', 'telegram:a:1')).toBe(false);
    expect(cron.routineNameFromPrompt('')).toBe(cli.routineNameFromPrompt(''));
  });
});
