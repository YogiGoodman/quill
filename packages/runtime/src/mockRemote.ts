/**
 * A tiny in-memory stand-in for a remote system (Stripe, a trading API, …)
 * that deduplicates by idempotency key. It is the target a `side_effect` tool's
 * `reconcile` function queries during INDETERMINATE recovery.
 *
 * `apply` is idempotent: the first write for a key wins; later writes with the
 * same key return the stored record unchanged. This is exactly the property the
 * runtime relies on so a replayed side effect cannot fire twice.
 */
export class MockRemote<T = unknown> {
  private readonly store = new Map<string, T>();

  /** Record `payload` under `key` once. Returns the stored record. */
  apply(key: string, payload: T): T {
    const existing = this.store.get(key);
    if (existing !== undefined) {
      return existing;
    }
    this.store.set(key, payload);
    return payload;
  }

  /** Return the record for `key`, or `null` if none exists. */
  lookupByKey(key: string): T | null {
    const record = this.store.get(key);
    return record === undefined ? null : record;
  }

  /** Number of distinct keys applied — handy for asserting no double-fire. */
  get size(): number {
    return this.store.size;
  }
}
