import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textSearchGeo } from "../places-client.js";
import { buildRankGridPoints } from "../grid.js";
import { runRankGrid } from "../rank-grid.js";

/**
 * places_rank_grid (v0.3.0).
 *
 * Geo-grid rank tracking for local-SEO audits: runs ONE text query from every
 * point of a grid_size x grid_size square grid around a center (a medical
 * practice, typically), and reports the order Google Places Text Search (New)
 * returns at each point, plus where an optional target_place_id lands.
 *
 * This is a PROXY for the Google Maps local pack a patient actually sees,
 * NOT a byte-exact reproduction of it: the Places API's `locationBias`
 * nudges relevance toward a point without hard-restricting to it (there is
 * no `locationRestriction` circle for Text Search the way Nearby Search
 * has one), and the Maps app itself folds in signals (live personalization,
 * viewport, A/B tests) the API does not expose. Treat this as a consistent,
 * repeatable approximation for tracking relative movement over time — not as
 * "this is what rank #3 on Maps looks like today".
 */

const MAX_CALLS_HARD = 81; // 9x9

const inputShape = {
  query: z
    .string()
    .min(2)
    .describe(
      "Free-text search query to run from every grid point, e.g. 'Hyaluron' or 'Faltenbehandlung'.",
    ),
  center: z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .describe("Grid center, typically the practice's own coordinates."),
  grid_size: z
    .number()
    .int()
    .min(3)
    .max(9)
    .refine((n) => n % 2 === 1, "grid_size must be odd")
    .optional()
    .describe(
      "Odd grid dimension (default 5): grid_size x grid_size points, the center point sits in the middle cell.",
    ),
  spacing_m: z
    .number()
    .min(200)
    .max(5000)
    .optional()
    .describe("Distance in meters between neighbouring grid points (default 800)."),
  target_place_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Google Places ID to locate in each point's result list. Omit to just see the ranked lists.",
    ),
  language: z.string().length(2).optional().describe("Defaults to 'de'."),
  region: z.string().length(2).optional().describe("Defaults to 'DE'."),
  max_calls: z
    .number()
    .int()
    .min(1)
    .max(MAX_CALLS_HARD)
    .optional()
    .describe(
      `Text Search call budget for this invocation (default 49, hard cap ${MAX_CALLS_HARD} = 9x9). Grid points beyond the budget are skipped and reported with fehler set, not silently dropped.`,
    ),
};

const CONCURRENCY = 5;

export function registerPlacesRankGrid(server: McpServer): void {
  server.tool(
    "places_rank_grid",
    "Geo-grid rank tracking for local SEO: runs ONE Google Places Text Search (New) query from every point of a square grid around a center coordinate (e.g. a medical practice) and reports the rank order returned at each point, plus where an optional target_place_id lands. Approximates what a patient searching from different spots in the neighbourhood sees — a PROXY for the Google Maps local pack, not identical to it. COST: N grid points = N Text Search Pro calls (5,000 free/month, then $32/1k); grid_size x grid_size points are attempted up to max_calls, default 49.",
    inputShape,
    async ({ query, center, grid_size, spacing_m, target_place_id, language, region, max_calls }) => {
      const size = grid_size ?? 5;
      const spacing = spacing_m ?? 800;
      const options = { languageCode: language, regionCode: region };

      const gridPoints = buildRankGridPoints(center, size, spacing);

      const { punkte, stats } = await runRankGrid({
        points: gridPoints,
        maxCalls: max_calls ?? 49,
        targetPlaceId: target_place_id ?? null,
        concurrency: CONCURRENCY,
        searchFn: (point) =>
          textSearchGeo(query, { lat: point.lat, lng: point.lng }, spacing, options),
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query,
                center,
                grid_size: size,
                spacing_m: spacing,
                target_place_id: target_place_id ?? null,
                punkte,
                stats,
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
