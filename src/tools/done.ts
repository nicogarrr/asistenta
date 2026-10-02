import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';

/**
 * Explicit task completion.
 *
 * An agent loop ends when the model stops calling tools, but a model that keeps
 * finding useful tools never stops on its own. This tool gives it an intentional
 * exit: call `done` once, by itself, with the final user-facing message.
 *
 * The result carries `terminate: true`, so the run stops without another provider
 * call. `PersonalAgent` reads the summary back out of the tool result because a
 * terminated run has no final assistant text.
 */
const DoneParams = Type.Object({
  summary: Type.String({
    minLength: 1,
    maxLength: 1500,
    description: 'Final message for the user: what is done, what is blocked, what is next.',
  }),
});

export const DONE_TOOL_NAME = 'done';

/** Pull the user-facing summary out of a completed `done` tool result. */
export function extractDoneSummary(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const summary = (details as { summary?: unknown }).summary;
  if (typeof summary !== 'string') return null;
  const text = summary.trim();
  return text ? text : null;
}

export function createDoneTool(): AgentTool<typeof DoneParams> {
  return {
    name: DONE_TOOL_NAME,
    label: 'Done',
    description: [
      'End the task with a final user-facing message.',
      'Call this tool by itself when the requested outcome is ready, blocked, or not worth more tool calls.',
      'Do not call any other tool in the same step, and do not act after calling it.',
    ].join(' '),
    parameters: DoneParams,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const summary = args.summary.trim();
      if (!summary) throw new Error('done requires a non-empty summary');
      log.info('task done', { chars: summary.length });
      return {
        content: [{ type: 'text', text: summary }],
        details: { done: true, summary },
        terminate: true,
      };
    },
  };
}
