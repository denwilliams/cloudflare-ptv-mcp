import { createMcpHandler } from "agents/mcp/server";
import { redactedPath, tokenValid } from "./auth";
import { warmStatic } from "./cron";
import { buildServer } from "./mcp";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    if (!(await tokenValid(url, env.MCP_TOKEN))) {
      console.log(JSON.stringify({ event: "unauthorized", path: redactedPath(url) }));
      return new Response("Unauthorized", { status: 401 });
    }

    const { success } = await env.MCP_LIMITER.limit({ key: "token" });
    if (!success) return new Response("Too many requests", { status: 429, headers: { "retry-after": "60" } });

    return createMcpHandler(() => buildServer(env, ctx))(request, env, ctx);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(warmStatic(env, ctx));
  },
} satisfies ExportedHandler<Env>;
