import { describe, expect, it } from "vitest";
import { renderDeparture, shapeDepartures, shapeDisruptions, type PtvDeparturesResponse, type PtvDisruptionsResponse } from "../src/departures";
import dep from "./fixtures/departures-train.json";
import dis from "./fixtures/disruptions.json";

const now = Date.parse("2026-07-15T22:30:00Z");
const shaped = shapeDepartures(dep as unknown as PtvDeparturesResponse, now);

describe("shapeDepartures", () => {
  it("drops departures more than 60 s in the past and sorts by effective time", () => {
    expect(shaped.map((d) => d.scheduledUtc)).toEqual([
      "2026-07-15T22:29:40Z",
      "2026-07-15T22:37:00Z",
      "2026-07-15T22:42:00Z",
    ]);
  });
  it("flags live from a non-null estimate and uses it for minutes", () => {
    const live = shaped.find((d) => d.line === "Frankston" && d.directionId === 10)!;
    expect(live).toMatchObject({ live: true, minutes: 7, platform: "2", destination: "Flinders Street", disruptionIds: [900] });
    const sched = shaped.find((d) => d.line === "Craigieburn")!;
    expect(sched).toMatchObject({ live: false, minutes: 12, platform: null, destination: "Southern Cross" });
  });
  it("shows a just-passed departure as 0 minutes", () => {
    expect(shaped[0]).toMatchObject({ minutes: 0, destination: "Frankston" });
  });
});

describe("renderDeparture", () => {
  it("renders live with platform", () => {
    const d = shaped.find((x) => x.directionId === 10)!;
    expect(renderDeparture(d)).toBe("Frankston line → Flinders Street: 7 min (live), 8:37 am, Platform 2");
  });
  it("renders scheduled without platform", () => {
    const d = shaped.find((x) => x.line === "Craigieburn")!;
    expect(renderDeparture(d)).toBe("Craigieburn line → Southern Cross: 12 min (scheduled), 8:42 am");
  });
  it("renders 0 minutes as now", () => {
    expect(renderDeparture(shaped[0]!)).toBe("Frankston line → Frankston: now (scheduled), 8:29 am, Platform 1");
  });
});

describe("shapeDisruptions", () => {
  it("flattens all groups into id, title and route ids", () => {
    expect(shapeDisruptions(dis as unknown as PtvDisruptionsResponse)).toEqual([
      { id: 900, title: "Frankston line: delays due to a faulty train", routeIds: [1] },
      { id: 901, title: "Sandringham line: buses replace trains", routeIds: [9] },
    ]);
  });
});
