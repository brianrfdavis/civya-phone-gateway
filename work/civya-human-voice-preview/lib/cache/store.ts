/**
 * Key-value store abstraction. The PoC uses the in-memory implementation;
 * a Redis-backed implementation can replace it later without touching callers
 * (create a RedisStore implementing CacheStore and swap it in getStore()).
 */
export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
}

class InMemoryStore implements CacheStore {
  private map = new Map<string, { value: unknown; expiresAt: number | null }>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.map.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }
}

// Module-level singleton survives across requests in a single server process.
const store: CacheStore = new InMemoryStore();

export function getStore(): CacheStore {
  return store;
}
