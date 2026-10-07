import { describe, expect, it } from "vitest";
import { MemoryCacheStore, type CacheRuntime } from "../src/cache";
import { PtvError, type PtvClient } from "../src/client";
import { getStopOrder, headsTowardCity } from "../src/stopOrder";
import { nextDepartures, type ToolContext } from "../src/tools";
import dirFixture from "./fixtures/directions.json";
import routesFixture from "./fixtures/routes.json";

const NOW = Date.parse("2026-07-15T22:30:00Z");
const rt: CacheRuntime = { now: () => NOW, defer: () => {} };
const stop = (id: number, seq: number, suburb: string) => ({ stop_id: id, stop_sequence: seq, stop_suburb: suburb, stop_name: `Stop ${id}` });
// Rows are deliberately out of sequence order, as PTV returns them.
const northToSouth = { stops: [stop(4, 10, "South Melbourne"), stop(1, 0, "Brunswick East"), stop(3, 6, "Melbourne City"), stop(2, 5, "Melbourne City")] };

describe("getStopOrder", () => {
  it("maps stop id to sequence and records the CBD sequences, cached for next time", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = { get: async (p: string, q: unknown) => (calls.push([p, q]), northToSouth) } as unknown as PtvClient;
    const store = new MemoryCacheStore(() => NOW);
    const order = await getStopOrder(client, store, rt, 721, 1, 0);
    expect(order).toEqual({ seq: { 1: 0, 2: 5, 3: 6, 4: 10 }, cbd: [5, 6] });
    expect(calls[0]).toEqual(["/v3/stops/route/721/route_type/1", { direction_id: 0 }]);
    await getStopOrder(client, store, rt, 721, 1, 0);
    expect(calls).toHaveLength(1);
  });
});

describe("headsTowardCity", () => {
  const order = { seq: { 1: 0, 2: 5, 3: 6, 4: 10 }, cbd: [5, 6] };
  it("is true before the CBD, false after it", () => {
    expect(headsTowardCity(order, 1)).toBe(true);
    expect(headsTowardCity(order, 4)).toBe(false);
  });
  it("inside the CBD it is true only while CBD stops remain ahead", () => {
    expect(headsTowardCity(order, 2)).toBe(true);
    expect(headsTowardCity(order, 3)).toBe(false);
  });
  it("is undefined for an unknown stop or a route that never reaches the CBD", () => {
    expect(headsTowardCity(order, 99)).toBeUndefined();
    expect(headsTowardCity({ seq: { 1: 0 }, cbd: [] }, 1)).toBeUndefined();
  });
});

describe("next_departures on a route with no name-resolved city direction", () => {
  // Route 5 (tram) has two city-named directions in the fixtures, so name matching omits it.
  const departure = (dirId: number, mins: number, run: string) => ({
    route_id: 5, direction_id: dirId, run_ref: run, disruption_ids: [], estimated_departure_utc: null, platform_number: null,
    scheduled_departure_utc: new Date(NOW + mins * 60_000).toISOString(),
  });
  const orders: Record<number, unknown> = {
    50: { stops: [stop(2001, 2, "Carlton"), stop(8, 5, "Melbourne City"), stop(9, 6, "Melbourne City")] }, // 2001 is before the CBD
    51: { stops: [stop(2001, 8, "Carlton"), stop(8, 1, "Melbourne City"), stop(9, 2, "Melbourne City")] }, // 2001 is after it
  };
  const make = (stopOrderFails = false): ToolContext => ({
    client: {
      async get<T>(path: string, q?: { direction_id?: number }): Promise<T> {
        if (path.startsWith("/v3/departures/"))
          return { departures: [departure(50, 3, "A"), departure(51, 6, "B")], routes: { "5": { route_name: "A - B", route_number: "58" } }, runs: { A: { destination_name: "Toorak" }, B: { destination_name: "West Coburg" } } } as T;
        if (path === "/v3/disruptions") return { disruptions: {} } as T;
        if (path === "/v3/routes") return routesFixture as T;
        const d = /^\/v3\/directions\/route\/(\d+)$/.exec(path);
        if (d) return (dirFixture as Record<string, unknown>)[d[1]!] as T;
        if (path === "/v3/stops/route/5/route_type/1") {
          if (stopOrderFails) throw new PtvError("nope", 500);
          return orders[q!.direction_id!] as T;
        }
        throw new Error(`unexpected ${path}`);
      },
    },
    live: new MemoryCacheStore(() => NOW), static: new MemoryCacheStore(() => NOW), rt,
  });

  it("city returns the direction whose route reaches the CBD from this stop", async () => {
    const r = await nextDepartures(make(), { stop: "2001", mode: "tram" });
    expect(r.text).toContain("Route 58 → Toorak");
    expect(r.text).not.toContain("West Coburg");
  });
  it("outbound returns the other direction", async () => {
    const r = await nextDepartures(make(), { stop: "2001", mode: "tram", direction: "outbound" });
    expect(r.text).toContain("Route 58 → West Coburg");
    expect(r.text).not.toContain("Toorak");
  });
  it("a failed stop-order lookup reports the line as undetermined instead of failing the call", async () => {
    const r = await nextDepartures(make(true), { stop: "2001", mode: "tram" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("Couldn't determine the city direction for: Route 58");
  });
});
