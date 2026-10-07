import type { CacheRuntime, CacheSource, CacheStore } from "./cache";
import type { PtvClient } from "./client";
import { describeStop, searchStops, type Mode } from "./stops";

export interface ToolContext {
  client: PtvClient;
  /** Short-lived data: departures, disruptions. */
  live: CacheStore;
  /** Slow-changing data: search, routes, directions. */
  static: CacheStore;
  rt: CacheRuntime;
}

export interface ToolResult {
  text: string;
  /** Summary of cache behaviour, for logging only. */
  cache: CacheSource;
  isError?: boolean;
}

export const PTV_DOWN = "PTV isn't responding right now. Try again shortly.";

export async function findStop(
  ctx: ToolContext,
  args: { query: string; mode?: Mode },
): Promise<ToolResult> {
  if (!args.query.trim()) return { text: "Give a stop name to search for.", cache: "hit", isError: true };
  let res;
  try {
    res = await searchStops(ctx.client, ctx.static, ctx.rt, args.query, args.mode);
  } catch {
    return { text: PTV_DOWN, cache: "miss", isError: true };
  }
  const text = res.value.length
    ? res.value.map(describeStop).join("\n")
    : `No stops found for “${args.query.trim()}”.`;
  return { text: res.warning ? `${res.warning}\n${text}` : text, cache: res.source };
}
