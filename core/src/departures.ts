import { formatMelbourneTime, minutesAway } from "./time";

export interface PtvDeparturesResponse {
  departures: Array<{
    route_id: number;
    direction_id: number;
    run_ref: string;
    scheduled_departure_utc: string;
    estimated_departure_utc: string | null;
    platform_number: string | null;
    disruption_ids: number[];
  }>;
  stops?: Record<string, { stop_name?: string }>;
  routes?: Record<string, { route_name: string; route_number?: string | null }>;
  directions?: Record<string, { direction_name: string }>;
  runs?: Record<string, { destination_name?: string }>;
}

export interface PtvDisruptionsResponse {
  disruptions: Record<
    string,
    Array<{ disruption_id: number; title: string; routes?: Array<{ route_id: number }> }>
  >;
}

export interface Departure {
  routeId: number;
  directionId: number;
  line: string;
  /** Trams are identified by number (route_name is the termini); trains have none. */
  routeNumber: string | null;
  destination: string;
  scheduledUtc: string;
  estimatedUtc: string | null;
  minutes: number;
  live: boolean;
  platform: string | null;
  disruptionIds: number[];
}

export interface Disruption {
  id: number;
  title: string;
  routeIds: number[];
}

const effective = (d: { scheduledUtc: string; estimatedUtc: string | null }) =>
  d.estimatedUtc ?? d.scheduledUtc;

export function shapeDepartures(resp: PtvDeparturesResponse, nowMs: number): Departure[] {
  return resp.departures
    .map((d): Departure => {
      const estimatedUtc = d.estimated_departure_utc;
      const when = estimatedUtc ?? d.scheduled_departure_utc;
      return {
        routeId: d.route_id,
        directionId: d.direction_id,
        line: resp.routes?.[d.route_id]?.route_name ?? `Route ${d.route_id}`,
        routeNumber: resp.routes?.[d.route_id]?.route_number || null,
        destination:
          resp.runs?.[d.run_ref]?.destination_name ??
          resp.directions?.[d.direction_id]?.direction_name ??
          "Unknown",
        scheduledUtc: d.scheduled_departure_utc,
        estimatedUtc,
        minutes: minutesAway(when, nowMs),
        live: estimatedUtc !== null,
        platform: d.platform_number,
        disruptionIds: d.disruption_ids ?? [],
      };
    })
    .filter((d) => Date.parse(effective(d)) >= nowMs - 60_000)
    .sort((a, b) => Date.parse(effective(a)) - Date.parse(effective(b)));
}

export function renderDeparture(d: Departure): string {
  const eta = d.minutes === 0 ? "now" : `${d.minutes} min`;
  const label = d.routeNumber ? `Route ${d.routeNumber}` : `${d.line} line`;
  const base = `${label} → ${d.destination}: ${eta} (${d.live ? "live" : "scheduled"}), ${formatMelbourneTime(effective(d))}`;
  return d.platform ? `${base}, Platform ${d.platform}` : base;
}

export function shapeDisruptions(resp: PtvDisruptionsResponse): Disruption[] {
  return Object.values(resp.disruptions ?? {})
    .flat()
    .map((x) => ({ id: x.disruption_id, title: x.title, routeIds: (x.routes ?? []).map((r) => r.route_id) }));
}
