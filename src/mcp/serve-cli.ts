/**
 * `pa mcp serve`: arranca el servidor MCP de solo lectura por stdio (F9).
 * Lee la memoria, las sesiones y los objetivos del chat privado del dueño.
 * Nada escribe. Se sale con Ctrl+C o cerrando la entrada.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FollowupTracker } from '../alerts/followups.js';
import { localTimeZone } from '../datecontext.js';
import { Store } from '../db.js';
import { GoalStore } from '../goals/store.js';
import { scrubLogText } from '../log.js';
import { SessionStore } from '../memory/sessions.js';
import { MemoryStore } from '../memory.js';
import { paths } from '../paths.js';
import { nextScheduleRun } from '../routines.js';
import { vaultGet } from '../vault.js';
import { resolveOwnerUserId } from '../vigilante.js';
import { serveMcpStdio } from './server.js';

export async function ownerChatKey(
  get: (k: string) => Promise<string | null | undefined> = vaultGet,
): Promise<string | null> {
  const allowed = String((await get('telegram:allowedUserIds')) ?? '')
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  const configured = Number(String((await get('vigilante:ownerUserId')) ?? '').trim());
  const owner = resolveOwnerUserId(
    allowed,
    Number.isSafeInteger(configured) && configured > 0 ? configured : null,
  );
  return owner == null ? null : `telegram:dm:${owner}`;
}

export async function mcpCommand(args: string[]): Promise<number> {
  if (args[0] !== 'serve') {
    process.stderr.write('uso: pa mcp serve   (servidor MCP de solo lectura por stdio)\n');
    return 2;
  }
  const chat = await ownerChatKey();
  if (!chat) {
    process.stderr.write(
      'No sé cuál es el chat privado del dueño: configura telegram:allowedUserIds (un único usuario) o vigilante:ownerUserId.\n',
    );
    return 1;
  }
  const main = `${chat}#main`;
  const memory = new MemoryStore();
  const memoryDb = new DatabaseSync(join(paths.state, 'memory.db'));
  const goalsDb = new DatabaseSync(join(paths.state, 'goals.db'));
  const sessions = new SessionStore({ db: memoryDb });
  const goals = new GoalStore({ db: goalsDb });
  const followups = new FollowupTracker({ db: memoryDb });
  const store = new Store();
  const mine = (scope: string) => scope === chat || scope.startsWith(`${chat}#`);
  process.stderr.write(`Asistenta MCP (solo lectura) para ${chat}. Esperando por stdio…\n`);
  try {
    await serveMcpStdio(
      {
        memorySearch: (q, limit) => memory.recall(main, q, limit),
        sessionSearch: (q, limit) => sessions.search(q, main, limit),
        goals: () => goals.list().filter((g) => g.scope.startsWith(`${chat}#`)),
        agenda: () => ({
          followups: followups
            .forChat(chat)
            .filter((f) => f.status === 'pending')
            .map((f) => ({ subject: f.subject, dueAt: f.dueAt })),
          routines: store
            .listRoutines()
            .filter((r) => r.kind === 'schedule' && mine(r.scope))
            .map((r) => ({
              name: r.name,
              enabled: r.enabled,
              next: r.schedule ? (nextScheduleRun(r.schedule)?.getTime() ?? null) : null,
            })),
        }),
        timeZone: localTimeZone(),
        scrub: scrubLogText,
      },
      process.stdin,
      process.stdout,
    );
  } finally {
    memoryDb.close();
    goalsDb.close();
  }
  return 0;
}
