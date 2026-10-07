// Records real PTV v3 responses into core/test/fixtures/recorded/ and prints the derived
// city-direction map so overrides can be checked by eye.
//   PTV_DEV_ID=... PTV_API_KEY=... npx tsx scripts/record-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { MemoryCacheStore, createPtvClient, getCityRoutes } from "@ptv/core";

const devId = process.env.PTV_DEV_ID;
const apiKey = process.env.PTV_API_KEY;
if (!devId || !apiKey) {
  console.error("Set PTV_DEV_ID and PTV_API_KEY in the environment.");
  process.exit(1);
}

const out = new URL("../core/test/fixtures/recorded/", import.meta.url);
mkdirSync(out, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(new URL(name, out), JSON.stringify(data, null, 2));

const client = createPtvClient({ devId, apiKey });
type R = { routes: Array<{ route_id: number; route_name: string; route_type: number }> };
type D = { directions: Array<{ direction_id: number; direction_name: string }> };
type S = { stops: Array<{ stop_id: number; route_type: number }> };

const routes = await client.get<R>("/v3/routes", { route_types: [0, 1] });
save("routes.json", routes);

const directions: Record<number, D> = {};
for (const r of routes.routes) directions[r.route_id] = await client.get<D>(`/v3/directions/route/${r.route_id}`);
save("directions.json", directions);

const search = await client.get<S>("/v3/search/Ascot%20Vale", { route_types: [0, 1] });
save("search-ascot.json", search);

const train = search.stops.find((s) => s.route_type === 0);
if (train) {
  save(
    "departures.json",
    await client.get(`/v3/departures/route_type/0/stop/${train.stop_id}`, {
      max_results: 40,
      expand: ["Route", "Direction", "Run"],
    }),
  );
}
save("disruptions.json", await client.get("/v3/disruptions", { route_types: [0, 1], disruption_status: "current" }));

// Review the derived city directions: wrong or missing entries need CITY_DIRECTION_OVERRIDES.
const cityRoutes = await getCityRoutes(client, new MemoryCacheStore(), { now: Date.now, defer: () => {} });
console.log("\nRoute -> city direction");
for (const r of routes.routes) {
  const c = cityRoutes[r.route_id];
  const dirs = directions[r.route_id]!.directions;
  if (c) console.log(`  ok   ${r.route_name}: ${dirs.find((d) => d.direction_id === c.cityDirectionId)?.direction_name}`);
  else console.log(`  MISS ${r.route_name} (${r.route_id}): ${dirs.map((d) => `${d.direction_id}=${d.direction_name}`).join(" | ")}`);
}
