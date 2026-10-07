// Secrets (MCP_TOKEN, PTV_DEV_ID, PTV_API_KEY) are set with `wrangler secret put`.
interface Env {
  PTV_CACHE: KVNamespace;
  MCP_LIMITER: RateLimit;
  PTV_LIMITER: RateLimit;
  PTV_DEV_ID: string;
  PTV_API_KEY: string;
  MCP_TOKEN: string;
}

declare namespace Cloudflare {
  interface Env extends globalThis.Env {}
}
