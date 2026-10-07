import { McpServer } from "@modelcontextprotocol/server";
import { findStop, nextDepartures, type ToolResult } from "@ptv/core";
import { z } from "zod";
import { toolContext } from "./runtime";

const mode = z
  .enum(["train", "tram", "bus"])
  .optional()
  .describe(
    'Optional. "train", "tram" or "bus" narrows the search to that kind of stop; always pass "bus" when the user is asking about a bus. If left out, every kind is searched and bus stops are found when no train or tram matches. Bus stop names are numerous and similar across Victoria, so give a specific name: both cross streets (e.g. "Chapel St/Alexandra Ave") or add the suburb. Stop IDs repeat across modes, so pass the mode with a numeric stop ID.',
  );

const INSTRUCTIONS =
  'Live and scheduled Melbourne public transport: metro trains, trams and buses (regular and night), all fully supported. For a bus, pass mode "bus" when you can; bus stop names and IDs are also found without a mode. ' +
  "Use next_departures for \"when is the next ...\" questions; it accepts a stop name or a stop ID, and find_stop looks up stop IDs or resolves an ambiguous name. Pass the mode along with a numeric stop ID. " +
  "Bus stop names are numerous and similar across Victoria, so give both cross streets or the suburb. Lines that never go to the city (many suburban buses and trams) show every direction.";

export function buildServer(env: Env, ctx: ExecutionContext): McpServer {
  const server = new McpServer(
    { name: "ptv-mcp", title: "Melbourne PTV: trains, trams and buses", version: "1.1.0" },
    { instructions: INSTRUCTIONS },
  );
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
        "Find a Melbourne train station, tram stop or bus stop by name. Covers trains, trams and buses. For a bus stop pass mode \"bus\", although leaving mode out also finds bus stops when no train or tram matches. Returns stop IDs, modes and the lines or routes serving each stop. For buses give a specific name (both cross streets, e.g. \"Chapel St/Alexandra Ave\", or add the suburb), because many bus stops across Victoria have similar names. Prefer the stop ID from here for follow-up calls.",
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
        "Next train, tram or bus departures from a stop, with live times where available. Works for buses: pass mode \"bus\" for a bus stop (leaving it out also works when the name or ID is unambiguous). Defaults to services heading into the city and includes active disruptions. For lines that never go to the city (many suburban buses and trams) it shows every direction instead.",
      inputSchema: {
        stop: z
          .string()
          .describe(
            "Stop name or numeric stop ID. For buses pass mode \"bus\" and either the stop ID from find_stop or a specific name with both cross streets.",
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
