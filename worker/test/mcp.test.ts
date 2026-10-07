import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const base = "https://example.com";
const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

async function rpc(token: string, body: unknown) {
  const res = await SELF.fetch(`${base}/mcp?token=${token}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  return { status: res.status, json: JSON.parse(data) };
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

describe("access", () => {
  it("401s without a token", async () => {
    expect((await SELF.fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(init) })).status).toBe(401);
  });
  it("401s with a wrong token", async () => {
    expect((await SELF.fetch(`${base}/mcp?token=nope`, { method: "POST", headers, body: JSON.stringify(init) })).status).toBe(401);
  });
  it("404s on other paths", async () => {
    expect((await SELF.fetch(`${base}/other?token=test-token`)).status).toBe(404);
  });
});

describe("x-api-key header", () => {
  const post = (path: string, extra: Record<string, string>) =>
    SELF.fetch(`${base}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(init) });
  it("is accepted instead of ?token=", async () => {
    expect((await post("/mcp", { "x-api-key": "test-token" })).status).toBe(200);
  });
  it("401s when the header is wrong", async () => {
    expect((await post("/mcp", { "x-api-key": "nope" })).status).toBe(401);
  });
  it("does not make a wrong header block a valid ?token=", async () => {
    expect((await post("/mcp?token=test-token", { "x-api-key": "nope" })).status).toBe(200);
  });
});

describe("tools", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes exactly find_stop and next_departures", async () => {
    await rpc("test-token", init);
    const { json } = await rpc("test-token", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(json.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["find_stop", "next_departures"]);
  });

  it("never logs the token or the query text", async () => {
    const spy = vi.spyOn(console, "log");
    await rpc("test-token", init);
    const { json } = await rpc("test-token", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "find_stop", arguments: { query: "   " } } });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toBe("Give a stop name to search for.");
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain('"tool":"find_stop"');
    expect(logged).not.toContain("test-token");
    expect(logged).not.toContain("token=");
  });

  it("never logs a token sent in the header either", async () => {
    const spy = vi.spyOn(console, "log");
    const res = await SELF.fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "x-api-key": "test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "find_stop", arguments: { query: " " } } }) });
    expect(res.status).toBe(200);
    expect(spy.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain("test-token");
    const bad = await SELF.fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "x-api-key": "wrong-secret" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(spy.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain("wrong-secret");
  });

  it("logs the PTV status (and still no URL) when PTV rejects the credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 403 }));
    const spy = vi.spyOn(console, "log");
    await rpc("test-token", init);
    const { json } = await rpc("test-token", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "next_departures", arguments: { stop: "1007", mode: "train" } } });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("rejected the server's credentials");
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain('"ptvStatus":403');
    expect(logged).not.toMatch(/devid|signature|timetableapi|test-key/i);
  });
});
