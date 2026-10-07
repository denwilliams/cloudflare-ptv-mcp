import { POLICIES, cached, type CacheRuntime, type CacheStore } from "./cache";
import type { PtvClient } from "./client";

export interface CityRoute {
  routeId: number;
  routeType: 0 | 1;
  name: string;
  cityDirectionId: number;
  outboundDirectionIds: number[];
}

/** Keyed by route ID. */
export type CityRoutes = Record<number, CityRoute>;

/** Route ID -> city direction ID, for routes whose direction names don't resolve on their own. */
export const CITY_DIRECTION_OVERRIDES: Record<number, number> = {};

const CITY_NAMES = [
  "flinders street",
  "southern cross",
  "melbourne central",
  "parliament",
  "flagstaff",
  "town hall",
  "state library",
];

export function isCityName(name: string): boolean {
  const n = name.toLowerCase();
  return /\bcity\b/.test(n) || CITY_NAMES.some((c) => n.includes(c));
}

interface PtvRoute {
  route_id: number;
  route_name: string;
  route_type: number;
}
interface PtvDirection {
  direction_id: number;
  direction_name: string;
}

export async function getCityRoutes(
  client: PtvClient,
  store: CacheStore,
  rt: CacheRuntime,
  opts: { force?: boolean; overrides?: Record<number, number> } = {},
): Promise<CityRoutes> {
  const overrides = opts.overrides ?? CITY_DIRECTION_OVERRIDES;

  // Static data is read through the cache, or refetched and rewritten when forced (daily cron).
  const load = async <T>(key: string, fetcher: () => Promise<T>): Promise<T> => {
    if (opts.force) {
      const value = await fetcher();
      await store.put(key, value, POLICIES.static.retainSeconds);
      return value;
    }
    return (await cached(store, key, POLICIES.static, fetcher, rt)).value;
  };

  const build = async (): Promise<CityRoutes> => {
    const { routes } = await load("routes", () =>
      client.get<{ routes: PtvRoute[] }>("/v3/routes", { route_types: [0, 1] }),
    );
    const out: CityRoutes = {};
    await Promise.all(
      routes
        .filter((r) => r.route_type === 0 || r.route_type === 1)
        .map(async (r) => {
          const { directions } = await load(`dir:${r.route_id}`, () =>
            client.get<{ directions: PtvDirection[] }>(`/v3/directions/route/${r.route_id}`),
          );
          const override = overrides[r.route_id];
          const cityDirs = directions.filter((d) => isCityName(d.direction_name));
          const cityId = override ?? (cityDirs.length === 1 ? cityDirs[0]!.direction_id : undefined);
          if (cityId === undefined) return;
          out[r.route_id] = {
            routeId: r.route_id,
            routeType: r.route_type as 0 | 1,
            name: r.route_name,
            cityDirectionId: cityId,
            outboundDirectionIds: directions.map((d) => d.direction_id).filter((id) => id !== cityId),
          };
        }),
    );
    return out;
  };

  if (opts.force) {
    const value = await build();
    await store.put("city_routes", value, POLICIES.static.retainSeconds);
    return value;
  }
  return (await cached(store, "city_routes", POLICIES.static, build, rt)).value;
}
