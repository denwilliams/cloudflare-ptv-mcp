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
});
