/**
 * Notices files the user drops in a folder, without being asked.
 *
 * The only thing a chat-only design can react to is a message, and the moment a
 * person actually wants help is the moment they save or download something.
 * Every rule below exists because of a specific way `fs.watch` misreports reality:
 *
 * - One write to one file is several events (Windows fires rename + change per
 *   write, plus a burst when buffers flush), so the unit of reporting is a path
 *   that has gone quiet for `debounceMs`, never a raw event.
 * - A name appears in the directory listing before its first byte is written, and
 *   a file mid-copy is indistinguishable from a finished one by name. A report
 *   waits for two size samples that agree, or the agent reads a half-written PDF
 *   and confidently explains the missing half. This is the one detail the feature
 *   cannot get wrong.
 * - `filename` is often undefined ("something in that folder changed"). There is
 *   no path to coalesce on, so the honest fallback is a rescan of the directory
 *   diffed against what is already known.
 * - The same path is seen again when a temp file is renamed into place and when a
 *   late event straggles in after its report. One file announced twice is how the
 *   agent ends up offering to process it twice, so a settled path is only
 *   reported again when its size or mtime actually moved.
 * - `fs.watch` fails with EMFILE/ENOSPC at the machine's watcher limit, which
 *   reads like a mystery crash unless the error says what to do about it.
 * - A folder with 5000 generated files would become 5000 agent runs, so reports
 *   are rate-capped and the overflow is counted, not delivered.
 */

import { type Dirent, type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { log, redact } from '../log.js';

export interface FileEvent {
  path: string;
  kind: 'created' | 'changed' | 'removed';
  /** ISO moment the file settled (or vanished), not the moment the raw event fired. */
  at: string;
  /** Settled size in bytes. Absent for `removed`, where there is nothing left to measure. */
  bytes?: number;
  /** Lowercase with the dot, e.g. `.pdf`. Absent for an extensionless path. */
  extension?: string;
}

export interface WatcherOptions {
  dirs: string[];
  onEvent: (event: FileEvent) => void;
  /** Quiet time per path before a settle is attempted. Default 700ms. */
  debounceMs?: number;
  /** Extra veto applied on top of `isInterestingFile`. Returning true drops the path. */
  ignore?: (path: string) => boolean;
  /** Ceiling on delivered events per minute; the overflow is counted, not delivered. Default 30. */
  maxEventsPerMinute?: number;
}

const DEFAULT_DEBOUNCE_MS = 700;
const DEFAULT_MAX_EVENTS_PER_MINUTE = 30;

/** Gap between the two size samples that decide whether a file has stopped growing. */
const PROBE_MS = 200;

/**
 * How many settle rounds a continuously growing file gets before it is left
 * unannounced. At the defaults that is over half a minute of patience, and the
 * next event on the path starts a fresh round, so the cap costs a report only
 * for files that never stop being written — which must not be reported anyway.
 */
const SETTLE_ATTEMPTS = 30;

/** Bounded so a daemon that runs for weeks does not keep every event it ever saw. */
const MAX_EVENT_HISTORY = 200;

const RATE_WINDOW_MS = 60_000;

/**
 * Suffixes that mean "not finished", never "a document". `.crdownload` is the one
 * that matters: a 2GB download is a `.crdownload` for most of its life and is
 * renamed to its real name in a single instant, so treating it as a file to
 * process is how the agent tries to read a half-downloaded video. `.part`,
 * `.partial`, `.download` and `.opdownload` are the same idea in Firefox, wget,
 * OneDrive and Opera.
 */
const TEMP_EXTENSIONS = new Set([
  '.tmp',
  '.temp',
  '.part',
  '.partial',
  '.crdownload',
  '.download',
  '.opdownload',
  '.swp',
  '.swx',
  '.lock',
]);

/**
 * Marker *prefixes* that mean "somebody else owns this name right now". Office
 * writes `~$informe.docx` next to every open document, Emacs writes `.#file`,
 * LibreOffice writes `.~lock.file#`; none can be caught by the suffix list, and
 * every one of them is a burst of events for something the user did not create.
 */
const TEMP_PREFIXES = ['~$', '.#', '.~lock.'];

function hasInterestingName(path: string): boolean {
  if (path.split(/[\\/]/).includes('.git')) return false;
  const name = basename(path);
  for (const prefix of TEMP_PREFIXES) {
    if (name.startsWith(prefix)) return false;
  }
  return !TEMP_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * Whether a path is worth announcing at all.
 *
 * Deliberately not an allowlist: a new file type is not a reason to ignore a
 * file, so anything that is not recognisable junk passes, and the document and
 * media types the agent actually handles (pdf, docx, xlsx, csv, txt, png, jpg,
 * jpeg, webp, mp4, mp3, zip, ...) are simply the common cases of that rule.
 *
 * Size is part of the answer because a 0-byte name is a placeholder — a `touch`,
 * the entry a failed copy left behind — and announcing it sends the agent to
 * read nothing. A path that no longer exists keeps its name-based verdict: the
 * watcher still needs a verdict for the file it just saw disappear.
 */
export function isInterestingFile(path: string): boolean {
  if (!hasInterestingName(path)) return false;
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return true;
  if (!st.isFile()) return false;
  return st.size > 0;
}

interface FileStat {
  size: number;
  mtimeMs: number;
}

/**
 * Every interesting file under `root`, with the size and mtime that say "this is
 * the version I know". This is both the startup baseline (files that predate the
 * watcher are `changed` when touched, never announced as new) and the fallback
 * for events that arrived without a filename.
 *
 * Symlinks are skipped: a junction loop would hang the walk, and a symlinked file
 * is announced when its real directory is watched.
 */
function scanFiles(root: string): Map<string, FileStat> {
  const out = new Map<string, FileStat>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A folder renamed or unplugged mid-walk; the rest of the walk still matters.
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // `.git` is pruned here as well as rejected by name: descending into it
        // would stat thousands of objects to filter every one of them out again.
        if (entry.name !== '.git') stack.push(path);
      } else if (entry.isFile() && hasInterestingName(path)) {
        const st = statSync(path, { throwIfNoEntry: false });
        if (st) out.set(path, { size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  return out;
}

/** Lowercase with the dot; `undefined` rather than empty for extensionless names. */
function extensionOf(path: string): string | undefined {
  return extname(path).toLowerCase() || undefined;
}

function isWatcherLimit(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EMFILE' || code === 'ENOSPC';
}

function watcherLimitError(dir: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
  return new Error(
    `watcher limit reached (${code}) while watching ${dir}; ` +
      'close other watchers or raise the OS watch limit',
    { cause: err },
  );
}

export class FileWatcher {
  readonly #dirs: string[];
  readonly #onEvent: (event: FileEvent) => void;
  readonly #ignore: ((path: string) => boolean) | undefined;
  readonly #debounceMs: number;
  readonly #maxPerMinute: number;

  /** Live native watchers. A directory that failed to open is not in here. */
  readonly #watchers = new Map<string, FSWatcher>();
  /** Debounce timers, one per path with an unsettled change. */
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** Rescan timers for events that arrived without a filename, one per directory. */
  readonly #rescans = new Map<string, ReturnType<typeof setTimeout>>();
  /** Paths whose settle loop is currently running; see `#consider`. */
  readonly #inflight = new Set<string>();
  /** Pending sleeps inside settle loops, so `stop()` does not have to wait them. */
  readonly #sleepers = new Set<() => void>();
  /** Size and mtime of every file this watcher believes exists, and of which version. */
  readonly #known = new Map<string, FileStat>();
  readonly #events: FileEvent[] = [];
  #suppressed = 0;
  #windowStart = 0;
  #windowCount = 0;
  #windowWarned = false;
  #started = false;
  #stopped = false;

  constructor(opts: WatcherOptions) {
    // Resolved once, here: an event arrives as a bare filename under a watched
    // dir, and every map below (debounce timers, known paths) needs one canonical
    // spelling or the same file is tracked twice under two keys.
    this.#dirs = [...new Set(opts.dirs.map((d) => resolve(d)))];
    this.#onEvent = opts.onEvent;
    this.#ignore = opts.ignore;
    this.#debounceMs = Math.max(10, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.#maxPerMinute = Math.max(1, opts.maxEventsPerMinute ?? DEFAULT_MAX_EVENTS_PER_MINUTE);
  }

  /** The last 200 delivered events, oldest first. Suppressed events are not in here. */
  events(): FileEvent[] {
    return [...this.#events];
  }

  /** Events dropped by `maxEventsPerMinute` since `start()`, so the caller can mention the gap. */
  suppressed(): number {
    return this.#suppressed;
  }

  start(): void {
    // A stopped watcher that could start again would make "no events arrive
    // after stop" a lie, so the lifecycle is start-once, stop-once.
    if (this.#started || this.#stopped) return;
    this.#started = true;
    for (const dir of this.#dirs) {
      // The baseline is taken before the watcher goes up: a file the user already
      // has is `changed` when touched and silent until then. Announcing the whole
      // folder on boot is how a nice feature becomes something people mute.
      for (const [path, st] of scanFiles(dir)) this.#known.set(path, st);
      try {
        const watcher = watch(dir, { recursive: true, persistent: true }, (_event, filename) => {
          this.#onRawEvent(dir, filename);
        });
        watcher.on('error', (err) => this.#onWatchError(dir, err));
        this.#watchers.set(dir, watcher);
      } catch (err) {
        if (isWatcherLimit(err)) {
          // Partially armed watchers would leak if this bubbled up raw.
          this.#closeWatchers();
          this.#started = false;
          throw watcherLimitError(dir, err);
        }
        // ENOENT for a folder the user renamed an hour ago: skip it, keep the rest.
        log.warn('cannot watch a directory', { dir, ...redact({ err }) });
      }
    }
    log.info('file watcher started', { dirs: [...this.#watchers.keys()] });
  }

  /** Idempotent and total: after it returns, no timer, sleeper or listener is left. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#started = false;
    for (const timer of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
    for (const timer of this.#rescans.values()) clearTimeout(timer);
    this.#rescans.clear();
    for (const wake of this.#sleepers) wake();
    this.#sleepers.clear();
    this.#closeWatchers();
  }

  #closeWatchers(): void {
    for (const [dir, watcher] of this.#watchers) {
      try {
        watcher.removeAllListeners();
        watcher.close();
      } catch (err) {
        // One stubborn handle must not leave the rest of the watchers open.
        log.warn('could not close a directory watcher', { dir, ...redact({ err }) });
      }
    }
    this.#watchers.clear();
  }

  #onRawEvent(dir: string, filename: string | Buffer | null): void {
    // Nothing in an event handler may throw: this runs on a libuv callback where
    // an exception is an uncaught exception in the daemon.
    try {
      if (!this.#started) return;
      if (filename === null || filename === undefined) {
        this.#armRescan(dir);
        return;
      }
      this.#consider(resolve(dir, filename.toString()));
    } catch (err) {
      log.error('directory event handler failed', { dir, ...redact({ err }) });
    }
  }

  #onWatchError(dir: string, err: unknown): void {
    const message = isWatcherLimit(err)
      ? `watcher limit reached while watching ${dir}; close other watchers or raise the OS watch limit`
      : 'directory watcher failed';
    log.error(message, { dir, ...redact({ err }) });
    const watcher = this.#watchers.get(dir);
    if (watcher) {
      try {
        watcher.removeAllListeners();
        watcher.close();
      } catch {}
      this.#watchers.delete(dir);
    }
  }

  #armRescan(dir: string): void {
    const existing = this.#rescans.get(dir);
    if (existing) clearTimeout(existing);
    this.#rescans.set(
      dir,
      setTimeout(() => {
        this.#rescans.delete(dir);
        this.#rescanDir(dir);
      }, this.#debounceMs),
    );
  }

  /**
   * The answer to events without a filename. Cheap enough to also be the safety
   * net for any event `fs.watch` delivered late or not at all.
   */
  #rescanDir(dir: string): void {
    if (!this.#started) return;
    try {
      const current = scanFiles(dir);
      for (const [path, st] of current) {
        const prev = this.#known.get(path);
        if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) this.#consider(path);
      }
      const prefix = dir.endsWith(sep) ? dir : dir + sep;
      for (const path of this.#known.keys()) {
        if (path.startsWith(prefix) && !current.has(path)) this.#consider(path);
      }
    } catch (err) {
      log.error('directory rescan failed', { dir, ...redact({ err }) });
    }
  }

  /**
   * Decide whether a path is worth settling. Everything filtered here costs
   * nothing later: no timer, no stat, no callback.
   */
  #consider(path: string): void {
    if (!this.#started) return;
    if (!hasInterestingName(path) || (this.#ignore?.(path) ?? false)) return;
    if (this.#inflight.has(path)) {
      // A settle loop re-stats every round, so it picks up whatever these events
      // were about. Scheduling a second loop would double-report the same file.
      return;
    }
    const existing = this.#pending.get(path);
    if (existing) clearTimeout(existing);
    this.#pending.set(
      path,
      setTimeout(() => {
        this.#pending.delete(path);
        void this.#settle(path);
      }, this.#debounceMs),
    );
  }

  /**
   * The whole correctness of the feature lives here. Two stats with a gap
   * between them, and a report only when they agree: everything else — the
   * debounce, the name filters — is latency and noise, this is the part that
   * keeps the agent from reading a file that is still being written.
   */
  async #settle(path: string): Promise<void> {
    this.#inflight.add(path);
    try {
      for (let attempt = 0; attempt < SETTLE_ATTEMPTS && this.#started; attempt += 1) {
        const first = this.#stat(path);
        if (!first) {
          this.#reportRemoval(path);
          return;
        }
        await this.#sleep(PROBE_MS);
        if (!this.#started) return;
        const second = this.#stat(path);
        if (!second) {
          this.#reportRemoval(path);
          return;
        }
        if (second.size === first.size && second.mtimeMs === first.mtimeMs) {
          this.#reportSettled(path, second);
          return;
        }
        // Grown between the two samples: it is mid-write. Waiting is what the
        // user wants — they did drop a file and are waiting to hear it landed.
        await this.#sleep(this.#debounceMs);
        if (!this.#started) return;
      }
      log.debug('file never stopped growing; left unannounced', { path });
    } catch (err) {
      log.error('settle failed', { path, ...redact({ err }) });
    } finally {
      this.#inflight.delete(path);
    }
  }

  /** null means gone or not a regular file, which is the normal end of a temp file. */
  #stat(path: string): FileStat | null {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st?.isFile()) return null;
    return { size: st.size, mtimeMs: st.mtimeMs };
  }

  #reportSettled(path: string, st: FileStat): void {
    if (!this.#started) return;
    if (!isInterestingFile(path)) return;
    if (this.#ignore?.(path)) return;
    const prev = this.#known.get(path);
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return;
    this.#known.set(path, st);
    this.#deliver({
      path,
      kind: prev ? 'changed' : 'created',
      at: new Date().toISOString(),
      bytes: st.size,
      extension: extensionOf(path),
    });
  }

  #reportRemoval(path: string): void {
    if (!this.#started) return;
    // A path that vanished without ever being announced (a temp file renamed
    // away) has no counterpart event to pair with; saying "removed" about a file
    // the caller never heard of is noise with no referent.
    if (!this.#known.has(path)) return;
    if (!hasInterestingName(path) || (this.#ignore?.(path) ?? false)) return;
    this.#known.delete(path);
    this.#deliver({
      path,
      kind: 'removed',
      at: new Date().toISOString(),
      extension: extensionOf(path),
    });
  }

  #deliver(event: FileEvent): void {
    const now = Date.now();
    if (now - this.#windowStart >= RATE_WINDOW_MS) {
      this.#windowStart = now;
      this.#windowCount = 0;
      this.#windowWarned = false;
    }
    if (this.#windowCount >= this.#maxPerMinute) {
      this.#suppressed += 1;
      // One warning when the cap trips, then silence: a warning per dropped file
      // is the same flood the cap exists to prevent. The count is what the caller
      // reports to the user.
      if (!this.#windowWarned) {
        this.#windowWarned = true;
        log.warn('file event rate cap reached; dropping the rest of the minute', {
          path: event.path,
          kind: event.kind,
          maxPerMinute: this.#maxPerMinute,
        });
      }
      return;
    }
    this.#windowCount += 1;
    this.#events.push(event);
    if (this.#events.length > MAX_EVENT_HISTORY) this.#events.shift();
    log.info('file noticed', { path: event.path, kind: event.kind, bytes: event.bytes });
    try {
      this.#onEvent(event);
    } catch (err) {
      // A throwing consumer must cost the consumer its event, not the watcher
      // its life.
      log.error('onEvent threw; the watcher keeps running', {
        path: event.path,
        ...redact({ err }),
      });
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolveSleep) => {
      const timer = setTimeout(() => {
        this.#sleepers.delete(wake);
        resolveSleep();
      }, ms);
      const wake = (): void => {
        clearTimeout(timer);
        this.#sleepers.delete(wake);
        resolveSleep();
      };
      this.#sleepers.add(wake);
    });
  }
}
