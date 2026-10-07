import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { signedUrl } from "../src/signing";

const hmac = (s: string) => createHmac("sha1", "secret").update(s).digest("hex").toUpperCase();

it("appends devid and an uppercase hex HMAC-SHA1 signature", async () => {
  const url = await signedUrl("/v3/routes", "1234567", "secret");
  expect(url).toBe(
    `https://timetableapi.ptv.vic.gov.au/v3/routes?devid=1234567&signature=${hmac("/v3/routes?devid=1234567")}`,
  );
});

it("uses & to append devid when the path already has a query", async () => {
  const url = await signedUrl("/v3/departures?max_results=5", "1234567", "secret");
  expect(url).toBe(
    `https://timetableapi.ptv.vic.gov.au/v3/departures?max_results=5&devid=1234567&signature=${hmac("/v3/departures?max_results=5&devid=1234567")}`,
  );
});
