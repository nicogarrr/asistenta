/**
 * Retire idle conversations once there are more than `max` in memory.
 *
 * Each thread holds a live agent with its whole transcript. Some per-thread state
 * lives outside the Thread object (the message a thread last answered, its factory
 * tool sync, the last turn kept for /reintentar), keyed by thread.key. Dropping the
 * thread but not those entries kept them for the life of the daemon, and the last
 * turn still pointed at the evicted agent, so its transcript was never freed.
 * Everything keyed by an evicted thread goes with it.
 */

export interface EvictableThread {
  key: string;
  chatKey: string;
  name: string;
  /** True while a turn is executing. */
  active: boolean;
  /** Touched on every use, so the oldest is the least recently used. */
  createdAt: number;
}

/** Anything keyed by thread.key that must forget an evicted thread (a Map works). */
export interface PerThreadState {
  delete(threadKey: string): unknown;
}

export interface EvictOptions<T extends EvictableThread> {
  threads: Map<string, T>;
  max: number;
  /** chatKey -> the thread name picked with /topic: never evicted. */
  selected: (chatKey: string) => string | undefined;
  perThread: readonly PerThreadState[];
  onEvict?: (thread: T) => void;
}

/** Evicts least-recently-used idle threads until at most `max` remain. Returns them. */
export function evictIdleThreads<T extends EvictableThread>(opts: EvictOptions<T>): T[] {
  const { threads, max } = opts;
  if (threads.size <= max) return [];
  const idle = [...threads.values()]
    .filter((t) => !t.active && t.name !== opts.selected(t.chatKey))
    .sort((a, b) => a.createdAt - b.createdAt);
  const evicted: T[] = [];
  while (threads.size > max && idle.length) {
    const victim = idle.shift();
    if (!victim) break;
    threads.delete(victim.key);
    for (const state of opts.perThread) state.delete(victim.key);
    evicted.push(victim);
    opts.onEvict?.(victim);
  }
  return evicted;
}
