export interface CacheEntry<T> {
  value: T;
  /** epoch ms */
  storedAt: number;
}

export interface CacheStore {
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  put<T>(key: string, value: T, retainSeconds: number): Promise<void>;
}

export type CacheSource = "hit" | "stale" | "miss" | "stale-fallback";

export interface Cached<T> {
  value: T;
  source: CacheSource;
  warning?: string;
}

export interface CacheRuntime {
  defer(p: Promise<unknown>): void;
  now(): number;
}

export interface CachePolicy {
  /** Served as a hit up to this age. */
  freshSeconds: number;
  /** End of the stale-while-revalidate window. */
  staleSeconds: number;
  /** How long the store keeps an entry; entries past staleSeconds are only used as a fallback. */
  retainSeconds: number;
}

export const POLICIES = {
  departures: { freshSeconds: 30, staleSeconds: 60, retainSeconds: 600 },
  disruptions: { freshSeconds: 120, staleSeconds: 240, retainSeconds: 900 },
  static: { freshSeconds: 86400, staleSeconds: 172800, retainSeconds: 604800 },
} satisfies Record<string, CachePolicy>;

export class MemoryCacheStore implements CacheStore {
  private map = new Map<string, CacheEntry<unknown>>();
  constructor(private now: () => number = Date.now) {}
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    return (this.map.get(key) as CacheEntry<T> | undefined) ?? null;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, { value, storedAt: this.now() });
  }
}

export async function cached<T>(
  store: CacheStore,
  key: string,
  policy: CachePolicy,
  load: () => Promise<T>,
  rt: CacheRuntime,
): Promise<Cached<T>> {
  const entry = await store.get<T>(key);
  const ageSeconds = entry ? (rt.now() - entry.storedAt) / 1000 : Infinity;
  const refresh = async () => {
    const value = await load();
    try {
      await store.put(key, value, policy.retainSeconds);
    } catch {
      // A failed cache write (e.g. KV's one-write-per-second-per-key limit) must not fail a request PTV answered.
    }
    return value;
  };

  if (entry && ageSeconds < policy.freshSeconds) return { value: entry.value, source: "hit" };

  if (entry && ageSeconds < policy.staleSeconds) {
    rt.defer(refresh().catch(() => undefined));
    return { value: entry.value, source: "stale" };
  }

  try {
    return { value: await refresh(), source: "miss" };
  } catch (err) {
    if (entry) {
      return { value: entry.value, source: "stale-fallback", warning: "Data may be delayed." };
    }
    throw err;
  }
}
