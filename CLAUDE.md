# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

The repo currently contains only `README.md` and `SPEC.md`. There is no code, `package.json` or `wrangler.toml` yet, so there are no build, lint or test commands to record. `SPEC.md` is the source of truth for design. Update this file once the project is scaffolded (the spec says to scaffold from Cloudflare's remote MCP server template: `agents` SDK + OAuth provider).

## What this is

A remote (Streamable HTTP) MCP server giving LOKE's Melbourne staff live and scheduled PTV (Public Transport Victoria) train and tram info for getting into the city, usable from Claude web and mobile.

- Phase 1: Cloudflare Worker proof of concept (TypeScript, `agents` SDK `McpAgent`, `workers-oauth-provider` with Google Workspace upstream, LOKE domain only).
- Phase 2: the same tools served from a Lambda target behind the LOKE AgentCore gateway. This is why the PTV client, signing and response shaping should live in a runtime-agnostic package that both the Worker and the Lambda import. Keep the tool contracts identical across phases.
- Scope: Metro trains and trams toward the CBD, plus disruptions. Buses and V/Line are out of scope for v1.

## Architecture (from SPEC.md)

Claude → Worker `/mcp` → OAuth check → tool handler → cache → (on miss) signed PTV request → shape into compact answer.

Five tools: `commute_to_city`, `next_departures`, `search_stops`, `city_routes`, `disruptions`.

Design rules that cut across files:
- Output is answer-shaped ("Frankston line, Flinders St, 7 min (live), Platform 2"), never raw PTV JSON.
- "Into the city" is resolved server-side to a per-route `direction_id` using a derived `city_routes` config. CBD stops are listed in the spec.
- Live vs scheduled must always be explicit. `estimated_departure_utc` is null when there is no realtime data, so label the time as scheduled.
- Keep UTC internally and render Australia/Melbourne local time in output.

PTV auth: every request is signed with HMAC-SHA1 (key = `PTV_API_KEY`) over the path plus query including `devid`, uppercase hex-encoded, and appended as `&signature=`. A reference implementation using `crypto.subtle` is in SPEC.md. Never log signed URLs or return them in tool output. Secrets (`PTV_DEV_ID`, `PTV_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) live only in Worker secrets.

Caching (cache the raw PTV response before shaping, so tools share entries):
- Departures: Cache API, 30 s TTL, stale-while-revalidate up to 60 s via `ctx.waitUntil`, key `dep:{rt}:{stop}:{route}:{dir}`. Keyed by stop/direction, not by user.
- Disruptions: Cache API, 120 s.
- Stop search, routes, directions, stops on route, `city_routes`: KV (`PTV_CACHE`), 24 h, warmed and rebuilt by a daily cron.
- If PTV is unreachable or the global upstream cap is hit, serve stale data with a "may be delayed" flag instead of erroring.

Access control: no anonymous endpoint, since an open URL would burn the shared PTV key. 60 tool calls/min/user via the Workers Rate Limiting binding. Logs contain email, tool, latency and cache hit/miss, and no locations are retained beyond 7 days.

Bindings expected in `wrangler.toml`: KV `PTV_CACHE`, KV `OAUTH_KV`, a rate-limit binding, and a cron trigger. See the Deployment section of SPEC.md. Test against `/mcp` with MCP Inspector.

## Open questions

`SPEC.md` ends with unresolved decisions (destination definition, saved home stop, PTV rate limits, key ownership, cross-city tram directions, buses/V/Line). Check them before assuming a behaviour.
