import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPlacesSearch } from "./tools/places-search.js";
import { registerPlaceDetails } from "./tools/place-details.js";

/**
 * Build a fresh MCP server instance with the EINS Places tools registered.
 *
 * We create a new instance per request (stateless serverless model). This is
 * cheap relative to a Places API roundtrip and avoids any cross-request state
 * leakage on Vercel.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "eins-places-mcp",
    version: "0.1.0",
  });

  registerPlacesSearch(server);
  registerPlaceDetails(server);

  return server;
}
