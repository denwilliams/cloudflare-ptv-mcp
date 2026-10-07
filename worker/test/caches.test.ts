import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CacheApiStore, KvCacheStore } from "../src/caches";

describe.each([
  ["KvCacheStore", () => new KvCacheStore(env.PTV_CACHE)],
  ["CacheApiStore", () => new CacheApiStore()],
])("%s", (_name, make) => {
  it("round-trips a value with a storedAt timestamp", async () => {
    const store = make();
    const before = Date.now();
    await store.put("k:1", { a: [1, 2] }, 120);
    const got = await store.get<{ a: number[] }>("k:1");
    expect(got?.value).toEqual({ a: [1, 2] });
    expect(got!.storedAt).toBeGreaterThanOrEqual(before);
  });
  it("returns null for a missing key", async () => {
    expect(await make().get("nope")).toBeNull();
  });
});
