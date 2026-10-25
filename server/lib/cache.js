/**
 * Tiny TTL cache with in-flight de-duplication and LRU eviction.
 * One process, one map — no dependency needed.
 */
export class Cache {
  constructor({ max = 1200, ttl = 60_000 } = {}) {
    this.max = max;
    this.ttl = ttl;
    this.entries = new Map();
    this.inflight = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  read(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // refresh recency
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  write(key, value, ttl = this.ttl) {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + ttl });
    return value;
  }

  async wrap(key, ttl, loader) {
    const hit = this.read(key);
    if (hit !== undefined) {
      this.hits += 1;
      return hit;
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    this.misses += 1;
    const task = (async () => {
      try {
        const value = await loader();
        this.write(key, value, ttl);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, task);
    return task;
  }

  stats() {
    return { size: this.entries.size, inflight: this.inflight.size, hits: this.hits, misses: this.misses };
  }

  clear() {
    this.entries.clear();
  }
}
