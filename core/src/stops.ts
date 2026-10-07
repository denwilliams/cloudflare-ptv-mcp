import { POLICIES, cached, type Cached, type CacheRuntime, type CacheStore } from "./cache";
import type { PtvClient } from "./client";
import { routeLabel } from "./departures";

export type Mode = "train" | "tram" | "bus";
/** PTV route types we serve: 0 metro train, 1 tram, 2 bus, 4 night bus. V/Line (3) is out of scope. */
export type RouteType = 0 | 1 | 2 | 4;
export const ROUTE_TYPES: Record<Mode, RouteType[]> = { train: [0], tram: [1], bus: [2, 4] };
/** What a search or numeric stop ID covers when no mode is given: buses need `mode: "bus"`. */
export const DEFAULT_ROUTE_TYPES: RouteType[] = [0, 1];
export const MODE_OF: Record<RouteType, Mode> = { 0: "train", 1: "tram", 2: "bus", 4: "bus" };
const isRouteType = (t: number): t is RouteType => t === 0 || t === 1 || t === 2 || t === 4;

export interface StopMatch {
  stopId: number;
  name: string;
  routeType: RouteType;
  suburb: string | null;
  routes: string[];
}

interface PtvSearchResponse {
  stops?: Array<{
    stop_id: number;
    stop_name: string;
    stop_suburb?: string | null;
    route_type: number;
    routes?: Array<{ route_name: string; route_number?: string | null; route_type?: number }>;
  }>;
}

const normaliseTerm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * PTV answers 403 when a search term contains / & ? or # (it decodes the path before
 * checking the signature), and its search only matches whole words, so "Bourke St Swanston St"
 * finds nothing. Cross-street names are split on those characters: we search on the first
 * part and filter by the rest.
 */
const queryParts = (q: string) =>
  q
    .split(/[/&?#]+/)
    .map((p) => p.trim())
    .filter(Boolean);

export async function searchStops(
  client: PtvClient,
  store: CacheStore,
  rt: CacheRuntime,
  query: string,
  mode?: Mode,
): Promise<Cached<StopMatch[]>> {
  const [term, ...others] = queryParts(query);
  if (term === undefined) return { value: [], source: "hit" };
  const routeTypes = mode ? ROUTE_TYPES[mode] : DEFAULT_ROUTE_TYPES;
  const key = `search:${normaliseTerm(query)}:${mode ?? "any"}`;
  const res = await cached(
    store,
    key,
    POLICIES.static,
    () =>
      client.get<PtvSearchResponse>(`/v3/search/${encodeURIComponent(term)}`, {
        route_types: routeTypes,
        include_outlets: "false",
        include_addresses: "false",
      }),
    rt,
  );
  let value = (res.value.stops ?? [])
    .filter((s): s is typeof s & { route_type: RouteType } => isRouteType(s.route_type) && routeTypes.includes(s.route_type))
    .map((s) => ({
      stopId: s.stop_id,
      name: s.stop_name.trim(),
      routeType: s.route_type,
      suburb: s.stop_suburb ?? null,
      routes: (s.routes ?? []).map((r) => (r.route_number ? routeLabel(r.route_number, r.route_type) : r.route_name)),
    }));
  // Trains first, then trams, then buses (stable, so PTV's order is kept within a mode).
  const rank = (t: RouteType) => (t === 0 ? 0 : t === 1 ? 1 : 2);
  value = value.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m.routeType) - rank(b.m.routeType) || a.i - b.i).map((x) => x.m);
  if (others.length) {
    const wanted = others.map((o) => o.toLowerCase());
    const narrowed = value.filter((m) => wanted.every((w) => m.name.toLowerCase().includes(w)));
    if (narrowed.length) value = narrowed;
  }
  return { ...res, value };
}

const normaliseName = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+(railway\s+)?station$/, "")
    .trim();

export type Resolution =
  | { kind: "one"; stop: StopMatch }
  | { kind: "none" }
  | { kind: "many"; candidates: StopMatch[] };

export function resolveStop(matches: StopMatch[], query: string): Resolution {
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "one", stop: matches[0]! };
  const q = normaliseName(query.trim());
  const exact = matches.filter((m) => normaliseName(m.name) === q);
  if (exact.length === 1) return { kind: "one", stop: exact[0]! };
  return { kind: "many", candidates: matches.slice(0, 5) };
}

export function describeStop(s: StopMatch): string {
  const where = s.suburb ? `${MODE_OF[s.routeType]}, ${s.suburb}` : MODE_OF[s.routeType];
  const routes = s.routes.length ? `: ${s.routes.join(", ")}` : "";
  return `${s.name} (${where}) id ${s.stopId}${routes}`;
}
