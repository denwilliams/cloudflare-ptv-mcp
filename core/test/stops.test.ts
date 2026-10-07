import { describe, expect, it } from "vitest";
import { MemoryCacheStore, type CacheRuntime } from "../src/cache";
import { PtvError, type PtvClient } from "../src/client";
import { resolveStop, type StopMatch } from "../src/stops";
import { findStop, type ToolContext } from "../src/tools";
import search from "./fixtures/search-ascot.json";

function ctx(response: unknown = search) {
  const paths: string[] = [];
  const queries: unknown[] = [];
  const client: PtvClient = {
    async get<T>(path: string, query?: unknown): Promise<T> {
      paths.push(path);
      queries.push(query);
      return response as T;
    },
  };
  const rt: CacheRuntime = { now: () => 0, defer: () => {} };
  const c: ToolContext = { client, live: new MemoryCacheStore(() => 0), static: new MemoryCacheStore(() => 0), rt };
  return { c, paths, queries };
}

describe("findStop", () => {
  it("never puts / & ? # in the search path (PTV answers 403); searches on the first street instead", async () => {
    const a = ctx();
    await findStop(a.c, { query: "St Kilda Rd/Domain Rd" });
    expect(a.paths[0]).toBe("/v3/search/St%20Kilda%20Rd");
    const b = ctx();
    await findStop(b.c, { query: "Café & Bar?" });
    expect(b.paths[0]).toBe("/v3/search/Caf%C3%A9");
    const c = ctx();
    await findStop(c.c, { query: "/ & ?" });
    expect(c.paths).toHaveLength(0);
  });

  it("filters a cross-street query by the other street, falling back to all results", async () => {
    const resp = { stops: [
      { stop_id: 1, stop_name: "Bourke St/Spring St #9", route_type: 1, routes: [] },
      { stop_id: 2, stop_name: "Bourke St/Swanston St #8", route_type: 1, routes: [] },
    ] };
    const hit = await findStop(ctx(resp).c, { query: "Bourke St/Swanston St" });
    expect(hit.text).toBe("Bourke St/Swanston St #8 (tram) id 2");
    const miss = await findStop(ctx(resp).c, { query: "Bourke St/Nowhere St" });
    expect(miss.text.split("\n")).toHaveLength(2);
  });

  it("trims the trailing spaces PTV leaves on stop names", async () => {
    const resp = { stops: [{ stop_id: 3, stop_name: "Ascot Vale Rd/Maribyrnong Rd #34 ", stop_suburb: "Moonee Ponds", route_type: 1, routes: [] }] };
    const r = await findStop(ctx(resp).c, { query: "Ascot Vale Rd" });
    expect(r.text).toBe("Ascot Vale Rd/Maribyrnong Rd #34 (tram, Moonee Ponds) id 3");
  });

  it("rejects an empty query without calling PTV", async () => {
    const a = ctx();
    const r = await findStop(a.c, { query: "   " });
    expect(r).toMatchObject({ isError: true, text: "Give a stop name to search for." });
    expect(a.paths).toHaveLength(0);
  });

  it("reports no matches plainly, not as an error", async () => {
    const a = ctx({ stops: [], routes: [], outlets: [] });
    const r = await findStop(a.c, { query: "Nowhere" });
    expect(r.text).toBe("No stops found for “Nowhere”.");
    expect(r.isError).toBeUndefined();
  });

  it("by default lists trains and trams only, even if PTV sent a bus stop", async () => {
    const r = await findStop(ctx().c, { query: "Ascot Vale" });
    expect(r.text.split("\n")).toEqual([
      "Ascot Vale Station (train, Ascot Vale) id 1007: Craigieburn, Upfield",
      "Ascot Vale Rd/Union Rd #1 (tram, Ascot Vale) id 2001: Route 59",
    ]);
  });

  it("mode bus lists bus stops, labelled by bus number", async () => {
    const r = await findStop(ctx().c, { query: "Ascot Vale", mode: "bus" });
    expect(r.text).toBe("Ascot Vale Rd/Bus Stop (bus, Ascot Vale) id 3001: Bus 200");
  });

  it("sorts trains before trams regardless of PTV's order", async () => {
    const resp = { stops: [
      { stop_id: 3, stop_name: "T", route_type: 1, routes: [] },
      { stop_id: 4, stop_name: "R", route_type: 0, routes: [] },
    ] };
    const r = await findStop(ctx(resp).c, { query: "x" });
    expect(r.text.split("\n").map((l) => l.split(" ")[0])).toEqual(["R", "T"]);
  });

  it("mode bus includes night buses (route type 4)", async () => {
    const resp = { stops: [
      { stop_id: 1, stop_name: "Day", route_type: 2, routes: [] },
      { stop_id: 2, stop_name: "Night", route_type: 4, routes: [] },
    ] };
    const r = await findStop(ctx(resp).c, { query: "x", mode: "bus" });
    expect(r.text.split("\n").map((l) => l.split(" ")[0])).toEqual(["Day", "Night"]);
  });

  it("drops V/Line (route type 3)", async () => {
    const resp = { stops: [{ stop_id: 1, stop_name: "Geelong", route_type: 3, routes: [] }] };
    expect((await findStop(ctx(resp).c, { query: "Geelong" })).text).toBe("No stops found for “Geelong”.");
  });

  it("mode bus searches regular and night buses", async () => {
    const a = ctx();
    await findStop(a.c, { query: "Chapel St", mode: "bus" });
    expect(a.queries[0]).toMatchObject({ route_types: [2, 4] });
  });

  it("with no mode searches trains and trams only", async () => {
    const a = ctx();
    await findStop(a.c, { query: "Chapel St" });
    expect(a.queries[0]).toMatchObject({ route_types: [0, 1] });
  });

  it("caps the list at 10 and says how many more there are", async () => {
    const resp = { stops: Array.from({ length: 13 }, (_, i) => ({ stop_id: i + 1, stop_name: `Stop ${i + 1}`, route_type: 1, routes: [] })) };
    const lines = (await findStop(ctx(resp).c, { query: "Stop" })).text.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe("…and 3 more. Add a mode or a fuller stop name to narrow the search.");
  });

  it("restricts route types by mode", async () => {
    const a = ctx();
    await findStop(a.c, { query: "Ascot Vale", mode: "tram" });
    expect(a.queries[0]).toMatchObject({ route_types: [1] });
  });

  it("serves a repeat search from cache with one client call", async () => {
    const a = ctx();
    await findStop(a.c, { query: "Ascot Vale" });
    const r = await findStop(a.c, { query: "  ascot   vale " });
    expect(a.paths).toHaveLength(1);
    expect(r.cache).toBe("hit");
  });
});

describe("findStop when PTV is down", () => {
  it("returns a short readable error with no URL material", async () => {
    const a = ctx();
    const failing: PtvClient = {
      async get() {
        throw new PtvError("PTV request failed");
      },
    };
    const r = await findStop({ ...a.c, client: failing }, { query: "Ascot Vale" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("PTV isn't responding right now. Try again shortly.");
  });
});

describe("resolveStop", () => {
  const stop = (stopId: number, name: string, routeType: 0 | 1 = 0): StopMatch => ({ stopId, name, routeType, suburb: null, routes: [] });
  it("picks the single exact normalised-name match among several", () => {
    const ms = [stop(1, "Ascot Vale Station"), stop(2, "Ascot Vale Rd/Union Rd", 1)];
    expect(resolveStop(ms, "Ascot Vale")).toEqual({ kind: "one", stop: ms[0] });
  });
  it("returns many when two stops match exactly", () => {
    const ms = [stop(1, "Flinders Street Station"), stop(2, "Flinders Street Station", 1)];
    expect(resolveStop(ms, "flinders street")).toEqual({ kind: "many", candidates: ms });
  });
  it("uses the only result when nothing matches exactly", () => {
    const ms = [stop(1, "Ascot Vale Station")];
    expect(resolveStop(ms, "ascot")).toEqual({ kind: "one", stop: ms[0] });
  });
  it("returns none for no matches and caps candidates at 5", () => {
    expect(resolveStop([], "x")).toEqual({ kind: "none" });
    const many = [1, 2, 3, 4, 5, 6, 7].map((i) => stop(i, `Thing ${i}`));
    const r = resolveStop(many, "thing");
    expect(r.kind === "many" && r.candidates).toHaveLength(5);
  });
});
