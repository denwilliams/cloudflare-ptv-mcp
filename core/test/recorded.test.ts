import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryCacheStore } from "../src/cache";
import type { PtvClient } from "../src/client";
import { shapeDepartures, shapeDisruptions, type PtvDeparturesResponse, type PtvDisruptionsResponse } from "../src/departures";
import { searchStops } from "../src/stops";

// Contract checks against real PTV responses. They activate once
// `npx tsx scripts/record-fixtures.ts` has produced core/test/fixtures/recorded/.
const dir = new URL("./fixtures/recorded/", import.meta.url);
const load = <T>(f: string) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as T;
const has = (f: string) => existsSync(new URL(f, dir));

describe("recorded PTV responses", () => {
  it.skipIf(!has("departures.json"))("shape into departures with real names", () => {
    const deps = shapeDepartures(load<PtvDeparturesResponse>("departures.json"), 0);
    expect(deps.length).toBeGreaterThan(0);
    for (const d of deps) {
      expect(d.line).not.toMatch(/^Route \d+$/);
      expect(d.destination).not.toBe("Unknown");
      expect(Number.isFinite(Date.parse(d.scheduledUtc))).toBe(true);
    }
  });

  it.skipIf(!has("disruptions.json"))("shape into disruptions", () => {
    for (const d of shapeDisruptions(load<PtvDisruptionsResponse>("disruptions.json"))) {
      expect(typeof d.id).toBe("number");
      expect(d.title).toBeTruthy();
    }
  });

  it.skipIf(!has("search-ascot.json"))("search yields train/tram stops with ids", async () => {
    const client = { get: async () => load("search-ascot.json") } as unknown as PtvClient;
    const res = await searchStops(client, new MemoryCacheStore(), { now: () => 0, defer: () => {} }, "Ascot Vale");
    expect(res.value.length).toBeGreaterThan(0);
    expect(res.value.every((s) => Number.isInteger(s.stopId))).toBe(true);
  });
});
