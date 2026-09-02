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
  with_rating: z
    .boolean()
    .optional()
    .describe(
      "Also return rating + user_ratings_total on every hit. COSTS MONEY: it moves the call from the Pro SKU (5,000 free/month) to the Enterprise SKU (1,000 free/month, shared with place_details). Default false. Leave it off unless you rank the hit list by rating; place_details returns rating anyway.",
    ),
};

export function registerPlacesSearch(server: McpServer): void {
  server.tool(
    "places_search",
    "Search Google Places (New) for businesses matching a text query in a given city. Returns up to ~20 candidates with place_id, name, address, types and business status (rating + review count only with with_rating=true, which is billed at the Enterprise SKU). Use the returned place_id with the place_details tool to enrich.",
    inputShape,
    async ({ query, city, language, region, with_rating }) => {
      const combined = `${query} ${city}`.trim();
      const results = await textSearch(combined, {
        languageCode: language,
        regionCode: region,
        withRating: with_rating === true,
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
