/**
 * Unit tests for places_rank_grid (src/rank-grid.ts + buildRankGridPoints in
 * src/grid.ts). Run: npm test (tsx --test, no network — searchFn is mocked).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRankGridPoints, offsetPoint } from "./grid.js";
import {
  toRankedHits,
  findTargetRang,
  runRankGrid,
  type RankSearchResult,
  type RankGridPointInput,
} from "./rank-grid.js";

function hit(id: string, name = id): RankSearchResult {
  return { place_id: id, name, formatted_address: `${name}str. 1, Köln` };
}

// ---------- geometry ----------

test("buildRankGridPoints: 3x3 grid has the center point at (1,1) == the center coordinate", () => {
  const center = { lat: 50, lng: 7 };
  const points = buildRankGridPoints(center, 3, 1000);
  assert.equal(points.length, 9);
  const mid = points.find((p) => p.zeile === 1 && p.spalte === 1)!;
  assert.equal(mid.lat, center.lat);
  assert.equal(mid.lng, center.lng);
});

test("buildRankGridPoints: row 0 (north) has higher lat than row 2 (south), same column", () => {
  const points = buildRankGridPoints({ lat: 50, lng: 7 }, 3, 1000);
  const north = points.find((p) => p.zeile === 0 && p.spalte === 1)!;
  const south = points.find((p) => p.zeile === 2 && p.spalte === 1)!;
  assert.ok(north.lat > south.lat);
});

test("buildRankGridPoints: column 2 (east) has higher lng than column 0 (west), same row, matches offsetPoint", () => {
  const center = { lat: 50, lng: 7 };
  const points = buildRankGridPoints(center, 3, 1000);
  const east = points.find((p) => p.zeile === 1 && p.spalte === 2)!;
  const expected = offsetPoint(center.lat, center.lng, 1000, 0);
  assert.ok(Math.abs(east.lng - expected.lng) < 1e-9);
  assert.equal(east.lat, center.lat);
});

test("buildRankGridPoints: 5x5 grid produces 25 unique (zeile,spalte) pairs", () => {
  const points = buildRankGridPoints({ lat: 50, lng: 7 }, 5, 800);
  assert.equal(points.length, 25);
  const keys = new Set(points.map((p) => `${p.zeile},${p.spalte}`));
  assert.equal(keys.size, 25);
});

// ---------- rank mapping ----------

test("toRankedHits: rang is 1-based position, order preserved", () => {
  const hits = toRankedHits([hit("a"), hit("b"), hit("c")]);
  assert.deepEqual(
    hits.map((h) => [h.rang, h.place_id]),
    [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ],
  );
});

test("findTargetRang: finds the target's rang among ranked hits", () => {
  const hits = toRankedHits([hit("a"), hit("b"), hit("c")]);
  assert.equal(findTargetRang(hits, "b"), 2);
});

test("findTargetRang: null when target not present", () => {
  const hits = toRankedHits([hit("a"), hit("b")]);
  assert.equal(findTargetRang(hits, "zzz"), null);
});

test("findTargetRang: null when no target_place_id given", () => {
  const hits = toRankedHits([hit("a")]);
  assert.equal(findTargetRang(hits, null), null);
});

// ---------- runRankGrid ----------

const PT = (zeile: number, spalte: number): RankGridPointInput => ({
  zeile,
  spalte,
  lat: 50 + zeile,
  lng: 7 + spalte,
});

test("runRankGrid: happy path fills ergebnisse + target_rang per point", async () => {
  const points = [PT(0, 0), PT(0, 1)];
  const byKey = new Map<string, RankSearchResult[]>([
    ["0,0", [hit("t"), hit("other")]],
    ["0,1", [hit("other")]],
  ]);
  const { punkte, stats } = await runRankGrid({
    points,
    maxCalls: 10,
    targetPlaceId: "t",
    concurrency: 5,
    searchFn: async (p) => byKey.get(`${p.zeile},${p.spalte}`) ?? [],
  });
  assert.equal(punkte.length, 2);
  const p00 = punkte.find((p) => p.zeile === 0 && p.spalte === 0)!;
  const p01 = punkte.find((p) => p.zeile === 0 && p.spalte === 1)!;
  assert.equal(p00.target_rang, 1);
  assert.equal(p01.target_rang, null);
  assert.equal(p00.fehler, null);
  assert.equal(stats.calls, 2);
  assert.equal(stats.fehler, 0);
  assert.equal(stats.uebersprungen, 0);
  assert.equal(stats.sku, "Text Search Pro");
});

test("runRankGrid: a failed point gets fehler set and does not fail the others", async () => {
  const points = [PT(0, 0), PT(0, 1)];
  const { punkte, stats } = await runRankGrid({
    points,
    maxCalls: 10,
    targetPlaceId: null,
    concurrency: 5,
    searchFn: async (p) => {
      if (p.spalte === 0) throw new Error("boom");
      return [hit("ok")];
    },
  });
  const failed = punkte.find((p) => p.spalte === 0)!;
  const ok = punkte.find((p) => p.spalte === 1)!;
  assert.equal(failed.fehler, "boom");
  assert.deepEqual(failed.ergebnisse, []);
  assert.equal(ok.fehler, null);
  assert.equal(ok.ergebnisse.length, 1);
  assert.equal(stats.fehler, 1);
  assert.equal(stats.calls, 2);
});

test("runRankGrid: points beyond max_calls are skipped, not called, and reported", async () => {
  const points = [PT(0, 0), PT(0, 1), PT(0, 2)];
  let calls = 0;
  const { punkte, stats } = await runRankGrid({
    points,
    maxCalls: 1,
    targetPlaceId: null,
    concurrency: 5,
    searchFn: async () => {
      calls += 1;
      return [hit("x")];
    },
  });
  assert.equal(calls, 1);
  assert.equal(stats.calls, 1);
  assert.equal(stats.uebersprungen, 2);
  assert.equal(punkte.length, 3);
  const skipped = punkte.filter((p) => p.fehler !== null);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((p) => p.fehler!.includes("uebersprungen")));
});

test("runRankGrid: respects concurrency budget (never more than N in flight)", async () => {
  const points = Array.from({ length: 6 }, (_, i) => PT(0, i));
  let inFlight = 0;
  let maxInFlight = 0;
  const { stats } = await runRankGrid({
    points,
    maxCalls: 10,
    targetPlaceId: null,
    concurrency: 2,
    searchFn: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [];
    },
  });
  assert.equal(stats.calls, 6);
  assert.ok(maxInFlight <= 2, `maxInFlight was ${maxInFlight}`);
});
