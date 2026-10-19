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

const AskParams = Type.Object({
  question: Type.String({
    minLength: 1,
    maxLength: 600,
    description:
      'One short question in the user language, with the 2-3 concrete options when there are any.',
  }),
});

export const ASK_TOOL_NAME = 'preguntar';

/** Both terminal tools end the run with a user-facing message. */
export function isTerminalToolName(name: string): boolean {
  return name === DONE_TOOL_NAME || name === ASK_TOOL_NAME;
}

/**
 * Ask-before-acting. Use when a consequential action (message to a third party, payment,
 * booking, deletion, overwrite, install) has two or more plausible targets, recipients,
 * amounts or dates and the user did not settle which. It performs nothing: it ends the run
 * with the question, so the next user message resolves the ambiguity.
 */
export function createAskTool(): AgentTool<typeof AskParams> {
  return {
    name: ASK_TOOL_NAME,
    label: 'Ask',
    description: [
      'Ask the user ONE clarifying question and stop, instead of guessing.',
      'Required before a consequential action when the request fits 2+ plausible recipients, items, dates, amounts or accounts and nothing in this chat or your memory settles it.',
      'Do not use it for harmless reads or when one reading is clearly the most likely. Do not ask what a tool can look up. Call it by itself.',
    ].join(' '),
    parameters: AskParams,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const question = args.question.trim();
      if (!question) throw new Error('preguntar requires a non-empty question');
      log.info('asked user', { chars: question.length });
      return {
        content: [{ type: 'text', text: question }],
        details: { done: true, summary: question, asked: true },
        terminate: true,
      };
    },
  };
}
