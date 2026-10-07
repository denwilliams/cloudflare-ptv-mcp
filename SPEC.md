# PTV MCP Server — Spec

## Overview

A remote (Streamable HTTP) MCP server that gives LOKE's Melbourne staff live train and tram info for getting into the city, usable from Claude on web and mobile.

- **Phase 1:** Cloudflare Worker proof of concept. Fast to ship, not built to last.
- **Phase 2:** the same tools served from the LOKE AgentCore company gateway, behind company identity.
- **Data source:** PTV Timetable API v3. No GTFS bulk data is hosted; PTV is the source of truth and the server caches it.
- **Scope:** Metro trains and trams heading toward the CBD, plus disruptions on those routes. Buses and V/Line are out of scope for v1.

## Architecture

One Cloudflare Worker sits between Claude and PTV and does three jobs: it speaks MCP, signs requests to PTV, and caches the responses.

Request path:

1. Claude (web or mobile) calls a tool on the Worker's `/mcp` endpoint using Streamable HTTP.
2. The Worker checks the user's OAuth token.
3. The tool handler builds the PTV request and checks the cache.
4. On a cache miss, the Worker signs the request (HMAC-SHA1), calls `timetableapi.ptv.vic.gov.au/v3/...`, and stores the result with a TTL set by data type.
5. The Worker shapes the result into a compact answer: line, direction, scheduled time, live estimate, minutes away, and any disruptions.

Stack:

- **Runtime:** Cloudflare Workers with TypeScript, using the `agents` SDK (`McpAgent`) for the MCP layer.
- **Static cache:** Workers KV for slow-changing data (routes, stops, directions).
- **Live cache:** Cache API for short-lived data (departures, disruptions).
- **Secrets:** `PTV_DEV_ID` and `PTV_API_KEY`, stored with `wrangler secret`.
- **Auth:** `workers-oauth-provider` with Google Workspace as the upstream identity provider.

## MCP tools

There are five tools. They cover "how do I get into the city right now", plus plain lookups when someone's going elsewhere.

| Tool | Inputs | Returns | PTV endpoints |
| --- | --- | --- | --- |
| `commute_to_city` | `stop` (name or ID), `mode` (train or tram, optional), `limit` (default 5) | Next services toward the CBD with live ETA, platform, and active disruptions on those routes | search, departures, disruptions |
| `next_departures` | `stop_id`, `mode`, `route_id` (optional), `direction` (city, outbound, or a direction ID), `limit` | Departures with scheduled time, estimated time, and minutes away | `/v3/departures/route_type/{rt}/stop/{id}` |
| `search_stops` | `query`, `mode` (optional) | Matching stations and stops with IDs, modes, and the routes serving them | `/v3/search/{term}` |
| `city_routes` | `mode` (optional) | The curated list of train lines and tram routes into the CBD, each with its city-bound direction ID | `/v3/routes`, `/v3/directions/route/{id}` |
| `disruptions` | `mode` (optional), `route_ids` (optional) | Current disruptions, filtered to city routes by default | `/v3/disruptions` |

Design rules:

- **Answer-shaped output.** Return "Frankston line, Flinders St, 7 min (live), Platform 2", not raw PTV JSON. The model reads it faster and spends fewer tokens.
- **City direction is resolved server-side.** Users say "into the city", and the server maps that to the right `direction_id` for each route using the `city_routes` config.
- **Live versus scheduled is always explicit.** `estimated_departure_utc` is null when no realtime data exists. In that case, label the time as scheduled.
- **Times in Melbourne local time** (Australia/Melbourne) in output. Keep UTC internally.
- **CBD stops** counted as "city": Flinders Street, Southern Cross, Melbourne Central, Parliament, Flagstaff, plus the Metro Tunnel stations (Town Hall, State Library) and CBD tram stops on the city routes.

## Caching

Cache by how often the data actually changes. That way, most staff requests never reach PTV.

| Data | Store | TTL | Cache key |
| --- | --- | --- | --- |
| Departures | Cache API | 30 s | `dep:{rt}:{stop}:{route}:{dir}` |
| Disruptions | Cache API | 120 s | `dis:{rt}` |
| Stop search | KV | 24 h | `search:{normalised term}:{mode}` |
| Routes, directions, stops on route | KV | 24 h (refreshed by a daily cron) | `route:{id}`, `dir:{route}`, `stops:{route}` |
| City routes config (derived) | KV | Rebuilt daily | `city_routes` |

- Cache the PTV response **before** shaping it, so different tools can share the same entries.
- **Stale-while-revalidate on departures:** serve an entry up to 60 s old while a background refresh runs via `ctx.waitUntil`.
- **Departures by stop and direction**, not by user. Ten people at Flinders St at 5:30 pm should cost one PTV call per 30 s.
- **Daily cron trigger** warms the static cache and rebuilds `city_routes`.
- Cache API is per data centre, which is fine because all users are in Melbourne. KV is global, with eventual consistency of about 60 s, which is fine for static data.

## PTV auth

Every PTV request is signed with HMAC-SHA1, using the API key as the secret. One shared developer ID and key serve all staff.

Signing steps:

1. Build the path and query string, including `devid`. For example: `/v3/departures/route_type/0/stop/1071?max_results=5&devid=1234567`.
2. Compute the HMAC-SHA1 of that string using `PTV_API_KEY`, and hex-encode it in uppercase.
3. Append `&signature={hex}` and call `https://timetableapi.ptv.vic.gov.au` with that path.

Available through `crypto.subtle` in Workers, with no dependencies:

```ts
async function signedUrl(pathAndQuery: string, devId: string, key: string) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const toSign = `${pathAndQuery}${sep}devid=${devId}`;
  const k = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(toSign));
  const hex = [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `https://timetableapi.ptv.vic.gov.au${toSign}&signature=${hex}`;
}
```

- **Key request:** PTV issues keys by email request (APIKeyRequest@ptv.vic.gov.au). Expect a lead time of a few days, so request it first.
- **Storage:** secrets live only in Worker secrets. Never log signed URLs, and never return them in tool output.

## Multi-user, auth and rate limits

Staff authenticate to the Worker. Only the Worker talks to PTV, so the shared key is never exposed and caching absorbs the load.

- **User auth:** OAuth using `workers-oauth-provider`, upstream to Google Workspace. Sign-in is restricted to the LOKE domain. Claude custom connectors handle the OAuth flow.
- **No anonymous endpoint.** An open URL would let anyone burn through the PTV key.
- **Per-user limit:** 60 tool calls per minute per user, enforced with the Workers Rate Limiting binding. This stops one runaway agent loop from starving everyone else.
- **Upstream guard:** a global cap on PTV calls per minute. If it's hit, serve stale cache with a "may be delayed" flag rather than failing.
- **Logging:** user email, tool, latency, and cache hit or miss. No locations retained beyond 7 days.
- **Expected load:** a few dozen staff, mostly around 7:30–9:30 am and 4:30–6:30 pm. With 30 s departure caching, peak PTV traffic is bounded by the number of distinct stops and directions, not by headcount.

## Deployment and connector setup

Deploy with Wrangler, then add the connector once at org level so every staff member gets it on web and mobile.

1. Scaffold from Cloudflare's remote MCP server template (`agents` SDK with OAuth provider).
2. Create the KV namespaces (`PTV_CACHE`, `OAUTH_KV`) and a rate-limit binding in `wrangler.toml`.
3. Run `wrangler secret put` for `PTV_DEV_ID`, `PTV_API_KEY`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`.
4. Add a cron trigger (`0 3 * * *` Melbourne time) to warm the static cache.
5. Deploy to a custom domain, for example `ptv-mcp.loke.global`.
6. Test with MCP Inspector against `/mcp` before adding the connector to Claude.
7. In Claude, an org owner adds a custom connector with that URL. Staff connect once and sign in with Google. The connector then appears in the mobile app.

Acceptance checks:

- [ ] "When's the next train into the city from Ascot Vale?" returns live times on mobile.
- [ ] A repeat call within 30 s is served from cache.
- [ ] A non-LOKE Google account is refused.
- [ ] With PTV unreachable, the server returns stale data and a warning instead of erroring.

## Phase 2: AgentCore Gateway

Keep the tool contracts identical so moving to the company gateway is a hosting change, not a rewrite.

- **Shared core:** put the PTV client, signing, and response shaping in a runtime-agnostic TypeScript package. The Worker and the Lambda target both import it.
- **Gateway target:** a Lambda function exposing the same five tools. The gateway handles MCP transport and company IdP auth, so drop `workers-oauth-provider`.
- **Cache swap:** KV becomes DynamoDB with TTL (static data). The Cache API becomes ElastiCache or DynamoDB with a 30 s TTL (departures). Same keys, same TTLs.
- **Secrets:** the PTV key moves to Secrets Manager.
- **Cutover:** run both in parallel for a week, switch the org connector to the gateway, then retire the Worker.

## Open questions

- [ ] Which office address counts as the destination? Is it "city" in general, or the nearest stop to the LOKE office?
- [ ] Should staff be able to save a home stop, so "next train to work" needs no stop name? That needs per-user storage keyed on email.
- [ ] Does PTV publish a request rate limit for API v3, or do we size the upstream cap ourselves?
- [ ] Is the PTV key registered to LOKE or to an individual? It should be a shared ops mailbox.
- [ ] Tram city direction: some routes cross the CBD rather than terminating there. Do we include both directions on cross-city routes?
- [ ] Are buses or V/Line needed for anyone's commute in v1?
