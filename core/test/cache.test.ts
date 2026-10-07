import { describe, expect, it } from "vitest";
import { MemoryCacheStore, POLICIES, cached, type CacheRuntime } from "../src/cache";

function setup() {
  let now = 1_000_000;
  const deferred: Promise<unknown>[] = [];
  const rt: CacheRuntime = { now: () => now, defer: (p) => void deferred.push(p) };
  const store = new MemoryCacheStore(() => now);
  let loads = 0;
  const ok = async () => ({ n: ++loads });
  return {
    rt,
    store,
    deferred,
    advance: (s: number) => (now += s * 1000),
    loads: () => loads,
    ok,
  };
}
const policy = POLICIES.departures; // fresh 30, stale 60, retain 600

describe("cached", () => {
  it("loads and stores on an empty cache (miss)", async () => {
    const t = setup();
    const r = await cached(t.store, "k", policy, t.ok, t.rt);
    expect(r).toMatchObject({ source: "miss", value: { n: 1 } });
    expect(t.loads()).toBe(1);
    expect(await t.store.get("k")).not.toBeNull();
  });

  it("returns a hit without loading when fresh", async () => {
    const t = setup();
    await cached(t.store, "k", policy, t.ok, t.rt);
    t.advance(10);
    const r = await cached(t.store, "k", policy, t.ok, t.rt);
    expect(r).toMatchObject({ source: "hit", value: { n: 1 } });
    expect(t.loads()).toBe(1);
  });

  it("serves stale immediately and refreshes in the background", async () => {
    const t = setup();
    await cached(t.store, "k", policy, t.ok, t.rt);
    t.advance(45);
    const r = await cached(t.store, "k", policy, t.ok, t.rt);
    expect(r).toMatchObject({ source: "stale", value: { n: 1 } });
    await Promise.all(t.deferred);
    expect((await t.store.get<{ n: number }>("k"))?.value).toEqual({ n: 2 });
  });

  it("keeps the old entry when the background refresh fails", async () => {
    const t = setup();
    await cached(t.store, "k", policy, t.ok, t.rt);
    t.advance(45);
    await cached(t.store, "k", policy, async () => {
      throw new Error("boom");
    }, t.rt);
    await Promise.all(t.deferred); // must not reject
    expect((await t.store.get<{ n: number }>("k"))?.value).toEqual({ n: 1 });
  });

  it("reloads (miss) when older than the stale window", async () => {
    const t = setup();
    await cached(t.store, "k", policy, t.ok, t.rt);
    t.advance(70);
    const r = await cached(t.store, "k", policy, t.ok, t.rt);
    expect(r).toMatchObject({ source: "miss", value: { n: 2 } });
  });

  it("falls back to the old entry with a warning when the load fails", async () => {
    const t = setup();
    await cached(t.store, "k", policy, t.ok, t.rt);
    t.advance(70);
    const r = await cached(t.store, "k", policy, async () => {
      throw new Error("down");
    }, t.rt);
    expect(r.source).toBe("stale-fallback");
    expect(r.value).toEqual({ n: 1 });
    expect(r.warning).toContain("may be delayed");
  });

  it("propagates the error when nothing is cached", async () => {
    const t = setup();
    await expect(
      cached(t.store, "k", policy, async () => {
        throw new Error("down");
      }, t.rt),
    ).rejects.toThrow("down");
  });
});
