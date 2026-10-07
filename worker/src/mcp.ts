import { McpServer } from "@modelcontextprotocol/server";
import { findStop, nextDepartures, type ToolResult } from "@ptv/core";
import { z } from "zod";
import { toolContext } from "./runtime";

const mode = z.enum(["train", "tram"]).optional().describe("Restrict to trains or trams");

export function buildServer(env: Env, ctx: ExecutionContext): McpServer {
  const server = new McpServer({ name: "ptv-mcp", version: "1.0.0" });
  const tc = toolContext(env, ctx);

  // One log line per call: tool, latency, cache behaviour. No arguments, no URLs.
  const run = async (tool: string, fn: () => Promise<ToolResult>) => {
    const start = Date.now();
    const r = await fn();
    console.log(JSON.stringify({ tool, ms: Date.now() - start, cache: r.cache }));
    return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
  };

  server.registerTool(
    "find_stop",
    {
      description:
        "Find Melbourne metro train stations and tram stops by name. Returns stop IDs, modes and the lines serving each stop.",
      inputSchema: {
        query: z.string().describe("Stop or station name, e.g. 'Ascot Vale'"),
        mode,
      },
    },
    (args) => run("find_stop", () => findStop(tc, args)),
  );

  server.registerTool(
    "next_departures",
    {
      description:
        "Next train or tram departures from a stop, with live times where available. Defaults to services heading into the city and includes active disruptions.",
      inputSchema: {
        stop: z.string().describe("Stop name or numeric stop ID"),
        mode,
        route: z.string().optional().describe("Line name (or part of it) or route ID"),
        direction: z
          .string()
          .optional()
          .describe("'city' (default), 'outbound', or a numeric direction ID"),
        limit: z.number().int().optional().describe("Number of departures, 1-10 (default 5)"),
      },
    },
    (args) => run("next_departures", () => nextDepartures(tc, args)),
  );

  return server;
}
