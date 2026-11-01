/**
 * A Map that keeps only the newest `max` keys.
 *
 * For lookups the daemon fills on every message all day long (which conversation a
 * Telegram message belongs to): a plain Map never shrinks, so an always-on PC grows
 * it for weeks. Setting a key again moves it to the newest end; past `max` the
 * oldest key goes. Old entries only matter for replies to very old messages, and
 * those already fall back to the main conversation.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  readonly max: number;

  constructor(max: number) {
    super();
    this.max = Math.max(1, Math.floor(max));
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.max) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value);
    }
    return this;
  }
}
