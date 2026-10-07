import { McpServer } from "@modelcontextprotocol/server";
import { findStop, nextDepartures, type ToolResult } from "@ptv/core";
import { z } from "zod";
import { toolContext } from "./runtime";

const mode = z
  .enum(["train", "tram", "bus"])
  .optional()
  .describe(
    'Trains and trams are searched by default. Pass "bus" to search buses, but bus searches are noisy: they cover all of Victoria and return many similarly named stops, so give a detailed name (both cross streets, e.g. "Chapel St/Alexandra Ave", or add the suburb). Pass the mode with a numeric stop ID: IDs are only unique within a mode.',
  );

export function buildServer(env: Env, ctx: ExecutionContext): McpServer {
  const server = new McpServer({ name: "ptv-mcp", version: "1.0.0" });
  const tc = toolContext(env, ctx);

  // One log line per call: tool, latency, cache behaviour. No arguments, no URLs.
  const run = async (tool: string, fn: () => Promise<ToolResult>) => {
    const start = Date.now();
    const r = await fn();
    console.log(JSON.stringify({ tool, ms: Date.now() - start, cache: r.cache, ...(r.ptvStatus ? { ptvStatus: r.ptvStatus } : {}) }));
    return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
  };

  server.registerTool(
    "find_stop",
    {
      description:
        "Find Melbourne metro train stations, tram stops and bus stops by name. Returns stop IDs, modes and the lines serving each stop. Trains and trams are searched by default. Bus searches (mode \"bus\") are noisy: they cover all of Victoria and return many similar stops, so be specific, ideally both cross streets. Prefer the stop ID from here for follow-up calls.",
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
        "Next train, tram or bus departures from a stop, with live times where available. Defaults to services heading into the city and includes active disruptions.",
      inputSchema: {
        stop: z
          .string()
          .describe(
            "Stop name or numeric stop ID. For buses, pass mode \"bus\" and either the stop ID from find_stop or a detailed name with both cross streets; vague bus names match many stops and return a list to choose from.",
          ),
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
