# PTV MCP Server: Design

Refines `SPEC.md`. Where the two differ, this document wins. Everything not mentioned here (caching TTLs, HMAC signing, Phase 2 portability, deployment steps) stays as written in `SPEC.md`.

## Goal

A remote (Streamable HTTP) MCP server on a Cloudflare Worker that gives LOKE's Melbourne staff live and scheduled PTV train and tram departures, usable from Claude web and mobile and from voice agents. Metro trains and trams only, with the CBD as the default destination.

## Tools

The `SPEC.md` set of five is cut to two. Fewer tools means fewer round trips and less for a voice agent to orchestrate.

### `find_stop(query, mode?)`

Resolves a name to stops. Calls `/v3/search/{term}`, restricted to metro train and tram.
Returns, per match: stop ID, name, mode, and the routes serving it.

### `next_departures(stop, mode?, route?, direction?, limit = 5)`

- `stop` is a name or an ID. A name is resolved internally with the same search as `find_stop`. If it matches more than one stop, return the candidates and no departures rather than guessing.
- `direction` defaults to `city`. Other values are `outbound` or a direction ID. `city` is resolved server-side per route from the derived `city_routes` config.
- Returns, per departure: line, destination, scheduled time, live estimate (or an explicit "scheduled" label), minutes away, platform.
- Attaches any active disruptions on the returned routes.

### Removed

| Dropped | Why |
| --- | --- |
| `commute_to_city` | `next_departures` with its default `direction=city`, plus attached disruptions. |
| `city_routes` | Internal config, built by the daily cron. Not something a user asks about. |
| `disruptions` | Internal cached fetch (120 s) attached to `next_departures` results. |
| `plan_trip` | PTV v3 has no journey planner. A direct-only version duplicates `next_departures` with an arrival time added. Revisit if arrival times are wanted. |

## Output rules

Unchanged from `SPEC.md`: answer-shaped text, never raw PTV JSON. Live versus scheduled is always explicit. Times are in Australia/Melbourne, with UTC kept internally.

## Access control

`SPEC.md` specifies Google OAuth. This design replaces it with a shared static token. The data is public transport times, so the token exists only to let us block requests if needed, not to protect anything sensitive.

- The connector URL carries the token: `https://<host>/mcp?token=<TOKEN>`. Claude custom connectors accept a URL with a query string, so staff add it once.
- The Worker compares the `token` query parameter to the `MCP_TOKEN` secret in constant time. A missing or wrong token gets a 401 before any MCP or PTV work.
- Blocking is done by rotating the secret (`wrangler secret put MCP_TOKEN`) and sharing the new URL. Allowing more than one valid token is out of scope for v1.
- The token must never be logged. Log the path without the query string.
- `workers-oauth-provider`, `OAUTH_KV` and the Google secrets are dropped. So is the "non-LOKE account is refused" acceptance check, replaced by "a request without the token is refused".
- With no user identity, the per-user rate limit becomes a single limit on the whole token (Workers Rate Limiting binding, default 120 calls per minute, adjustable). The global upstream cap on PTV calls stays. Logs record tool, latency and cache hit or miss, with no user email.
- Trade-off: the token appears in URLs and so may show up in browser history or proxy logs on the client side. That is acceptable given the stated purpose.

## Structure

- `core/` is a runtime-agnostic TypeScript package holding the PTV client, HMAC signing, response shaping, the `city_routes` builder and the cache interface. It has no Workers or AWS imports.
- `worker/` is a thin layer: the `McpAgent` tool registration, the token check, the KV and Cache API implementations of the cache interface, the rate-limit binding and the cron handler.
- Phase 2 is a second thin layer over `core/` for Lambda, where the gateway's company identity replaces the token.

## Build order

One implementation plan, in this order:

1. `core/` and both tools, tested against recorded PTV fixtures and run locally through MCP Inspector.
2. The cache layer and the cron.
3. The token check and rate limit.
4. Deploy and connector setup. This step needs the real PTV key, which takes days to arrive. Everything before it can be finished and tested on fixtures.

## Testing

- Unit tests for signing, shaping, `city_routes` derivation and direction resolution, run against recorded fixtures.
- Cache behaviour tests covering a hit within 30 s, stale-while-revalidate up to 60 s, and the stale fallback with a "may be delayed" flag when PTV is unreachable.
- Token check tests: a missing token, a wrong token and a correct token, plus a check that the token never appears in logs.
- The remaining acceptance checks from `SPEC.md` are verified against the live service after deploy.

## Open questions carried over

Destination definition (CBD in general or nearest stop to the office), PTV's published rate limit, key ownership, and cross-city tram directions. The plan assumes "CBD in general" and excludes both directions on cross-city tram routes. Buses and V/Line stay out of scope. A saved home stop is dropped, since it needed per-user identity that no longer exists.
