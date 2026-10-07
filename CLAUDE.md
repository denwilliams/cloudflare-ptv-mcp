# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A remote (Streamable HTTP) MCP server on a Cloudflare Worker giving LOKE's Melbourne staff live PTV (Public Transport Victoria) train and tram departures. Two tools: `find_stop` and `next_departures` (direction defaults to the city, active disruptions attached). Metro trains and trams only.

Design lives in `docs/superpowers/specs/2026-10-07-ptv-mcp-design.md` and the build plan in `docs/superpowers/plans/2026-10-07-ptv-mcp.md`. `SPEC.md` is the original spec; **where it differs from the design doc, the design doc wins** (five tools became two, Google OAuth became a static token, `McpAgent` became `createMcpHandler`).

## Commands

```bash
npm install
npm test                          # both workspaces
npm test --workspace core         # core only (plain vitest, node)
npm test --workspace worker       # worker only (vitest in the Workers runtime)
npm run typecheck                 # both workspaces
cd core && npx vitest run test/cache.test.ts -t "falls back"   # one test (same in worker/)
npm run dev --workspace worker    # wrangler dev; needs worker/.dev.vars (see below)
npm run deploy --workspace worker
PTV_DEV_ID=... PTV_API_KEY=... npx tsx scripts/record-fixtures.ts   # record real PTV fixtures
```

`worker/.dev.vars` (git-ignored) needs `MCP_TOKEN`, `PTV_DEV_ID` and `PTV_API_KEY`. Deployed, the same three are Worker secrets set with `wrangler secret put`.

## Architecture

- `core/` is runtime-agnostic: PTV client and HMAC-SHA1 signing, cache policy, shaping, `city_routes` derivation, and the two tool functions (`findStop`, `nextDepartures`). It may only use `fetch` and `crypto.subtle` globals, so the same code can later run in a Lambda behind the AgentCore gateway (Phase 2 in `SPEC.md`).
- `worker/` is a thin layer: `index.ts` (path check, token check, rate limit, then `createMcpHandler`), `mcp.ts` (tool registration and the one log line per call), `caches.ts` (KV and Cache API implementations of core's `CacheStore`), `cron.ts` and `runtime.ts` (builds core's `ToolContext` from bindings).
- Tools return answer-shaped text, never raw PTV JSON. Live vs scheduled is always labelled. Times are Australia/Melbourne; UTC internally.

How the pieces fit together:
- `cached()` in `core/src/cache.ts` is the single caching entry point: fresh hit, stale-while-revalidate (refresh via `rt.defer` = `ctx.waitUntil`), and fallback to an old entry with a "may be delayed" warning when PTV fails. The PTV client's `guard` (the `PTV_LIMITER` binding) makes the upstream cap look like a PTV failure, so it takes the same fallback path.
- "Into the city" is resolved by `getCityRoutes`: for each train/tram route it picks the direction whose name matches a CBD station name. Routes with zero or several matches (cross-city trams) are left out unless `CITY_DIRECTION_OVERRIDES` (in `core/src/cityRoutes.ts`) names the direction. The name matching is a heuristic; check it against real data after recording fixtures.
- Departures are cached per stop (`dep:{routeType}:{stop}`), not per user. Direction and route filters are applied after caching because direction IDs are per route.

## Gotchas

- Access control is a shared `?token=` query parameter checked in constant time against `MCP_TOKEN`; rotate the secret to block everyone. Never log the token, the query string, signed PTV URLs, `devid`, or tool arguments. Errors from the PTV client deliberately contain no URL.
- The Cache API does nothing on `*.workers.dev`; departure/disruption caching only works on a custom domain.
- Cron triggers are UTC: `0 17 * * *` is about 3–4 am Melbourne.
- The Rate Limiting binding is per Cloudflare location and eventually consistent.
- Fixtures in `core/test/fixtures/` are hand-written from documented v3 shapes. Real responses go in `core/test/fixtures/recorded/` (via `scripts/record-fixtures.ts`); `core/test/recorded.test.ts` skips until that directory exists.
- Worker tests import `env` and `SELF` from `cloudflare:test` (package `@cloudflare/vitest-plugin`), and the worker's `Env` type is declared by hand in `worker/src/env.d.ts`.
