import { describe, expect, it } from "vitest";
import { formatMelbourneTime, minutesAway } from "../src/time";

describe("formatMelbourneTime", () => {
  it("uses AEDT (+11) in summer", () => expect(formatMelbourneTime("2026-01-15T22:42:00Z")).toBe("9:42 am"));
  it("uses AEST (+10) in winter", () => expect(formatMelbourneTime("2026-07-15T22:42:00Z")).toBe("8:42 am"));
  it("formats just after midnight and noon", () => {
    expect(formatMelbourneTime("2026-07-15T14:05:00Z")).toBe("12:05 am");
    expect(formatMelbourneTime("2026-07-15T02:00:00Z")).toBe("12:00 pm");
  });
  it("handles the 5 Apr 2026 DST end (03:00 AEDT -> 02:00 AEST)", () => {
    expect(formatMelbourneTime("2026-04-04T15:30:00Z")).toBe("2:30 am"); // AEDT
    expect(formatMelbourneTime("2026-04-04T16:30:00Z")).toBe("2:30 am"); // AEST, repeated hour
    expect(formatMelbourneTime("2026-04-04T18:00:00Z")).toBe("4:00 am");
  });
});

describe("minutesAway", () => {
  const now = Date.parse("2026-07-15T22:30:00Z");
  it("floors whole minutes", () => expect(minutesAway("2026-07-15T22:35:40Z", now)).toBe(5));
  it("never goes negative", () => expect(minutesAway("2026-07-15T22:29:40Z", now)).toBe(0));
});
