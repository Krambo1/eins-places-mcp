/**
 * Unit tests for the places_nearby_grid sweep logic (src/grid.ts).
 * Run: npm test  (tsx --test, no network — searchFn is mocked throughout)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fold,
  offsetPoint,
  subdivide,
  passesNameGate,
  runGrid,
  type GridPoint,
  type GridSearchResult,
} from "./grid.js";

function place(
  id: string,
  name: string,
  extra: Partial<GridSearchResult> = {},
): GridSearchResult {
  return {
    place_id: id,
    name,
    formatted_address: `${name}str. 1, 50667 Köln`,
    types: extra.types ?? ["doctor"],
    primary_type: extra.primary_type ?? "doctor",
    business_status: extra.business_status,
  };
}

// ---------- geometry ----------

test("offsetPoint: 1000 m east at lat 50 ≈ +0.0140° lng, lat unchanged", () => {
  const { lat, lng } = offsetPoint(50, 7, 1000, 0);
  assert.equal(lat, 50);
  assert.ok(Math.abs(lng - 7.013974) < 0.0005, `lng was ${lng}`);
});

test("subdivide: 4 diagonal children, radius 0.72·r, all four quadrants", () => {
  const parent: GridPoint = { lat: 50.94, lng: 6.96, radius: 2000 };
  const kids = subdivide(parent);
  assert.equal(kids.length, 4);
  for (const k of kids) assert.equal(k.radius, 1440);
  const signs = new Set(
    kids.map(
      (k) =>
        `${Math.sign(k.lng - parent.lng)}${Math.sign(k.lat - parent.lat)}`,
    ),
  );
  assert.equal(signs.size, 4); // one child per quadrant
});

// ---------- name gate ----------

test("fold: lowercases and strips diacritics", () => {
  assert.equal(fold("Ästhetik KÖLN"), "asthetik koln");
});

test("passesNameGate: folded substring match (Ästhetik vs asthet)", () => {
  assert.ok(passesNameGate(place("a", "Praxis für Ästhetik"), ["asthet"], []));
  assert.ok(
    !passesNameGate(place("b", "Hausarztpraxis Dr. Meier"), ["asthet"], []),
  );
});

test("passesNameGate: gate-exempt primary_type bypasses tokens", () => {
  const p = place("c", "Studio Clara", { primary_type: "skin_care_clinic" });
  assert.ok(passesNameGate(p, ["asthet"], ["skin_care_clinic"]));
});

test("passesNameGate: gate-exempt type in the types ARRAY also bypasses", () => {
  const p = place("d", "Studio Clara", {
    primary_type: "doctor",
    types: ["doctor", "skin_care_clinic"],
  });
  assert.ok(passesNameGate(p, ["asthet"], ["skin_care_clinic"]));
});

test("passesNameGate: empty token list = gate off, everything passes", () => {
  assert.ok(passesNameGate(place("e", "Bäckerei Schmitz"), [], []));
});

// ---------- runGrid ----------

const P = (lat: number, lng: number, radius = 2000): GridPoint => ({
  lat,
  lng,
  radius,
});

test("runGrid: dedupes place_ids across overlapping circles", async () => {
  const byPoint = new Map<number, GridSearchResult[]>([
    [0, [place("x1", "Ästhetik A"), place("x2", "Ästhetik B")]],
    [1, [place("x2", "Ästhetik B"), place("x3", "Ästhetik C")]],
  ]);
  let call = 0;
  const { candidates, stats } = await runGrid({
    points: [P(50, 6), P(50.01, 6)],
    maxCalls: 10,
    minRadius: 250,
    nameGateTokens: [],
    gateExemptTypes: [],
    searchFn: async () => byPoint.get(call++) ?? [],
  });
  assert.deepEqual(
    candidates.map((c) => c.place_id),
    ["x1", "x2", "x3"],
  );
  assert.equal(stats.raw_found, 3);
  assert.equal(stats.calls_used, 2);
});

test("runGrid: a full page of 20 subdivides; children get queried after the seeds (FIFO)", async () => {
  const seen: number[] = [];
  const full = Array.from({ length: 20 }, (_, i) =>
    place(`s${i}`, `Ästhetik ${i}`),
  );
  const searchFn = async (p: GridPoint) => {
    seen.push(p.radius);
    return p.radius === 2000 ? full : []; // only the seed saturates
  };
  const { stats } = await runGrid({
    points: [P(50.9, 6.9, 2000), P(51.0, 7.0, 1000)],
    maxCalls: 10,
    minRadius: 250,
    nameGateTokens: [],
    gateExemptTypes: [],
    searchFn,
  });
  // seed 2000 (saturated), seed 1000, then 4 children at 1440
  assert.deepEqual(seen, [2000, 1000, 1440, 1440, 1440, 1440]);
  assert.equal(stats.saturated_subdivided, 1);
  assert.equal(stats.calls_used, 6);
  assert.equal(stats.budget_exhausted, false);
});

test("runGrid: no subdivision at or below minRadius", async () => {
  const full = Array.from({ length: 20 }, (_, i) => place(`m${i}`, `X ${i}`));
  const { stats } = await runGrid({
    points: [P(50.9, 6.9, 250)],
    maxCalls: 10,
    minRadius: 250,
    nameGateTokens: [],
    gateExemptTypes: [],
    searchFn: async () => full,
  });
  assert.equal(stats.calls_used, 1);
  assert.equal(stats.saturated_subdivided, 0);
});

test("runGrid: budget stops the sweep, remaining queue reported, searchFn never called past the cap", async () => {
  let calls = 0;
  const full = Array.from({ length: 20 }, (_, i) => place(`b${i}`, `X ${i}`));
  const { stats } = await runGrid({
    points: [P(50.9, 6.9, 4000)],
    maxCalls: 3,
    minRadius: 100,
    nameGateTokens: [],
    gateExemptTypes: [],
    searchFn: async () => {
      calls += 1;
      return full; // everything saturates: unbounded quadtree without the budget
    },
  });
  assert.equal(calls, 3);
  assert.equal(stats.calls_used, 3);
  assert.equal(stats.budget_exhausted, true);
  assert.ok(stats.saturated_unexplored > 0);
});

test("runGrid: CLOSED_PERMANENTLY dropped and counted, not gated", async () => {
  const { candidates, stats } = await runGrid({
    points: [P(50, 6)],
    maxCalls: 5,
    minRadius: 250,
    nameGateTokens: ["asthet"],
    gateExemptTypes: [],
    searchFn: async () => [
      place("c1", "Ästhetik Offen"),
      place("c2", "Ästhetik Zu", { business_status: "CLOSED_PERMANENTLY" }),
    ],
  });
  assert.deepEqual(
    candidates.map((c) => c.place_id),
    ["c1"],
  );
  assert.equal(stats.dropped_closed, 1);
  assert.equal(stats.dropped_by_name_gate, 0);
});

test("runGrid: name gate drops off-niche doctors and counts them", async () => {
  const { candidates, stats } = await runGrid({
    points: [P(50, 6)],
    maxCalls: 5,
    minRadius: 250,
    nameGateTokens: ["asthet", "botox"],
    gateExemptTypes: ["skin_care_clinic"],
    searchFn: async () => [
      place("g1", "Hausarztpraxis Dr. Meier"),
      place("g2", "Botox Boutique"),
      place("g3", "Kinderarztpraxis Sonnenschein"),
      place("g4", "Studio Haut", { primary_type: "skin_care_clinic" }),
    ],
  });
  assert.deepEqual(
    candidates.map((c) => c.place_id),
    ["g2", "g4"],
  );
  assert.equal(stats.dropped_by_name_gate, 2);
});

test("runGrid: candidate shape is exactly the union shape (no types array, no status)", async () => {
  const { candidates } = await runGrid({
    points: [P(50, 6)],
    maxCalls: 5,
    minRadius: 250,
    nameGateTokens: [],
    gateExemptTypes: [],
    searchFn: async () => [place("s1", "Ästhetik S")],
  });
  assert.deepEqual(Object.keys(candidates[0]).sort(), [
    "formatted_address",
    "name",
    "place_id",
    "primary_type",
  ]);
});
