import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnose, groupRepeated, normalizeMessage } from '../src/diagnose.js';

/**
 * Diagnosis is tested against real files in a temp dir, because the whole value of the
 * report is that it names real files and real messages. A mock would let the parser
 * drift from the writer's format without anything noticing.
 *
 * The three properties that matter and that this file pins down: repetition is counted
 * instead of listed, the text carries evidence a stranger can act on, and an empty
 * machine produces a report rather than an exception — the moment this throws is the
 * moment the daemon is already broken.
 */

let dir: string;
const NOW = Date.parse('2026-10-03T12:00:00Z');

function actionsPath(): string {
  return join(dir, 'actions.jsonl');
}

function logPath(day = '2026-10-03'): string {
  return join(dir, 'log', `${day}.jsonl`);
}

/** One action-log line, exactly as `ActionLog.record` would write it. */
function action(entry: {
  action: string;
  result?: 'ok' | 'error' | 'blocked';
  target?: string;
  detail?: string;
  minutesAgo: number;
}): string {
  return `${JSON.stringify({
    ts: new Date(NOW - entry.minutesAgo * 60_000).toISOString(),
    actor: 'asistenta',
    action: entry.action,
    target: entry.target ?? 'telegram:main:1',
    result: entry.result ?? 'ok',
    detail: entry.detail ?? '',
  })}\n`;
}

/** One daemon log line, exactly as `log.ts` would write it. */
function line(level: string, msg: string, fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    ts: new Date(NOW - 5 * 60_000).toISOString(),
    level,
    msg,
    ...fields,
  })}\n`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-diagnose-'));
  mkdirSync(join(dir, 'log'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('diagnose', () => {
  it('counts repeated actions instead of listing them one by one', async () => {
    // Twelve failures of the same tool is one fact. A report that lists twelve lines
    // hides it behind the symptom.
    writeFileSync(
      actionsPath(),
      [
        ...Array.from({ length: 12 }, () =>
          action({
            action: 'computer',
            result: 'error',
            detail: 'screenshot timeout after 30000ms',
            minutesAgo: 30,
          }),
        ),
        action({ action: 'browser', minutesAgo: 40 }),
        action({ action: 'browser', minutesAgo: 41 }),
        action({ action: 'reply', detail: 'listo', minutesAgo: 50 }),
      ].join(''),
    );

    const report = await diagnose({ stateDir: dir, now: () => NOW });

    const computer = report.data.actions.toolHealth.find((h) => h.action === 'computer');
    expect(computer?.total).toBe(12);
    expect(computer?.errors).toBe(12);
    expect(computer?.errorRate).toBe(1);

    const browser = report.data.actions.toolHealth.find((h) => h.action === 'browser');
    expect(browser?.total).toBe(2);

    // Worst first: the failing tool has to be the first line a reader sees.
    expect(report.data.actions.toolHealth[0]?.action).toBe('computer');
    expect(report.data.actions.inWindow).toBe(15);
    expect(report.text).toContain('computer: 12 acciones, 12 con error (100 %)');
  });

  it('groups the same log message even when the ids in it differ', async () => {
    writeFileSync(
      logPath(),
      [
        ...Array.from({ length: 40 }, () =>
          line('error', 'telegram update failed: 409 Conflict: terminated by other getUpdates'),
        ),
        line('error', 'screenshot timeout after 30000ms'),
        line('warn', 'action log write failed', { file: actionsPath() }),
        line('info', 'gate', { tool: 'read', verdict: 'allow' }),
      ].join(''),
    );

    const report = await diagnose({ stateDir: dir, now: () => NOW, logFiles: 1 });

    const groups = report.data.log.grouped;
    expect(groups[0]?.count).toBe(40);
    expect(groups[0]?.level).toBe('error');
    // Only warn and error are grouped: `gate allow` at info level is not a problem, and
    // treating it as one would bury the real failures under the daemon's normal chatter.
    expect(report.data.log.warn).toBe(1);
    expect(report.data.log.error).toBe(41);
    expect(groups.map((g) => g.example)).not.toContain('gate');
    // Ranked by count, so the thing that repeats forty times is the headline.
    expect(report.text.indexOf('40x error')).toBeLessThan(report.text.indexOf('1x error'));
  });

  it('names the files and the exact messages, so another agent can act on the text', async () => {
    writeFileSync(
      logPath(),
      [
        line('error', 'unhandled rejection', { err: { name: 'Error', message: 'socket hang up' } }),
        line('error', 'heartbeat write failed', { err: 'EPERM' }),
      ].join(''),
    );
    writeFileSync(actionsPath(), action({ action: 'shell', result: 'error', minutesAgo: 2 }));
    writeFileSync(join(dir, 'agent.pid'), '9999');
    // The pid file's mtime *is* the boot time (lifecycle writes it at boot), so the
    // test sets it rather than leaving it at "now" and getting a zero uptime.
    const pidFile = join(dir, 'agent.pid');
    const booted = new Date(NOW - 3 * 3_600_000);
    utimesSync(pidFile, booted, booted);
    writeFileSync(join(dir, 'agent.heartbeat'), String(NOW - 3_000));

    const report = await diagnose({
      stateDir: dir,
      now: () => NOW,
      isAlive: () => true,
      logFiles: 1,
      threads: () => 2,
      wake: () => ({ running: true, wakeCount: 3, lastWakeAt: '2026-10-03T11:58:00Z' }),
      config: () => ({ provider: 'opencode-go', model: 'space-bunny-free', baseUrl: 'https://x' }),
    });

    // Evidence, not conclusions: the exact message, the exact file, the exact pid.
    expect(report.text).toContain('unhandled rejection');
    expect(report.text).toContain('heartbeat write failed');
    expect(report.text).toContain('socket hang up');
    expect(report.text).toContain('EPERM');
    expect(report.text).toContain(logPath());
    expect(report.text).toContain(actionsPath());
    expect(report.text).toContain('pid: 9999 (vivo)');
    expect(report.text).toContain('hace 3 segundos');
    expect(report.text).toContain('hace 3 horas');
    expect(report.text).toContain('space-bunny-free');
    expect(report.text).toContain('hilos activos: 2');
    expect(report.text).toContain('escuchando');
    expect(report.data.state.heartbeatAgeMs).toBe(3_000);
    expect(report.data.state.uptimeMs).toBe(3 * 3_600_000);
    expect(report.data.state.alive).toBe(true);
  });

  it('reports standing approvals from the database without opening it when absent', async () => {
    // Absent is the normal state for an agent nobody has approved anything on. Creating
    // the file just to count zero would be a side effect of a question.
    const missing = await diagnose({ stateDir: dir, now: () => NOW });
    expect(missing.data.approvals.present).toBe(false);
    expect(missing.data.approvals.total).toBe(0);
    expect(missing.data.approvals.problem).toContain('approvals.db');
    expect(missing.text).toContain('no existe');

    const db = new DatabaseSync(join(dir, 'approvals.db'));
    db.exec(
      'CREATE TABLE approval_scopes (scope_key TEXT, tool TEXT, level TEXT, created_at INTEGER)',
    );
    for (const [tool, level] of [
      ['shell', 'always'],
      ['computer', 'always'],
      ['write', 'always'],
      ['browser', 'session'],
    ] as const) {
      db.prepare('INSERT INTO approval_scopes VALUES (?, ?, ?, ?)').run(
        `k:${tool}`,
        tool,
        level,
        NOW,
      );
    }
    db.close();

    const report = await diagnose({ stateDir: dir, now: () => NOW });
    expect(report.data.approvals.present).toBe(true);
    expect(report.data.approvals.total).toBe(4);
    expect(report.data.approvals.always).toEqual(['computer', 'shell', 'write']);
    expect(report.text).toContain('siempre permitidas sin preguntar: computer, shell, write');
  });

  it('survives a corrupt approvals database and says so', async () => {
    // A truncated SQLite file is exactly what a crash during a write looks like, and the
    // report must still come out: this function runs while things are broken.
    writeFileSync(join(dir, 'approvals.db'), 'esto no es una base de datos');

    const report = await diagnose({ stateDir: dir, now: () => NOW });

    expect(report.data.approvals.present).toBe(true);
    expect(report.data.approvals.problem).toContain('approvals.db');
    expect(report.text).toContain('PROBLEMAS AL LEER');
  });

  it('reports memory and skills sizes from disk', async () => {
    mkdirSync(join(dir, 'memory', 'perfil'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'perfil.md'), 'x'.repeat(2048));
    writeFileSync(join(dir, 'memory', 'perfil', 'extra.md'), 'y'.repeat(1024));
    mkdirSync(join(dir, 'skills', 'comprar-tren'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'comprar-tren', 'SKILL.md'), '# tren\n');

    const report = await diagnose({ stateDir: dir, now: () => NOW });

    expect(report.data.context.memory.files).toBe(2);
    expect(report.data.context.memory.bytes).toBe(3072);
    expect(report.text).toContain('2 ficheros, 3.0 KB');
    expect(report.data.context.skills.count).toBe(1);
    expect(report.text).toContain('comprar-tren');
  });

  it('with nothing on disk it still answers, and says there is nothing', async () => {
    const report = await diagnose({ stateDir: join(dir, 'nada'), now: () => NOW });

    expect(report.text).toContain('Diagnóstico de Asistenta');
    expect(report.text).toContain('No hay estado que leer');
    expect(report.data.state.pid).toBeNull();
    expect(report.data.actions.read).toBe(0);
    expect(report.data.log.scanned).toBe(0);
    expect(report.text).toContain('no hay ninguna acción registrada todavía');
    expect(report.text).toContain('no hay ni un warn ni un error');
    expect(report.text).toContain('sin acciones en la ventana');
    expect(report.text).toContain('FICHEROS LEÍDOS');
    expect(report.text).toContain('  ninguno');
  });

  it('ignores actions older than the window', async () => {
    writeFileSync(
      actionsPath(),
      [
        action({ action: 'old', result: 'error', minutesAgo: 60 * 48 }),
        action({ action: 'new', minutesAgo: 5 }),
      ].join(''),
    );

    const report = await diagnose({ stateDir: dir, now: () => NOW, windowMs: 3_600_000 });

    expect(report.data.actions.read).toBe(2);
    expect(report.data.actions.inWindow).toBe(1);
    expect(report.data.actions.toolHealth.map((h) => h.action)).toEqual(['new']);
  });
});

describe('normalizeMessage and groupRepeated', () => {
  it('collapses ids and numbers but leaves words alone', () => {
    expect(normalizeMessage('update failed for chat 12345 in 1200 ms')).toBe(
      'update failed for chat # in # ms',
    );
    expect(normalizeMessage('request 550e8400-e29b-41d4-a716-446655440000 failed')).toContain(
      '<uuid>',
    );
    // One-digit numbers are part of words (`fatal`, `v2`): replacing them would make
    // unrelated messages group together.
    expect(normalizeMessage('fatal error on v2')).toBe('fatal error on v2');
  });

  it('keeps a verbatim example and the first/last sighting', () => {
    const groups = groupRepeated([
      { ts: '2026-10-03T10:00:00.000Z', level: 'warn', msg: 'retry 1001 failed', detail: null },
      { ts: '2026-10-03T10:05:00.000Z', level: 'warn', msg: 'retry 1002 failed', detail: null },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.example).toBe('retry 1001 failed');
    expect(groups[0]?.firstSeen).toBe('2026-10-03T10:00:00.000Z');
    expect(groups[0]?.lastSeen).toBe('2026-10-03T10:05:00.000Z');
  });

  it('the error text is part of the group, so different failures stay apart', () => {
    const groups = groupRepeated([
      {
        ts: '2026-10-03T10:00:00.000Z',
        level: 'error',
        msg: 'turn failed',
        detail: 'socket hang up',
      },
      {
        ts: '2026-10-03T10:01:00.000Z',
        level: 'error',
        msg: 'turn failed',
        detail: 'socket hang up',
      },
      { ts: '2026-10-03T10:02:00.000Z', level: 'error', msg: 'turn failed', detail: 'ENOENT' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.example).toBe('turn failed: socket hang up');
    expect(groups[1]?.example).toBe('turn failed: ENOENT');
  });
});
