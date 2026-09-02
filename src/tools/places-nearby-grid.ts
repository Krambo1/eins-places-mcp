import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { nearbySearch } from "../places-client.js";
import { runGrid, type GridPoint } from "../grid.js";

/**
 * places_nearby_grid (v0.2.0, Outreach v3 Step 4).
 *
 * ONE tool call sweeps a whole city: the caller sends precomputed grid points
 * (the Outreach skill derives them offline from real postal-code centroids),
 * the server loops Nearby Search over them, subdivides saturated circles, and
 * returns the deduped, name-gated union. The loop lives HERE — not in an LLM
 * worker — because it is judgment-free and per-call latency is ~300 ms, so a
 * full city fits comfortably inside one serverless invocation.
 *
 * The server stays niche-agnostic: includedTypes, name-gate tokens, and
 * gate-exempt types all arrive as parameters (the skill reads them from its
 * lens-config.json).
 */

const MAX_POINTS = 120;
const MAX_CALLS_HARD = 120; // ~300 ms/call sequential worst case ≈ 36 s; concurrency keeps real runs far below maxDuration
const CONCURRENCY = 4;

const inputShape = {
  points: z
    .array(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radius: z.number().min(50).max(50000),
      }),
    )
    .min(1)
    .max(MAX_POINTS)
    .describe(
      "Grid circles to sweep, typically one per real postal code of the city (precomputed by the caller). radius in meters.",
    ),
  included_types: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe(
      "Google place types (Table A) to include, e.g. ['doctor','skin_care_clinic'].",
    ),
  name_gate_tokens: z
    .array(z.string().min(1))
    .max(100)
    .optional()
    .describe(
      "Niche vocabulary: a result is kept only if its folded name contains one of these substrings, or its type is gate-exempt. Empty/omitted = no gate.",
    ),
  gate_exempt_types: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe(
      "Types that bypass the name gate (e.g. ['skin_care_clinic'] — the type itself is the niche signal).",
    ),
  max_calls: z
    .number()
    .int()
    .min(1)
    .max(MAX_CALLS_HARD)
    .optional()
    .describe(
      `Nearby Search budget for this invocation (default 80, hard cap ${MAX_CALLS_HARD}). Points beyond the budget are reported as saturated_unexplored.`,
    ),
  min_radius: z
    .number()
    .min(50)
    .max(5000)
    .optional()
    .describe(
      "Saturated circles are subdivided until this radius (meters, default 250).",
    ),
  language: z.string().length(2).optional().describe("Defaults to 'de'."),
  region: z.string().length(2).optional().describe("Defaults to 'DE'."),
};

/**
 * Bounded-lookahead wrapper: grid.ts awaits calls one at a time (its
 * saturation logic is sequential by nature), but the underlying HTTP calls
 * for DIFFERENT points are independent. We keep up to CONCURRENCY seed-point
 * requests in flight AHEAD OF CONSUMPTION, keyed on point identity.
 *
 * The window slides on CONSUMPTION (searchFn invocations), not on promise
 * settlement — otherwise a small max_calls budget would still fire every
 * seed point against Google (billed!) even though runGrid stops early. With
 * this design the overshoot past an exhausted budget is at most CONCURRENCY
 * requests.
 *
 * Subdivision points cannot be known upfront, so they run sequentially; seed
 * points dominate call volume in practice. Attaching a no-op catch to
 * prefetched promises prevents unhandled-rejection noise; runGrid awaits the
 * SAME promise and still observes the error.
 */
function makeSearchFn(
  seedPoints: GridPoint[],
  includedTypes: string[],
  options: { languageCode?: string; regionCode?: string },
) {
  const keyOf = (p: GridPoint) => `${p.lat},${p.lng},${p.radius}`;
  const call = (p: GridPoint) =>
    nearbySearch(
      { latitude: p.lat, longitude: p.lng, radius: p.radius, includedTypes },
      options,
    );

  const prefetched = new Map<string, ReturnType<typeof call>>();
  let launched = 0;
  let consumed = 0;

  const topUp = () => {
    while (launched < seedPoints.length && launched - consumed < CONCURRENCY) {
      const p = seedPoints[launched++];
      const key = keyOf(p);
      if (prefetched.has(key)) continue; // duplicate seed point: reuse the same promise
      const promise = call(p);
      promise.catch(() => {});
      prefetched.set(key, promise);
    }
  };
  topUp();

  return async (p: GridPoint) => {
    consumed += 1;
    const hit = prefetched.get(keyOf(p));
    topUp();
    if (hit) return hit;
    return call(p);
  };
}

export function registerPlacesNearbyGrid(server: McpServer): void {
  server.tool(
    "places_nearby_grid",
    "Sweep a city with Google Nearby Search (New) over a grid of circles in ONE call: dedupes across circles, auto-subdivides saturated circles (Nearby returns max 20, no pagination), applies an optional name gate, and returns candidate businesses as {place_id, name, formatted_address, primary_type} plus sweep stats. Use for exhaustive type-based discovery that text search misses.",
    inputShape,
    async ({
      points,
      included_types,
      name_gate_tokens,
      gate_exempt_types,
      max_calls,
      min_radius,
      language,
      region,
    }) => {
      const options = { languageCode: language, regionCode: region };
      const seedPoints: GridPoint[] = points.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        radius: p.radius,
      }));

      const { candidates, stats } = await runGrid({
        points: seedPoints,
        maxCalls: max_calls ?? 80,
        minRadius: min_radius ?? 250,
        nameGateTokens: name_gate_tokens ?? [],
        gateExemptTypes: gate_exempt_types ?? [],
        searchFn: makeSearchFn(seedPoints, included_types, options),
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { count: candidates.length, candidates, stats },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
