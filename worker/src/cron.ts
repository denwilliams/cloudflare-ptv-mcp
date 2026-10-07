import { getCityRoutes } from "@ptv/core";
import { toolContext } from "./runtime";

/** Daily: refetch routes and directions and rebuild city_routes. */
export async function warmStatic(env: Env, ctx: ExecutionContext): Promise<void> {
  const tc = toolContext(env, ctx);
  await getCityRoutes(tc.client, tc.static, tc.rt, { force: true });
}
