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

export async function searchStops(
  client: PtvClient,
  store: CacheStore,
  rt: CacheRuntime,
  query: string,
  mode?: Mode,
): Promise<Cached<StopMatch[]>> {
  const term = query.trim();
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
  const value = (res.value.stops ?? [])
    .filter((s): s is typeof s & { route_type: 0 | 1 } => s.route_type === 0 || s.route_type === 1)
    .map((s) => ({
      stopId: s.stop_id,
      name: s.stop_name,
      routeType: s.route_type,
      suburb: s.stop_suburb ?? null,
      routes: (s.routes ?? []).map((r) => (r.route_number ? `Route ${r.route_number}` : r.route_name)),
    }));
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
