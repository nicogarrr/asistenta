import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';

const Params = lazySchema(() =>
  Type.Object({ days: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })) }),
);
export function createAgendaTool(
  read: (days?: number) => Promise<string>,
): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'agenda',
    label: 'Agenda personal',
    description:
      "Read the personal overview: today's weather (when configured), local/calendar feed events, pending follow-ups, scheduled routines/reminders and open goals with their next step. Use for qué tengo hoy, qué queda pendiente, qué está programado. Read-only, owner private chat only. Does not include email, change events, activate goals or execute routines. The remote iCal feed can be stale.",
    parameters: Params(),
    executionMode: 'parallel',
    execute: async (_id, args) => ({
      content: [{ type: 'text', text: await read(args.days) }],
      details: {},
    }),
  };
}
