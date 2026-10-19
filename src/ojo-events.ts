/** Event relevance pipeline. No tools, account mutations or third-party recipients. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_QUIET_HOURS, inQuietHours } from './ojo.js';

export interface AttentionEvent {
  source: 'mail' | 'meeting';
  id: string;
  text: string;
  at: number;
}
export interface AttentionDeps {
  db: DatabaseSync;
  now: () => number;
  timeZone: string;
  enabled: () => boolean;
  judge: (
    stage: 'screen' | 'review',
    event: AttentionEvent,
    signal: AbortSignal,
  ) => Promise<string>;
  send: (text: string) => Promise<boolean>;
  /** Optional pacing; may only be stricter than ATTENTION_LIMITS (clamped here). */
  pace?: () => { noticesPerDay: number; cooldownMs: number };
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const ATTENTION_LIMITS = {
  threshold: 0.85,
  callsPerHour: 20,
  noticesPerDay: 4,
  cooldownMs: 30 * 60_000,
  maxPending: 100,
  ttlMs: DAY,
} as const;

/** Strict output contract: the model must cite an exact substring from the event. */
export function parseAttention(raw: string, event: AttentionEvent) {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    value.relevant !== true ||
    typeof value.score !== 'number' ||
    !Number.isFinite(value.score) ||
    value.score < ATTENTION_LIMITS.threshold ||
    value.score > 1 ||
    typeof value.evidence !== 'string' ||
    value.evidence.trim().length < 8 ||
    value.evidence.length > 240 ||
    !event.text.includes(value.evidence)
  )
    return null;
  // Notification prose is fixed, not remote/model-authored instructions.
  return Array.from(value.evidence, (c) =>
    c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c,
  )
    .join('')
    .trim();
}

export class AttentionQueue {
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;
  private abort = new AbortController();
  private deps: AttentionDeps;
  constructor(deps: AttentionDeps) {
    this.deps = deps;
    deps.db.exec(`CREATE TABLE IF NOT EXISTS attention_events (
      key TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS attention_budget (at INTEGER NOT NULL, kind TEXT NOT NULL);`);
  }
  /** Called by existing source deliveries. Never starts polling or fetches another source. */
  offer(events: AttentionEvent[]): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.tail = this.tail
      .then(async () => {
        if (this.stopped || !this.deps.enabled()) return;
        const { db } = this.deps;
        const now = this.deps.now();
        db.prepare('DELETE FROM attention_events WHERE created < ?').run(now - 7 * DAY);
        db.prepare('DELETE FROM attention_budget WHERE at < ?').run(now - DAY);
        // Drop stale pending events, retain their identity for dedup across restarts.
        db.prepare(
          "UPDATE attention_events SET state='expired', payload='' WHERE state='pending' AND created < ?",
        ).run(now - DAY);
        for (const e of events.slice(0, 100)) {
          if (
            !e.id ||
            !e.text.trim() ||
            !Number.isFinite(e.at) ||
            e.at > now + DAY ||
            e.at < now - DAY
          )
            continue;
          const key = createHash('sha256').update(`${e.source}:${e.id}`).digest('hex');
          const count = db
            .prepare("SELECT count(*) AS n FROM attention_events WHERE state='pending'")
            .get() as { n: number };
          if (count.n >= ATTENTION_LIMITS.maxPending) break;
          const event = { ...e, text: e.text.slice(0, 6000) };
          db.prepare(
            'INSERT OR IGNORE INTO attention_events(key,payload,created) VALUES (?,?,?)',
          ).run(key, JSON.stringify(event), now);
        }
        await this.drain();
      })
      .catch(() => {
        /* Failure is contained; pending events remain for next delivery. */
      });
    return this.tail;
  }
  /** Durable-acceptance check for transports: queue pressure/off must not advance their cursor. */
  accepted(event: AttentionEvent): boolean {
    if (event.at < this.deps.now() - DAY) return true; // deliberately expired, not a lost new event
    // offer() permanently discards these; they can never be queued, so they must not stall a cursor.
    if (
      !event.id ||
      !event.text.trim() ||
      !Number.isFinite(event.at) ||
      event.at > this.deps.now() + DAY
    )
      return true;
    const key = createHash('sha256').update(`${event.source}:${event.id}`).digest('hex');
    return !!this.deps.db.prepare('SELECT key FROM attention_events WHERE key=?').get(key);
  }
  private judge(
    stage: 'screen' | 'review',
    event: AttentionEvent,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('Attention deadline'));
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      this.deps
        .judge(stage, event, signal)
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener('abort', abort);
        });
    });
  }
  private count(kind: string, since: number): number {
    return (
      this.deps.db
        .prepare('SELECT count(*) AS n FROM attention_budget WHERE kind=? AND at>=?')
        .get(kind, since) as { n: number }
    ).n;
  }
  private async drain(): Promise<void> {
    const { db } = this.deps;
    const rows = db
      .prepare(
        "SELECT key,payload FROM attention_events WHERE state='pending' ORDER BY created LIMIT 10",
      )
      .all() as Array<{ key: string; payload: string }>;
    for (const row of rows) {
      const now = this.deps.now();
      const p = this.deps.pace?.();
      const pace = {
        noticesPerDay: Math.max(
          0,
          Math.min(ATTENTION_LIMITS.noticesPerDay, p?.noticesPerDay ?? Number.POSITIVE_INFINITY),
        ),
        cooldownMs: Math.max(ATTENTION_LIMITS.cooldownMs, p?.cooldownMs ?? 0),
      };
      if (
        this.stopped ||
        !this.deps.enabled() ||
        inQuietHours(now, DEFAULT_QUIET_HOURS, this.deps.timeZone)
      )
        return;
      if (
        this.count('call', now - HOUR) >= ATTENTION_LIMITS.callsPerHour - 1 ||
        this.count('notice', now - DAY) >= pace.noticesPerDay ||
        this.count('notice', now - pace.cooldownMs)
      )
        return;
      const event = JSON.parse(row.payload) as AttentionEvent;
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(25_000)]);
      // Reserve BEFORE each call: errors and timeouts consume quota too.
      db.prepare('INSERT INTO attention_budget VALUES (?,?)').run(now, 'call');
      const first = parseAttention(await this.judge('screen', event, signal), event);
      if (!first) {
        db.prepare("UPDATE attention_events SET state='ignored', payload='' WHERE key=?").run(
          row.key,
        );
        continue;
      }
      db.prepare('INSERT INTO attention_budget VALUES (?,?)').run(this.deps.now(), 'call');
      const evidence = parseAttention(await this.judge('review', event, signal), event);
      if (!evidence) {
        db.prepare("UPDATE attention_events SET state='ignored', payload='' WHERE key=?").run(
          row.key,
        );
        continue;
      }
      if (
        this.stopped ||
        signal.aborted ||
        !this.deps.enabled() ||
        inQuietHours(this.deps.now(), DEFAULT_QUIET_HOURS, this.deps.timeZone)
      )
        return;
      // Reserve notice on ambiguous delivery as well: never replay a possibly delivered alert.
      db.prepare('INSERT INTO attention_budget VALUES (?,?)').run(this.deps.now(), 'notice');
      db.prepare("UPDATE attention_events SET state='attempted', payload='' WHERE key=?").run(
        row.key,
      );
      await Promise.race([
        this.deps.send(
          `Conviene revisar ${event.source === 'mail' ? 'este correo' : 'esta cita'}. La fuente dice: «${evidence}». Es una señal para comprobar, no un error confirmado.`,
        ),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 10_000);
          timer.unref?.();
        }),
      ]);
    }
  }
  stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    return this.tail;
  }
}
