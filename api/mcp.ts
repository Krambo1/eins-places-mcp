import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/server.js";

/**
 * Vercel Node Function entry for the MCP server.
 *
 * claude.ai sends JSON-RPC over HTTP POST (the "Streamable HTTP" MCP transport).
 * We run in stateless mode: a fresh server + transport pair per request.
 *
 * Auth: a single Bearer token (MCP_BEARER_TOKEN env var). claude.ai sends it
 * on every request via the Authorization header you configure in the
 * connector settings.
 */

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

// Optional: lazy-parsed body. Vercel parses JSON bodies for us when the
// Content-Type is application/json. If anyone calls with a different
// content-type we let the transport read the raw stream.
interface VercelRequest extends IncomingMessage {
  body?: unknown;
}

export default async function handler(
  req: VercelRequest,
  res: ServerResponse,
): Promise<void> {
  // Auth gate — single Bearer token shared with the claude.ai connector.
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "Server misconfigured: MCP_BEARER_TOKEN not set",
      }),
    );
    return;
  }

  // Accept the token either via the standard Authorization: Bearer header,
  // or via a `?token=` query parameter populated by the /mcp/:token rewrite.
  //
  // The query-param path exists because the claude.ai custom-connector UI only
  // exposes OAuth fields, no Bearer field. Putting the secret in the URL is
  // the same security posture as a Bearer header for a single-tenant server.
  const headerAuth = req.headers.authorization ?? "";
  const headerToken = headerAuth.startsWith("Bearer ")
    ? headerAuth.slice("Bearer ".length)
    : null;

  let queryToken: string | null = null;
  try {
    const url = new URL(req.url ?? "/", "http://placeholder");
    queryToken = url.searchParams.get("token");
  } catch {
    // ignore — leaves queryToken null
  }

  if (headerToken !== expected && queryToken !== expected) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("WWW-Authenticate", "Bearer");
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // Health probe: a plain GET without an MCP body returns a small JSON so
  // the operator can sanity-check the deploy from a browser (after sending
  // a Bearer token). The MCP protocol itself uses POST.
  if (req.method === "GET" && !req.headers["accept"]?.includes("text/event-stream")) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        name: "eins-places-mcp",
        status: "ok",
        tools: ["places_search", "place_details"],
      }),
    );
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: each request is its own session
  });

  // Clean up the transport when the response closes so we do not leak any
  // listeners on the request object.
  res.on("close", () => {
    transport.close().catch(() => {
      /* nothing to do; the function instance will be reaped */
    });
    server.close().catch(() => {
      /* same */
    });
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
