import type { CacheEntry, CacheStore } from "@ptv/core";

/** Slow-changing data. KV is global and eventually consistent (~60 s), which is fine here. */
export class KvCacheStore implements CacheStore {
  constructor(private kv: KVNamespace) {}

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    return await this.kv.get<CacheEntry<T>>(key, "json");
  }

  async put<T>(key: string, value: T, retainSeconds: number): Promise<void> {
    const entry: CacheEntry<T> = { value, storedAt: Date.now() };
    await this.kv.put(key, JSON.stringify(entry), { expirationTtl: Math.max(retainSeconds, 60) });
  }
}

/**
 * Short-lived data. The Cache API is per data centre and does nothing on *.workers.dev,
 * so caching only takes effect on a custom domain.
 */
export class CacheApiStore implements CacheStore {
  private request = (key: string) => new Request(`https://cache.internal/${encodeURIComponent(key)}`);

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const res = await caches.default.match(this.request(key));
    return res ? ((await res.json()) as CacheEntry<T>) : null;
  }

  async put<T>(key: string, value: T, retainSeconds: number): Promise<void> {
    const entry: CacheEntry<T> = { value, storedAt: Date.now() };
    await caches.default.put(
      this.request(key),
      new Response(JSON.stringify(entry), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${retainSeconds}` },
      }),
    );
  }
}
