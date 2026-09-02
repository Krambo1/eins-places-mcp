/**
 * Grid sweep logic for places_nearby_grid (v0.2.0, Outreach v3 Step 4).
 *
 * Pure + deterministic: the Google call is injected as `searchFn`, so this
 * module is unit-testable without network. The tool wrapper in
 * tools/places-nearby-grid.ts supplies the real Nearby Search client.
 *
 * Why a server-side loop: Nearby Search returns AT MOST 20 results per call
 * with no pagination. Exhausting a city therefore means many small circles,
 * and a circle that returns exactly 20 is SATURATED (there is more underneath).
 * Running that loop here — instead of in an LLM worker — keeps it cheap,
 * bounded (maxCalls), and byte-exact reproducible.
 *
 * Saturation handling: a saturated circle is subdivided into 4 child circles
 * at diagonal offsets (±r/2, ±r/2) with radius 0.72·r (0.72 > 1/√2, so the 4
 * children fully cover the parent disk). Children re-enter the FIFO queue.
 * The recursion is bounded by `minRadius` and the `maxCalls` budget.
 *
 * Name gate: the caller passes niche vocabulary (`nameGateTokens`); a result
 * survives if its folded name contains any token, OR its primaryType/types
 * intersect `gateExemptTypes`. The gate exists because broad includedTypes
 * ("doctor") would otherwise flood the client with off-niche businesses. An
 * EMPTY token list means "no gate" — everything passes.
 */

export interface GridPoint {
  lat: number;
  lng: number;
  radius: number; // meters
}

export interface GridSearchResult {
  place_id: string;
  name: string;
  formatted_address: string;
  types: string[];
  primary_type?: string;
  business_status?: string;
}

export interface GridCandidate {
  place_id: string;
  name: string;
  formatted_address: string;
  primary_type?: string;
}

export interface GridStats {
  points_requested: number;
  calls_used: number;
  saturated_subdivided: number;
  saturated_unexplored: number; // queue entries left when the budget ran out
  raw_found: number; // unique place_ids before gating
  dropped_by_name_gate: number;
  dropped_closed: number; // CLOSED_PERMANENTLY
  budget_exhausted: boolean;
}

export interface RunGridOptions {
  points: GridPoint[];
  maxCalls: number;
  minRadius: number; // do not subdivide below this radius (meters)
  nameGateTokens: string[]; // empty = gate off
  gateExemptTypes: string[]; // primaryType/types that bypass the name gate
  searchFn: (point: GridPoint) => Promise<GridSearchResult[]>;
}

export interface RunGridResult {
  candidates: GridCandidate[];
  stats: GridStats;
}

const SATURATION_COUNT = 20; // Nearby Search hard cap per call
const CHILD_RADIUS_FACTOR = 0.72; // > 1/sqrt(2): 4 diagonal children cover the parent
const METERS_PER_DEG_LAT = 111_320;

/** Lowercase + strip combining diacritics (ä→a). Same folding the Outreach skill uses. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Offset a lat/lng by meters. Flat-earth approximation, fine at city scale. */
export function offsetPoint(
  lat: number,
  lng: number,
  dxMeters: number,
  dyMeters: number,
): { lat: number; lng: number } {
  const dLat = dyMeters / METERS_PER_DEG_LAT;
  const dLng =
    dxMeters / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

/** The 4 diagonal child circles of a saturated parent. */
export function subdivide(parent: GridPoint): GridPoint[] {
  const d = parent.radius / 2;
  const childRadius = Math.round(parent.radius * CHILD_RADIUS_FACTOR);
  const offsets: Array<[number, number]> = [
    [d, d],
    [d, -d],
    [-d, d],
    [-d, -d],
  ];
  return offsets.map(([dx, dy]) => {
    const { lat, lng } = offsetPoint(parent.lat, parent.lng, dx, dy);
    return { lat, lng, radius: childRadius };
  });
}

/** true = passes the gate (kept). */
export function passesNameGate(
  result: GridSearchResult,
  foldedTokens: string[],
  gateExemptTypes: string[],
): boolean {
  if (foldedTokens.length === 0) return true;
  const typeSet = new Set([
    ...(result.types ?? []),
    ...(result.primary_type ? [result.primary_type] : []),
  ]);
  if (gateExemptTypes.some((t) => typeSet.has(t))) return true;
  const name = fold(result.name);
  return foldedTokens.some((t) => name.includes(t));
}

export async function runGrid(opts: RunGridOptions): Promise<RunGridResult> {
  const {
    points,
    maxCalls,
    minRadius,
    nameGateTokens,
    gateExemptTypes,
    searchFn,
  } = opts;

  const foldedTokens = nameGateTokens.map(fold).filter((t) => t.length > 0);
  const queue: GridPoint[] = [...points]; // FIFO: all seed points first, subdivisions after
  const seen = new Set<string>();
  const candidates: GridCandidate[] = [];
  const stats: GridStats = {
    points_requested: points.length,
    calls_used: 0,
    saturated_subdivided: 0,
    saturated_unexplored: 0,
    raw_found: 0,
    dropped_by_name_gate: 0,
    dropped_closed: 0,
    budget_exhausted: false,
  };

  while (queue.length > 0) {
    if (stats.calls_used >= maxCalls) {
      stats.budget_exhausted = true;
      stats.saturated_unexplored = queue.length;
      break;
    }
    const point = queue.shift()!;
    stats.calls_used += 1;
    const results = await searchFn(point);

    for (const r of results) {
      if (seen.has(r.place_id)) continue;
      seen.add(r.place_id);
      stats.raw_found += 1;
      if (r.business_status === "CLOSED_PERMANENTLY") {
        stats.dropped_closed += 1;
        continue;
      }
      if (!passesNameGate(r, foldedTokens, gateExemptTypes)) {
        stats.dropped_by_name_gate += 1;
        continue;
      }
      candidates.push({
        place_id: r.place_id,
        name: r.name,
        formatted_address: r.formatted_address,
        primary_type: r.primary_type,
      });
    }

    if (results.length >= SATURATION_COUNT && point.radius > minRadius) {
      stats.saturated_subdivided += 1;
      queue.push(...subdivide(point));
    }
  }

  return { candidates, stats };
}
