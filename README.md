# cloudflare-ptv-mcp
MCP server for checking realtime and scheduled PTV routes from a HTTP connector making it possible from voice agents

Similar project but stdio: https://github.com/kensantoso/ptv-mcp

## Tools

- `find_stop(query, mode?)`: find train stations and tram stops by name.
- `next_departures(stop, mode?, route?, direction?, limit?)`: next departures from a stop (name or ID), heading into the city by default, with live times and active disruptions.

## Connecting

Add a custom connector in Claude with the URL `https://ptv-mcp.loke.tools/mcp?token=<MCP_TOKEN>` (deployed on the LOKE Cloudflare account as a custom domain; `workers.dev` and preview URLs are disabled). The token is a shared secret that only exists so requests can be blocked if needed. To revoke access, set a new one (`wrangler secret put MCP_TOKEN`) and share the new URL.

## Development

See `CLAUDE.md` for commands and architecture, and `docs/superpowers/` for the design and plan.
