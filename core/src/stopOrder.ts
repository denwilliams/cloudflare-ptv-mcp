import { POLICIES, cached, type CacheRuntime, type CacheStore } from "./cache";
import type { PtvClient } from "./client";
import type { RouteType } from "./stops";

/** Where one direction of a route visits each stop, and which of those stops are in the CBD. */
export interface RouteStopOrder {
  /** stop id -> stop_sequence */
  seq: Record<number, number>;
  /** stop_sequence of every CBD stop on this direction */
  cbd: number[];
}

interface PtvStopsResponse {
  stops: Array<{ stop_id: number; stop_sequence: number; stop_suburb?: string | null }>;
}

const CBD_SUBURB = "melbourne city";

/** Fetched lazily per route and direction (not by the cron) and cached with the static policy. */
export async function getStopOrder(
  client: PtvClient,
  store: CacheStore,
  rt: CacheRuntime,
  routeId: number,
  routeType: RouteType,
  directionId: number,
): Promise<RouteStopOrder> {
  const res = await cached(
    store,
    `seq:${routeId}:${directionId}`,
    POLICIES.static,
    async (): Promise<RouteStopOrder> => {
      const { stops } = await client.get<PtvStopsResponse>(`/v3/stops/route/${routeId}/route_type/${routeType}`, {
        direction_id: directionId,
      });
      const seq: Record<number, number> = {};
      const cbd: number[] = [];
      for (const s of stops) {
        seq[s.stop_id] = s.stop_sequence;
        if (s.stop_suburb?.toLowerCase() === CBD_SUBURB) cbd.push(s.stop_sequence);
      }
      return { seq, cbd: cbd.sort((a, b) => a - b) };
    },
    rt,
  );
  return res.value;
}

/**
 * True when a CBD stop comes later than this stop in this direction. Undefined when the stop
 * isn't on the route or the route never reaches the CBD, so the caller can say it doesn't know.
 */
export function headsTowardCity(order: RouteStopOrder, stopId: number): boolean | undefined {
  const at = order.seq[stopId];
  if (at === undefined || order.cbd.length === 0) return undefined;
  return order.cbd.some((c) => c > at);
}
