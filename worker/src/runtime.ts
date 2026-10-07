import { createPtvClient, type ToolContext } from "@ptv/core";
import { CacheApiStore, KvCacheStore } from "./caches";

export function toolContext(env: Env, ctx: ExecutionContext): ToolContext {
  return {
    client: createPtvClient(
      { devId: env.PTV_DEV_ID, apiKey: env.PTV_API_KEY },
      { guard: async () => (await env.PTV_LIMITER.limit({ key: "ptv" })).success },
    ),
    live: new CacheApiStore(),
    static: new KvCacheStore(env.PTV_CACHE),
    rt: { now: () => Date.now(), defer: (p) => ctx.waitUntil(p) },
  };
}
