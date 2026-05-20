import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { placeDetails } from "../places-client.js";

const inputShape = {
  place_id: z
    .string()
    .min(1)
    .describe(
      "Google Places ID returned by places_search (e.g. 'ChIJ...'). One call per ID.",
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

export function registerPlaceDetails(server: McpServer): void {
  server.tool(
    "place_details",
    "Fetch full Google Places (New) details for a place_id. Returns website, phone, full rating + review count, opening hours, and Google Maps URI. Use after places_search to enrich candidates that passed initial filters.",
    inputShape,
    async ({ place_id, language, region }) => {
      const result = await placeDetails(place_id, {
        languageCode: language,
        regionCode: region,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
