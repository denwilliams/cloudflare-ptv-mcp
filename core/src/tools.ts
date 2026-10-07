import { POLICIES, cached, type Cached, type CacheRuntime, type CacheSource, type CacheStore } from "./cache";
import { getCityRoutes } from "./cityRoutes";
import { getStopOrder, headsTowardCity, type RouteStopOrder } from "./stopOrder";
import { PtvError, type PtvClient } from "./client";
import {
  renderDeparture,
  routeLabel,
  shapeDepartures,
  shapeDisruptions,
  type Departure,
  type PtvDeparturesResponse,
  type PtvDisruptionsResponse,
} from "./departures";
import { DEFAULT_ROUTE_TYPES, MODE_OF, ROUTE_TYPES, describeStop, resolveStop, searchStops, type Mode, type RouteType } from "./stops";

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
  /** HTTP status PTV returned, when the failure came from PTV. For logging. */
  ptvStatus?: number;
}

export const PTV_DOWN = "PTV isn't responding right now. Try again shortly.";
export const PTV_NOT_FOUND = "PTV didn't recognise that stop or search. Check the name or ID.";
export const PTV_REJECTED =
  "PTV rejected the server's credentials. This needs fixing by whoever runs the server.";

export async function findStop(
  ctx: ToolContext,
  args: { query: string; mode?: Mode },
): Promise<ToolResult> {
  if (!args.query.trim()) return { text: "Give a stop name to search for.", cache: "hit", isError: true };
  let res;
  try {
    res = await searchWithBusFallback(ctx, args.query, args.mode);
  } catch (err) {
    return failure(err);
  }
  const MAX_LISTED = 10;
  const lines = res.value.slice(0, MAX_LISTED).map(describeStop);
  if (res.value.length > MAX_LISTED) {
    lines.push(`…and ${res.value.length - MAX_LISTED} more. Add a mode or a fuller stop name to narrow the search.`);
  }
  if (res.busFallback) lines.unshift(`No train or tram stops matched “${args.query.trim()}”, so these are bus stops.`);
  const text = lines.length ? lines.join("\n") : noStops(args.query.trim(), args.mode);
  return { text: res.warning ? `${res.warning}\n${text}` : text, cache: res.source };
}

/** With no mode we search trains and trams, then buses if those find nothing. */
const noStops = (query: string, mode?: Mode) =>
  `No stops found for “${query}”.${mode ? "" : " Searched trains, trams and buses."}`;

/**
 * Callers often leave mode off even for bus stops. Trains and trams stay the default, but a
 * name that matches neither is searched again among buses instead of reporting nothing.
 */
async function searchWithBusFallback(ctx: ToolContext, query: string, mode?: Mode) {
  const res = await searchStops(ctx.client, ctx.static, ctx.rt, query, mode);
  if (mode || (res.value.length > 0 && !res.loose)) return { ...res, busFallback: false };
  try {
    const bus = await searchStops(ctx.client, ctx.static, ctx.rt, query, "bus");
    if (bus.value.length > 0 && !bus.loose) return { ...bus, busFallback: true };
  } catch {
    // The bus search is a courtesy; fall through to the original empty result.
  }
  return { ...res, busFallback: false };
}

const SOURCE_ORDER: CacheSource[] = ["miss", "stale-fallback", "stale", "hit"];
const summarise = (sources: CacheSource[]): CacheSource =>
  SOURCE_ORDER.find((s) => sources.includes(s)) ?? "hit";

const departuresFor = (ctx: ToolContext, routeType: RouteType, stopId: number) =>
  cached(
    ctx.live,
    `dep:${routeType}:${stopId}`,
    POLICIES.departures,
    () =>
      ctx.client.get<PtvDeparturesResponse>(`/v3/departures/route_type/${routeType}/stop/${stopId}`, {
        max_results: 12, // PTV applies this per route and direction
        expand: ["Route", "Direction", "Run", "Stop"],
      }),
    ctx.rt,
  );

function failure(err?: unknown): ToolResult {
  const status = err instanceof PtvError ? err.status : undefined;
  const text = status === 400 || status === 404 ? PTV_NOT_FOUND : status === 401 || status === 403 ? PTV_REJECTED : PTV_DOWN;
  return { text, cache: "miss", isError: true, ...(status ? { ptvStatus: status } : {}) };
}

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

  const numericStop = /^\d+$/.test(stopArg);
  let fallbackNote: string | undefined;
  const sources: CacheSource[] = [];
  let stopId: number;
  let stopName: string | undefined;
  let routeTypes: RouteType[];
  if (numericStop) {
    stopId = Number(stopArg);
    routeTypes = args.mode ? ROUTE_TYPES[args.mode] : DEFAULT_ROUTE_TYPES;
  } else {
    let found;
    try {
      found = await searchWithBusFallback(ctx, stopArg, args.mode);
    } catch (err) {
      return failure(err);
    }
    sources.push(found.source);
    const resolved = resolveStop(found.value, stopArg);
    if (resolved.kind === "none") return { text: noStops(stopArg, args.mode), cache: found.source };
    const missed = `No train or tram stop matched “${stopArg}”, so`;
    if (resolved.kind === "many") {
      const list = resolved.candidates.map(describeStop).join("\n");
      const note = found.busFallback ? `${missed} these are bus stops.\n` : "";
      return { text: `${note}Several stops match “${stopArg}”. Which one did you mean?\n${list}`, cache: found.source };
    }
    if (found.busFallback) fallbackNote = `${missed} this is a bus stop.`;
    stopId = resolved.stop.stopId;
    stopName = resolved.stop.name;
    routeTypes = [resolved.stop.routeType];
  }

  let dep!: Cached<PtvDeparturesResponse>;
  let routeType: RouteType = routeTypes[0]!;
  let answered = false;
  let lastErr: unknown;
  for (const t of routeTypes) {
    try {
      const d = await departuresFor(ctx, t, stopId);
      const hasServices = d.value.departures.length > 0;
      if (!answered || hasServices) {
        dep = d;
        routeType = t;
        answered = true;
      }
      if (hasServices) break;
    } catch (err) {
      lastErr = err; // try the next route type before giving up
    }
  }
  // A numeric ID with no mode may be a bus stop (callers, especially stale clients, often omit
  // the mode). Only look at buses when no train or tram stop with that ID has services, and say so.
  if (numericStop && !args.mode && !(answered && dep.value.departures.length > 0)) {
    for (const t of ROUTE_TYPES.bus) {
      try {
        const d = await departuresFor(ctx, t, stopId);
        if (d.value.departures.length > 0) {
          dep = d;
          routeType = t;
          answered = true;
          fallbackNote = `No train or tram stop with ID ${stopId} had services, so this is the bus stop with that ID.`;
          break;
        }
      } catch {
        // ignore: report the train/tram result below
      }
    }
  }
  if (!answered) return failure(lastErr);
  sources.push(dep.source);
  stopName ??= dep.value.stops?.[stopId]?.stop_name?.trim() ?? `Stop ${stopId}`;

  let deps: Departure[] = shapeDepartures(dep.value, ctx.rt.now());
  if (args.route) {
    const q = args.route.trim().toLowerCase();
    const numeric = /^\d+$/.test(q);
    deps = deps.filter((d) =>
      numeric
        ? d.routeNumber === q || String(d.routeId) === q
        : `${d.routeNumber ? `route ${d.routeNumber} ` : ""}${d.line}`.toLowerCase().includes(q),
    );
  }

  const skipped = new Set<string>();
  // Lines that never reach the CBD: "toward city" means nothing for them.
  const nonCity: Departure[] = [];
  const nonCityLabels = new Set<string>();
  const labelOf = (d: Departure) => (d.routeNumber ? routeLabel(d.routeNumber, d.routeType) : d.line);
  if (numericDirection !== undefined) {
    deps = deps.filter((d) => d.directionId === numericDirection);
  } else {
    let cityRoutes;
    try {
      cityRoutes = await getCityRoutes(ctx.client, ctx.static, ctx.rt);
    } catch (err) {
      return failure(err);
    }
    // Routes whose city direction can't be read from their direction names (cross-city trams)
    // fall back to the stop's position along the route.
    const orders = new Map<string, RouteStopOrder | null>();
    await Promise.all(
      [...new Set(deps.filter((d) => !cityRoutes[d.routeId]).map((d) => `${d.routeId}:${d.directionId}`))].map(async (k) => {
        const [routeId, directionId] = k.split(":").map(Number) as [number, number];
        try {
          orders.set(k, await getStopOrder(ctx.client, ctx.static, ctx.rt, routeId, routeType, directionId));
        } catch {
          orders.set(k, null);
        }
      }),
    );
    deps = deps.filter((d) => {
      const r = cityRoutes[d.routeId];
      if (r) {
        return direction === "city"
          ? d.directionId === r.cityDirectionId
          : r.outboundDirectionIds.includes(d.directionId);
      }
      const order = orders.get(`${d.routeId}:${d.directionId}`);
      if (order && order.cbd.length === 0 && order.seq[stopId] !== undefined) {
        nonCity.push(d);
        nonCityLabels.add(labelOf(d));
        return false;
      }
      const toward = order ? headsTowardCity(order, stopId) : undefined;
      if (toward === undefined) {
        skipped.add(labelOf(d));
        return false;
      }
      return direction === "city" ? toward : !toward;
    });
  }

  let label = direction === "city" ? "toward City" : direction === "outbound" ? "outbound" : `in direction ${direction}`;
  const notes: string[] = [];
  const lineList = [...nonCityLabels].join(", ");
  if (deps.length === 0 && nonCity.length > 0) {
    // Nothing here goes to the city, so show what does run, in every direction.
    deps = nonCity;
    label = "all directions";
    notes.push(`${lineList} ${nonCityLabels.size === 1 ? "doesn't" : "don't"} go to the city, so every direction is shown.`);
  } else if (nonCity.length > 0) {
    notes.push(`Not shown (doesn't go to the city): ${lineList}.`);
  }
  deps = deps.slice(0, limit);
  const lines: string[] = [];
  if (fallbackNote) lines.push(fallbackNote);
  if (dep.warning) lines.push(dep.warning);

  if (deps.length === 0) {
    lines.push(`No upcoming services at ${stopName} ${label}.${numericStop && !args.mode ? ' If this is a bus stop, pass mode "bus".' : ""}`);
    if (skipped.size) {
      lines.push(
        `Couldn't determine the city direction for: ${[...skipped].join(", ")}. Try a direction ID instead.`,
      );
    }
    return { text: lines.join("\n"), cache: summarise(sources) };
  }

  lines.push(`${stopName} (${MODE_OF[routeType]}) ${label}:`, ...deps.map(renderDeparture), ...notes);

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
