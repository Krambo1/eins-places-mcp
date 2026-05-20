import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textSearch } from "../places-client.js";

const inputShape = {
  query: z
    .string()
    .min(2)
    .describe(
      "Free-text search query. The Outreach Bot uses two: 'Praxis ästhetische Medizin' and 'Faltenbehandlung'.",
    ),
  city: z
    .string()
    .min(2)
    .describe(
      "City to bias the search to. Appended to the query, e.g. 'Düsseldorf'. The Outreach Bot reads this from the cities_to_cover property.",
    ),
  language: z
    .string()
    .length(2)
    .optional()
    .describe("ISO 639-1 language code. Defaults to 'de'."),
  region: z
    .string()
    .length(2)
    .optional()
    .describe("ISO 3166-1 alpha-2 region code. Defaults to 'DE'."),
};

export function registerPlacesSearch(server: McpServer): void {
  server.tool(
    "places_search",
    "Search Google Places (New) for businesses matching a text query in a given city. Returns up to ~20 candidates with place_id, name, address, rating, and review count. Use the returned place_id with the place_details tool to enrich.",
    inputShape,
    async ({ query, city, language, region }) => {
      const combined = `${query} ${city}`.trim();
      const results = await textSearch(combined, {
        languageCode: language,
        regionCode: region,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query: combined,
                count: results.length,
                results,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
