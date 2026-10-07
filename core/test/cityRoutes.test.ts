import { describe, expect, it } from "vitest";
import { MemoryCacheStore, type CacheRuntime } from "../src/cache";
import type { PtvClient } from "../src/client";
import { getCityRoutes, isCityName } from "../src/cityRoutes";
import routes from "./fixtures/routes.json";
import directions from "./fixtures/directions.json";

function setup() {
  const calls: string[] = [];
  const client: PtvClient = {
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      if (path === "/v3/routes") return routes as T;
      const m = /^\/v3\/directions\/route\/(\d+)$/.exec(path);
      if (m) return (directions as Record<string, unknown>)[m[1]!] as T;
      throw new Error(`unexpected ${path}`);
    },
  };
  const rt: CacheRuntime = { now: () => 0, defer: () => {} };
  return { calls, client, rt, store: new MemoryCacheStore(() => 0) };
}

describe("getCityRoutes", () => {
  it("maps the city-named direction and lists the others as outbound", async () => {
    const t = setup();
    const cr = await getCityRoutes(t.client, t.store, t.rt);
    expect(cr[1]).toEqual({ routeId: 1, routeType: 0, name: "Frankston", cityDirectionId: 10, outboundDirectionIds: [11] });
    expect(cr[2]).toMatchObject({ cityDirectionId: 20, outboundDirectionIds: [21] });
  });

  it("ignores non train/tram routes", async () => {
    const t = setup();
    const cr = await getCityRoutes(t.client, t.store, t.rt);
    expect(cr[100]).toBeUndefined();
    expect(t.calls.some((c) => c.endsWith("/100"))).toBe(false);
  });

  it("omits routes with two city-named directions", async () => {
    const t = setup();
    expect((await getCityRoutes(t.client, t.store, t.rt))[5]).toBeUndefined();
  });

  it("includes such a route when an override names its city direction", async () => {
    const t = setup();
    const cr = await getCityRoutes(t.client, t.store, t.rt, { overrides: { 5: 50 } });
    expect(cr[5]).toEqual({ routeId: 5, routeType: 1, name: "Route 58", cityDirectionId: 50, outboundDirectionIds: [51] });
  });

  it("makes no client calls on a second call", async () => {
    const t = setup();
    await getCityRoutes(t.client, t.store, t.rt);
    const n = t.calls.length;
    await getCityRoutes(t.client, t.store, t.rt);
    expect(t.calls.length).toBe(n);
  });

  it("calls the client again when forced", async () => {
    const t = setup();
    await getCityRoutes(t.client, t.store, t.rt);
    const n = t.calls.length;
    await getCityRoutes(t.client, t.store, t.rt, { force: true });
    expect(t.calls.length).toBe(n * 2);
  });
});

describe("isCityName", () => {
  it.each([
    ["City (Flinders Street)", true],
    ["Flinders Street", true],
    ["Southern Cross", true],
    ["Melbourne Central", true],
    ["Parliament", true],
    ["Flagstaff", true],
    ["Town Hall", true],
    ["State Library", true],
    ["Frankston", false],
    ["Elizabeth St", false],
    ["Electricity", false],
  ])("%s -> %s", (name, expected) => expect(isCityName(name)).toBe(expected));
});
