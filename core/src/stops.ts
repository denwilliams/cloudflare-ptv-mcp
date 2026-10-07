import { POLICIES, cached, type Cached, type CacheRuntime, type CacheStore } from "./cache";
import type { PtvClient } from "./client";

export type Mode = "train" | "tram";
export const ROUTE_TYPE: Record<Mode, 0 | 1> = { train: 0, tram: 1 };
export const MODE_OF: Record<0 | 1, Mode> = { 0: "train", 1: "tram" };

export interface StopMatch {
  stopId: number;
  name: string;
  routeType: 0 | 1;
  suburb: string | null;
  routes: string[];
}

interface PtvSearchResponse {
  stops?: Array<{
    stop_id: number;
    stop_name: string;
    stop_suburb?: string | null;
    route_type: number;
    routes?: Array<{ route_name: string; route_number?: string | null }>;
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
  const routeTypes = mode ? [ROUTE_TYPE[mode]] : [0, 1];
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
    .filter((s): s is typeof s & { route_type: 0 | 1 } => s.route_type === 0 || s.route_type === 1)
    .map((s) => ({
      stopId: s.stop_id,
      name: s.stop_name.trim(),
      routeType: s.route_type,
      suburb: s.stop_suburb ?? null,
      routes: (s.routes ?? []).map((r) => (r.route_number ? `Route ${r.route_number}` : r.route_name)),
    }));
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
