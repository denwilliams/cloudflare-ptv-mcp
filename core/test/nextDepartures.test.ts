import { describe, expect, it } from "vitest";
import { MemoryCacheStore, type CacheRuntime } from "../src/cache";
import { PtvError, type PtvClient } from "../src/client";
import { PTV_DOWN, nextDepartures, type ToolContext } from "../src/tools";
import depFixture from "./fixtures/departures-train.json";
import disFixture from "./fixtures/disruptions.json";
import dirFixture from "./fixtures/directions.json";
import routesFixture from "./fixtures/routes.json";
import searchFixture from "./fixtures/search-ascot.json";

const T0 = Date.parse("2026-07-15T22:30:00Z");

function setup(opts: { departures?: unknown; search?: unknown } = {}) {
  let now = T0;
  const calls: string[] = [];
  const state = { fail: false };
  const client: PtvClient = {
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      if (state.fail) throw new PtvError("PTV request failed");
      if (path.startsWith("/v3/search/")) return (opts.search ?? searchFixture) as T;
      if (path.startsWith("/v3/departures/")) return (opts.departures ?? depFixture) as T;
      if (path === "/v3/disruptions") return disFixture as T;
      if (path === "/v3/routes") return routesFixture as T;
      const m = /^\/v3\/directions\/route\/(\d+)$/.exec(path);
      if (m) return (dirFixture as Record<string, unknown>)[m[1]!] as T;
      throw new Error(`unexpected ${path}`);
    },
  };
  const rt: CacheRuntime = { now: () => now, defer: () => {} };
  const ctx: ToolContext = { client, live: new MemoryCacheStore(() => now), static: new MemoryCacheStore(() => now), rt };
  return { ctx, calls, state, advance: (s: number) => (now += s * 1000), departureCalls: () => calls.filter((c) => c.startsWith("/v3/departures/")).length };
}

const many = (n: number) => ({
  departures: Array.from({ length: n }, (_, i) => ({
    route_id: 1, direction_id: 10, run_ref: "R1", disruption_ids: [], estimated_departure_utc: null,
    scheduled_departure_utc: new Date(T0 + (i + 1) * 60_000).toISOString(), platform_number: null,
  })),
  routes: { "1": { route_name: "Frankston" } },
  runs: { R1: { destination_name: "Flinders Street" } },
});

describe("nextDepartures", () => {
  it("defaults to city-bound services, rendered exactly", async () => {
    const t = setup();
    const r = await nextDepartures(t.ctx, { stop: "Ascot Vale" });
    expect(r.text.split("\n")).toEqual([
      "Ascot Vale Station (train) toward City:",
      "Frankston line → Flinders Street: 7 min (live), 8:37 am, Platform 2",
      "Craigieburn line → Southern Cross: 12 min (scheduled), 8:42 am",
      "",
      "Disruptions:",
      "- Frankston line: delays due to a faulty train",
    ]);
    expect(r.isError).toBeUndefined();
  });

  it("lists outbound services for direction=outbound", async () => {
    const r = await nextDepartures(setup().ctx, { stop: "Ascot Vale", direction: "outbound" });
    expect(r.text).toContain("Frankston line → Frankston: now (scheduled)");
    expect(r.text).not.toContain("Flinders Street");
  });

  it("filters by a numeric direction ID", async () => {
    const r = await nextDepartures(setup().ctx, { stop: "Ascot Vale", direction: "20" });
    expect(r.text).toContain("Craigieburn line");
    expect(r.text).not.toContain("Frankston line");
  });

  it("filters by route name substring", async () => {
    const r = await nextDepartures(setup().ctx, { stop: "Ascot Vale", route: "craig" });
    expect(r.text).toContain("Craigieburn line");
    expect(r.text).not.toContain("Frankston line →");
  });

  it("clamps limit to 1..10", async () => {
    const lines = (s: string) => s.split("\n").filter((l) => l.includes("line →")).length;
    const t = setup({ departures: many(12) });
    expect(lines((await nextDepartures(t.ctx, { stop: "1007", mode: "train", limit: 0 })).text)).toBe(1);
    expect(lines((await nextDepartures(t.ctx, { stop: "1007", mode: "train", limit: 99 })).text)).toBe(10);
    expect(lines((await nextDepartures(t.ctx, { stop: "1007", mode: "train" })).text)).toBe(5);
  });

  it("returns candidates and makes no departures call for an ambiguous name", async () => {
    const t = setup({
      search: { stops: [
        { stop_id: 1, stop_name: "Flinders Street Station", route_type: 0, routes: [] },
        { stop_id: 2, stop_name: "Flinders Street Station", route_type: 1, routes: [] },
      ] },
    });
    const r = await nextDepartures(t.ctx, { stop: "Flinders Street" });
    expect(r.text).toContain("Which one did you mean?");
    expect(r.text).toContain("id 1");
    expect(r.text).toContain("id 2");
    expect(t.departureCalls()).toBe(0);
  });

  it("skips search for a numeric stop ID and names the stop from the response", async () => {
    const t = setup();
    const r = await nextDepartures(t.ctx, { stop: "1007" });
    expect(t.calls.some((c) => c.startsWith("/v3/search/"))).toBe(false);
    expect(r.text.startsWith("Ascot Vale Station (train) toward City:")).toBe(true);
  });

  it("reports no stops found plainly", async () => {
    const r = await nextDepartures(setup({ search: { stops: [] } }).ctx, { stop: "Nowhere" });
    expect(r).toMatchObject({ text: "No stops found for “Nowhere”. Searched trains and trams; pass mode \"bus\" to search buses." });
    expect(r.isError).toBeUndefined();
  });

  it("serves a repeat call within 30 s from cache", async () => {
    const t = setup();
    await nextDepartures(t.ctx, { stop: "1007", mode: "train" });
    t.advance(10);
    const r = await nextDepartures(t.ctx, { stop: "1007", mode: "train" });
    expect(t.departureCalls()).toBe(1);
    expect(r.cache).toBe("hit");
  });

  it("says so when there are no upcoming services", async () => {
    const r = await nextDepartures(setup({ departures: { departures: [] } }).ctx, { stop: "1007", mode: "train" });
    expect(r.text).toBe("No upcoming services at Stop 1007 toward City.");
  });

  it("names lines with no resolvable city direction when that empties the result", async () => {
    const only = { ...depFixture, departures: depFixture.departures.filter((d) => d.route_id === 1) };
    const t = setup({ departures: { ...only, routes: { "1": { route_name: "Frankston" }, "7": { route_name: "Mystery" } }, departures: [{ ...only.departures[0], route_id: 7 }] } });
    const r = await nextDepartures(t.ctx, { stop: "1007", mode: "train" });
    expect(r.text).toContain("No upcoming services");
    expect(r.text).toContain("Couldn't determine the city direction for: Mystery");
  });

  it("only lists disruptions on returned routes", async () => {
    const r = await nextDepartures(setup().ctx, { stop: "Ascot Vale", route: "craig" });
    expect(r.text).not.toContain("Disruptions:");
  });

  it("falls back to stale data with a warning when PTV fails", async () => {
    const t = setup();
    await nextDepartures(t.ctx, { stop: "1007", mode: "train" });
    t.advance(70);
    t.state.fail = true;
    const r = await nextDepartures(t.ctx, { stop: "1007", mode: "train" });
    expect(r.cache).toBe("stale-fallback");
    expect(r.text).toContain("may be delayed");
    expect(r.text).toContain("Frankston line → Flinders Street");
  });

  it("returns a readable error with no URL material when PTV fails and nothing is cached", async () => {
    const t = setup();
    t.state.fail = true;
    const r = await nextDepartures(t.ctx, { stop: "1007", mode: "train" });
    expect(r).toMatchObject({ isError: true, text: PTV_DOWN });
    expect(r.text).not.toMatch(/devid|signature|timetableapi/i);
  });

  it("rejects an empty stop and an unknown direction", async () => {
    const t = setup();
    expect((await nextDepartures(t.ctx, { stop: " " })).isError).toBe(true);
    expect((await nextDepartures(t.ctx, { stop: "1007", direction: "sideways" })).isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });
});
