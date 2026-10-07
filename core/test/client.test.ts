import { expect, it } from "vitest";
import { PtvError, createPtvClient } from "../src/client";

const creds = { devId: "1234567", apiKey: "secret" };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

it("sends repeated params for array query values and skips undefined", async () => {
  let requested = "";
  const client = createPtvClient(creds, {
    fetch: async (u) => {
      requested = String(u);
      return ok({});
    },
  });
  await client.get("/v3/routes", { route_types: [0, 1], skip: undefined });
  expect(requested).toContain("/v3/routes?route_types=0&route_types=1&devid=1234567&signature=");
  expect(requested).not.toContain("skip");
});

it("throws PtvError with status and no URL material on non-2xx", async () => {
  const client = createPtvClient(creds, { fetch: async () => new Response("no", { status: 403 }) });
  const err = (await client.get("/v3/routes").catch((e) => e)) as PtvError;
  expect(err).toBeInstanceOf(PtvError);
  expect(err.status).toBe(403);
  expect(err.message).not.toMatch(/devid|signature|timetableapi|1234567/i);
});

it("rejects with PtvError after timeoutMs", async () => {
  const client = createPtvClient(creds, {
    timeoutMs: 10,
    fetch: (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
  });
  const err = (await client.get("/v3/routes").catch((e) => e)) as PtvError;
  expect(err).toBeInstanceOf(PtvError);
  expect(err.message).not.toMatch(/devid|signature|timetableapi|1234567/i);
});

it("throws PtvError without fetching when the guard says the cap is hit", async () => {
  let called = false;
  const client = createPtvClient(creds, {
    guard: async () => false,
    fetch: async () => {
      called = true;
      return ok({});
    },
  });
  await expect(client.get("/v3/routes")).rejects.toBeInstanceOf(PtvError);
  expect(called).toBe(false);
});
