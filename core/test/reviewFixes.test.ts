import { describe, expect, it } from "vitest";
import { MemoryCacheStore, type CacheRuntime } from "../src/cache";
import { PtvError, type PtvClient } from "../src/client";
import { findStop, nextDepartures, PTV_DOWN, type ToolContext } from "../src/tools";

const NOW = Date.parse("2026-07-15T22:30:00Z");
const rt: CacheRuntime = { now: () => NOW, defer: () => {} };
const mk = (get: (path: string, query?: unknown) => unknown): ToolContext => ({
  client: { get: async <T>(p: string, q?: unknown) => get(p, q) as T } as PtvClient,
  live: new MemoryCacheStore(() => NOW),
  static: new MemoryCacheStore(() => NOW),
  rt,
});
const dep = (route: Record<string, unknown>, routeId: number, runRef: string, mins: number) => ({
  route_id: routeId, direction_id: 50, run_ref: runRef, disruption_ids: [], estimated_departure_utc: null,
  scheduled_departure_utc: new Date(NOW + mins * 60_000).toISOString(), platform_number: null, _route: route,
});

describe("Important 1: PTV failures are distinguished and carry a status", () => {
  const failing = (status?: number) => mk(() => { throw new PtvError("PTV failed", status); });
  it("403 means the server's credentials were rejected", async () => {
    const r = await nextDepartures(failing(403), { stop: "1007", mode: "train" });
    expect(r).toMatchObject({ isError: true, ptvStatus: 403 });
    expect(r.text).toContain("rejected the server's credentials");
  });
  it("400/404 mean PTV didn't recognise the request", async () => {
    const r = await findStop(failing(404), { query: "Ascot Vale" });
    expect(r).toMatchObject({ isError: true, ptvStatus: 404 });
    expect(r.text).toContain("didn't recognise");
  });
  it("5xx, timeouts and the upstream cap stay the generic outage message", async () => {
    expect(await nextDepartures(failing(503), { stop: "1007", mode: "train" })).toMatchObject({ text: PTV_DOWN, ptvStatus: 503 });
    const none = await nextDepartures(failing(undefined), { stop: "1007", mode: "train" });
    expect(none.text).toBe(PTV_DOWN);
    expect(none.ptvStatus).toBeUndefined();
  });
});

describe("Important 2: numeric stop id without a mode tries both route types", () => {
  const empty = { departures: [] };
  const tram = { departures: [dep({}, 5, "T1", 5)], routes: { "5": { route_name: "A - B", route_number: "58" } }, runs: { T1: { destination_name: "Toorak" } } };
  it("train empty + tram error -> no upcoming services, not an outage", async () => {
    const r = await nextDepartures(mk((p) => { if (p.includes("route_type/0")) return empty; throw new PtvError("bad", 400); }), { stop: "1007", direction: "50" });
    expect(r.text).toBe("No upcoming services at Stop 1007 in direction 50.");
    expect(r.isError).toBeUndefined();
  });
  it("train error + tram ok -> tram departures", async () => {
    const r = await nextDepartures(mk((p) => { if (p.includes("route_type/0")) throw new PtvError("bad", 400); return tram; }), { stop: "2001", direction: "50" });
    expect(r.text).toContain("Route 58 → Toorak");
  });
  it("both fail -> outage message", async () => {
    const r = await nextDepartures(mk(() => { throw new PtvError("down"); }), { stop: "1007", direction: "50" });
    expect(r).toMatchObject({ isError: true, text: PTV_DOWN });
  });
});

describe("Important 3: trams are identified by route number", () => {
  const routes = {
    "1": { route_name: "East Coburg - South Melbourne Beach", route_number: "1" },
    "2": { route_name: "Moreland - Glen Iris", route_number: "11" },
  };
  const resp = { departures: [dep({}, 1, "A", 3), dep({}, 2, "B", 6)], routes, runs: { A: { destination_name: "Coburg" }, B: { destination_name: "Glen Iris" } } };
  const ctx = () => mk((p) => (p.startsWith("/v3/departures") ? resp : { disruptions: {} }));
  it("renders trams as Route <number>", async () => {
    const r = await nextDepartures(ctx(), { stop: "2001", mode: "tram", direction: "50" });
    expect(r.text).toContain("Route 1 → Coburg: 3 min (scheduled)");
    expect(r.text).toContain("Route 11 → Glen Iris: 6 min (scheduled)");
  });
  it("route '1' matches Route 1 only, not Route 11", async () => {
    const r = await nextDepartures(ctx(), { stop: "2001", mode: "tram", direction: "50", route: "1" });
    expect(r.text).toContain("Route 1 →");
    expect(r.text).not.toContain("Route 11");
  });
  it("route '11' and route 'route 11' and a name fragment all work", async () => {
    for (const route of ["11", "route 11", "glen"]) {
      const r = await nextDepartures(ctx(), { stop: "2001", mode: "tram", direction: "50", route });
      expect(r.text, route).toContain("Route 11 →");
      expect(r.text, route).not.toContain("Route 1 →");
    }
  });
  it("find_stop lists tram routes by number", async () => {
    const search = { stops: [{ stop_id: 9, stop_name: "Bourke St/Swanston St", route_type: 1, routes: [{ route_name: "East Coburg - South Melbourne Beach", route_number: "96" }] }] };
    const r = await findStop(mk(() => search), { query: "Bourke" });
    expect(r.text).toBe("Bourke St/Swanston St (tram) id 9: Route 96");
  });
});

describe("real-data finding: PTV max_results applies per route and direction", () => {
  it("asks for 12 departures, not 40 (80 came back at a two-direction station)", async () => {
    const queries: unknown[] = [];
    const ctx = mk((p) => (p.startsWith("/v3/departures") ? { departures: [] } : { disruptions: {} }));
    const get = ctx.client.get.bind(ctx.client);
    ctx.client.get = (async (path: string, q?: unknown) => { if (path.startsWith("/v3/departures")) queries.push(q); return get(path); }) as PtvClient["get"];
    await nextDepartures(ctx, { stop: "1007", mode: "train", direction: "50" });
    expect(queries[0]).toMatchObject({ max_results: 12 });
  });
  it("expands Stop so the response names the stop (trams otherwise show 'Stop 3500')", async () => {
    const queries: Array<{ expand?: string[] }> = [];
    const ctx = mk((p) => (p.startsWith("/v3/departures") ? { departures: [] } : { disruptions: {} }));
    const get = ctx.client.get.bind(ctx.client);
    ctx.client.get = (async (path: string, q?: { expand?: string[] }) => { if (path.startsWith("/v3/departures")) queries.push(q ?? {}); return get(path); }) as PtvClient["get"];
    await nextDepartures(ctx, { stop: "1007", mode: "train", direction: "50" });
    expect(queries[0]!.expand).toContain("Stop");
  });
});

describe("buses", () => {
  const route = { "9": { route_name: "City (Queen Victoria Market) - Gardenvale", route_number: "605", route_type: 2 } };
  const busDeps = { departures: [dep({}, 9, "A", 4), dep({}, 9, "B", 9)], routes: route, runs: { A: { destination_name: "Gardenvale" }, B: { destination_name: "City" } } };
  it("labels buses as Bus <number>", async () => {
    const ctx = mk((p) => (p.startsWith("/v3/departures") ? busDeps : { disruptions: {} }));
    const r = await nextDepartures(ctx, { stop: "18479", mode: "bus", direction: "50" });
    expect(r.text).toContain("Bus 605 → Gardenvale: 4 min (scheduled)");
  });
  it("with mode bus a numeric id tries regular then night buses", async () => {
    const paths: string[] = [];
    const ctx = mk((p) => { paths.push(p); if (p.includes("route_type/2")) return { departures: [] }; if (p.includes("route_type/4")) return busDeps; return { disruptions: {} }; });
    const r = await nextDepartures(ctx, { stop: "18479", mode: "bus", direction: "50" });
    expect(paths.filter((p) => p.startsWith("/v3/departures"))).toEqual(["/v3/departures/route_type/2/stop/18479", "/v3/departures/route_type/4/stop/18479"]);
    expect(r.text).toContain("(bus) in direction 50:");
  });
  it("without a mode a numeric id only tries trains and trams, never buses", async () => {
    const paths: string[] = [];
    const ctx = mk((p) => { paths.push(p); return p.startsWith("/v3/departures") ? { departures: [] } : { disruptions: {} }; });
    await nextDepartures(ctx, { stop: "18479", direction: "50" });
    expect(paths.filter((p) => p.startsWith("/v3/departures"))).toEqual(["/v3/departures/route_type/0/stop/18479", "/v3/departures/route_type/1/stop/18479"]);
  });
  it("finds the city direction for a bus from its stop order, never via the all-routes build", async () => {
    const paths: string[] = [];
    const order = (stopSeq: number) => ({ stops: [{ stop_id: 18479, stop_sequence: stopSeq, stop_suburb: "Elwood" }, { stop_id: 1, stop_sequence: 5, stop_suburb: "Melbourne City" }, { stop_id: 2, stop_sequence: 6, stop_suburb: "Melbourne City" }] });
    const resp = { departures: [{ ...dep({}, 9, "A", 4), direction_id: 50 }, { ...dep({}, 9, "B", 9), direction_id: 51 }], routes: route, runs: { A: { destination_name: "City" }, B: { destination_name: "Gardenvale" } } };
    const ctx = mk((p, q) => {
      paths.push(p);
      if (p.startsWith("/v3/departures")) return resp;
      if (p === "/v3/disruptions") return { disruptions: {} };
      if (p === "/v3/routes") return { routes: [] };
      if (p === "/v3/stops/route/9/route_type/2") return (q as { direction_id: number }).direction_id === 50 ? order(2) : order(9);
      throw new Error(`unexpected ${p}`);
    });
    const r = await nextDepartures(ctx, { stop: "18479", mode: "bus" });
    expect(r.text).toContain("Bus 605 → City");
    expect(r.text).not.toContain("Gardenvale");
    expect(paths.filter((p) => p.startsWith("/v3/routes")).every((p) => p === "/v3/routes")).toBe(true);
  });
});
