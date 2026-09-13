/**
 * Sweep + ranking logic for places_rank_grid (v0.3.0).
 *
 * Pure + deterministic: the Google call is injected as `searchFn`, so this
 * module is unit-testable without network, same pattern as grid.ts. Grid
 * point geometry itself lives in grid.ts (`buildRankGridPoints`); this module
 * owns turning N per-point Text Search result lists into the report shape
 * (ranked hits + target_rang) and running the sweep with bounded concurrency
 * and per-point error capture.
 *
 * This is a PROXY for the Google Maps local pack, not identical to it: real
 * local-pack ranking also folds in Maps-app-specific signals (viewport,
 * personalization, live A/B tests) that the Places API does not expose. Text
 * Search `locationBias` nudges relevance toward a point without hard-
 * restricting to it, so a very strong match just outside a cell can still
 * outrank a weak one inside it — see places-client.ts::textSearchGeo.
 */

export interface RankGridPointInput {
  zeile: number;
  spalte: number;
  lat: number;
  lng: number;
}

export interface RankSearchResult {
  place_id: string;
  name: string;
  formatted_address: string;
  primary_type?: string;
}

export interface RankedHit {
  rang: number;
  place_id: string;
  name: string;
  primary_type?: string;
  formatted_address: string;
}

export interface RankPunkt {
  zeile: number;
  spalte: number;
  lat: number;
  lng: number;
  ergebnisse: RankedHit[];
  target_rang: number | null;
  fehler: string | null;
}

export interface RankStats {
  calls: number;
  fehler: number;
  uebersprungen: number;
  sku: string;
}

export interface RunRankGridOptions {
  points: RankGridPointInput[];
  maxCalls: number;
  targetPlaceId: string | null;
  concurrency: number;
  searchFn: (point: RankGridPointInput) => Promise<RankSearchResult[]>;
}

export interface RunRankGridResult {
  punkte: RankPunkt[];
  stats: RankStats;
}

/** Text Search results arrive already ranked by Google; rang is 1-based position. */
export function toRankedHits(results: RankSearchResult[]): RankedHit[] {
  return results.map((r, i) => ({
    rang: i + 1,
    place_id: r.place_id,
    name: r.name,
    primary_type: r.primary_type,
    formatted_address: r.formatted_address,
  }));
}

/** null = target not among the returned results (max 20, i.e. "not among the returned results"). */
export function findTargetRang(
  hits: RankedHit[],
  targetPlaceId: string | null,
): number | null {
  if (!targetPlaceId) return null;
  const hit = hits.find((h) => h.place_id === targetPlaceId);
  return hit ? hit.rang : null;
}

/**
 * Runs the sweep with up to `concurrency` calls in flight at once. Points
 * beyond `maxCalls` are not called at all — reported as `uebersprungen`
 * (skipped) rather than as an error. One failed point is caught and recorded
 * on that point's `fehler`; it never fails the whole call.
 */
export async function runRankGrid(
  opts: RunRankGridOptions,
): Promise<RunRankGridResult> {
  const { points, maxCalls, targetPlaceId, concurrency, searchFn } = opts;

  const toCall = points.slice(0, maxCalls);
  const skipped = points.slice(maxCalls);

  const punkte: RankPunkt[] = new Array(toCall.length);
  const stats: RankStats = {
    calls: 0,
    fehler: 0,
    uebersprungen: skipped.length,
    sku: "Text Search Pro",
  };

  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= toCall.length) return;
      const point = toCall[i];
      stats.calls += 1;
      try {
        const results = await searchFn(point);
        const ergebnisse = toRankedHits(results);
        punkte[i] = {
          zeile: point.zeile,
          spalte: point.spalte,
          lat: point.lat,
          lng: point.lng,
          ergebnisse,
          target_rang: findTargetRang(ergebnisse, targetPlaceId),
          fehler: null,
        };
      } catch (err) {
        stats.fehler += 1;
        punkte[i] = {
          zeile: point.zeile,
          spalte: point.spalte,
          lat: point.lat,
          lng: point.lng,
          ergebnisse: [],
          target_rang: null,
          fehler: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, toCall.length) },
    () => worker(),
  );
  await Promise.all(workers);

  for (const point of skipped) {
    punkte.push({
      zeile: point.zeile,
      spalte: point.spalte,
      lat: point.lat,
      lng: point.lng,
      ergebnisse: [],
      target_rang: null,
      fehler: "uebersprungen: max_calls budget exhausted",
    });
  }

  return { punkte, stats };
}
