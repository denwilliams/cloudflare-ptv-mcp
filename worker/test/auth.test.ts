import { describe, expect, it } from "vitest";
import { redactedPath, tokenValid } from "../src/auth";

const u = (q: string) => new URL(`https://x/mcp${q}`);

describe("tokenValid", () => {
  it("accepts the correct token", async () => expect(await tokenValid(u("?token=abc"), "abc")).toBe(true));
  it("rejects a wrong token", async () => expect(await tokenValid(u("?token=abd"), "abc")).toBe(false));
  it("rejects a missing or empty token", async () => {
    expect(await tokenValid(u(""), "abc")).toBe(false);
    expect(await tokenValid(u("?token="), "abc")).toBe(false);
  });
  it("rejects everything when the expected secret is empty or unset", async () => {
    expect(await tokenValid(u("?token="), "")).toBe(false);
    expect(await tokenValid(u("?token=abc"), "")).toBe(false);
    expect(await tokenValid(u("?token=abc"), undefined as unknown as string)).toBe(false);
  });
  it("rejects a token that is a prefix of the real one", async () => expect(await tokenValid(u("?token=ab"), "abc")).toBe(false));
});

describe("tokenValid with the x-api-key header", () => {
  const h = (v: string) => new Headers({ "x-api-key": v });
  it("accepts the correct header with no query token", async () =>
    expect(await tokenValid(u(""), "abc", h("abc"))).toBe(true));
  it("rejects a wrong header with no query token", async () =>
    expect(await tokenValid(u(""), "abc", h("abd"))).toBe(false));
  it("accepts either credential when the other is wrong", async () => {
    expect(await tokenValid(u("?token=abc"), "abc", h("wrong"))).toBe(true);
    expect(await tokenValid(u("?token=wrong"), "abc", h("abc"))).toBe(true);
  });
  it("ignores an empty header", async () => {
    expect(await tokenValid(u(""), "abc", h(""))).toBe(false);
    expect(await tokenValid(u("?token=abc"), "abc", h(""))).toBe(true);
  });
  it("rejects everything when the expected secret is unset, header or not", async () => {
    expect(await tokenValid(u(""), "", h(""))).toBe(false);
    expect(await tokenValid(u(""), undefined as unknown as string, h("abc"))).toBe(false);
  });
});

describe("redactedPath", () => {
  it("drops the query string", () => expect(redactedPath(u("?token=abc"))).toBe("/mcp"));
});
