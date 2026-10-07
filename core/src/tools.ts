import { POLICIES, cached, type Cached, type CacheRuntime, type CacheSource, type CacheStore } from "./cache";
import { getCityRoutes } from "./cityRoutes";
import type { PtvClient } from "./client";
import {
  renderDeparture,
  shapeDepartures,
  shapeDisruptions,
  type Departure,
  type PtvDeparturesResponse,
  type PtvDisruptionsResponse,
} from "./departures";
import { MODE_OF, ROUTE_TYPE, describeStop, resolveStop, searchStops, type Mode } from "./stops";

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

const SOURCE_ORDER: CacheSource[] = ["miss", "stale-fallback", "stale", "hit"];
const summarise = (sources: CacheSource[]): CacheSource =>
  SOURCE_ORDER.find((s) => sources.includes(s)) ?? "hit";

const departuresFor = (ctx: ToolContext, routeType: 0 | 1, stopId: number) =>
  cached(
    ctx.live,
    `dep:${routeType}:${stopId}`,
    POLICIES.departures,
    () =>
      ctx.client.get<PtvDeparturesResponse>(`/v3/departures/route_type/${routeType}/stop/${stopId}`, {
        max_results: 40,
        expand: ["Route", "Direction", "Run"],
      }),
    ctx.rt,
  );

const failure = (): ToolResult => ({ text: PTV_DOWN, cache: "miss", isError: true });

export async function nextDepartures(
  ctx: ToolContext,
  args: { stop: string; mode?: Mode; route?: string; direction?: string; limit?: number },
): Promise<ToolResult> {
  const direction = (args.direction ?? "city").trim().toLowerCase();
  const numericDirection = /^\d+$/.test(direction) ? Number(direction) : undefined;
  if (direction !== "city" && direction !== "outbound" && numericDirection === undefined) {
    return { text: 'direction must be "city", "outbound" or a direction ID.', cache: "hit", isError: true };
  }
  const stopArg = args.stop.trim();
  if (!stopArg) return { text: "Give a stop name or ID.", cache: "hit", isError: true };
  const limit = Math.min(10, Math.max(1, Math.trunc(Number.isFinite(args.limit) ? args.limit! : 5)));

  const sources: CacheSource[] = [];
  let stopId: number;
  let stopName: string | undefined;
  let routeTypes: Array<0 | 1>;
  if (/^\d+$/.test(stopArg)) {
    stopId = Number(stopArg);
    routeTypes = args.mode ? [ROUTE_TYPE[args.mode]] : [0, 1];
  } else {
    let found;
    try {
      found = await searchStops(ctx.client, ctx.static, ctx.rt, stopArg, args.mode);
    } catch {
      return failure();
    }
    sources.push(found.source);
    const resolved = resolveStop(found.value, stopArg);
    if (resolved.kind === "none") return { text: `No stops found for “${stopArg}”.`, cache: found.source };
    if (resolved.kind === "many") {
      const list = resolved.candidates.map(describeStop).join("\n");
      return { text: `Several stops match “${stopArg}”. Which one did you mean?\n${list}`, cache: found.source };
    }
    stopId = resolved.stop.stopId;
    stopName = resolved.stop.name;
    routeTypes = [resolved.stop.routeType];
  }

  let dep!: Cached<PtvDeparturesResponse>;
  let routeType: 0 | 1 = routeTypes[0]!;
  try {
    for (const t of routeTypes) {
      dep = await departuresFor(ctx, t, stopId);
      routeType = t;
      if (dep.value.departures.length) break;
    }
  } catch {
    return failure();
  }
  sources.push(dep.source);
  stopName ??= dep.value.stops?.[stopId]?.stop_name ?? `Stop ${stopId}`;

  let deps: Departure[] = shapeDepartures(dep.value, ctx.rt.now());
  if (args.route) {
    const q = args.route.trim().toLowerCase();
    deps = deps.filter((d) => String(d.routeId) === q || d.line.toLowerCase().includes(q));
  }

  const skipped = new Set<string>();
  if (numericDirection !== undefined) {
    deps = deps.filter((d) => d.directionId === numericDirection);
  } else {
    let cityRoutes;
    try {
      cityRoutes = await getCityRoutes(ctx.client, ctx.static, ctx.rt);
    } catch {
      return failure();
    }
    deps = deps.filter((d) => {
      const r = cityRoutes[d.routeId];
      if (!r) {
        skipped.add(d.line);
        return false;
      }
      return direction === "city"
        ? d.directionId === r.cityDirectionId
        : r.outboundDirectionIds.includes(d.directionId);
    });
  }
  deps = deps.slice(0, limit);

  const label = direction === "city" ? "toward City" : direction === "outbound" ? "outbound" : `in direction ${direction}`;
  const lines: string[] = [];
  if (dep.warning) lines.push(dep.warning);

  if (deps.length === 0) {
    lines.push(`No upcoming services at ${stopName} ${label}.`);
    if (skipped.size) {
      lines.push(
        `Couldn't determine the city direction for: ${[...skipped].join(", ")}. Try a direction ID instead.`,
      );
    }
    return { text: lines.join("\n"), cache: summarise(sources) };
  }

  lines.push(`${stopName} (${MODE_OF[routeType]}) ${label}:`, ...deps.map(renderDeparture));

  try {
    const dis = await cached(
      ctx.live,
      `dis:${routeType}`,
      POLICIES.disruptions,
      () =>
        ctx.client.get<PtvDisruptionsResponse>("/v3/disruptions", {
          route_types: [routeType],
          disruption_status: "current",
        }),
      ctx.rt,
    );
    sources.push(dis.source);
    const shown = new Set(deps.map((d) => d.routeId));
    const relevant = shapeDisruptions(dis.value)
      .filter((x) => x.routeIds.some((id) => shown.has(id)))
      .slice(0, 3);
    if (relevant.length) lines.push("", "Disruptions:", ...relevant.map((x) => `- ${x.title}`));
  } catch {
    // Disruptions are supplementary; departures are still useful without them.
  }

  return { text: lines.join("\n"), cache: summarise(sources) };
}
