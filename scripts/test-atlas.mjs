import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseVendorRankings } from "./build-zone-top-vendors.mjs";
import {
  zoneColor,
  labelPoint,
  inPolygon,
  overlaps,
  weightedOnTime,
  zoneVolumeLabel,
  zoneOnTimeLabel,
  productionPeriodLabel,
} from "../public/atlas-utils.js";

test("pastel colors are stable, including ZIPs with leading zeroes", () => {
  assert.equal(zoneColor("010", "MA"), zoneColor(10, "MA"));
  assert.notEqual(zoneColor("430", "OH"), zoneColor("431", "OH"));
  assert.match(zoneColor("999", "AK"), /^#[a-f\d]{6}$/);
});

test("map volume labels distinguish a real zero from absent data", () => {
  assert.equal(zoneVolumeLabel({ hasZonePerformanceData: true, volume30Day: 1464 }), "1,464");
  assert.equal(zoneVolumeLabel({ hasZonePerformanceData: true, volume30Day: 0 }), "0");
  assert.equal(zoneVolumeLabel({ hasZonePerformanceData: false, volume30Day: 0 }), "N/D");
  assert.equal(zoneVolumeLabel({ hasZonePerformanceData: true, volume30Day: null }), "N/D");
});

test("map on-time comes from operational data, not opportunity score", () => {
  const zone = { hasZonePerformanceData: true, onTimePct: 83, hasMortgageData: true, mortgageOpportunityScore: 86.03 };
  assert.equal(zoneOnTimeLabel(zone), "83.0%");
  assert.equal(zoneOnTimeLabel({ hasZonePerformanceData: true, onTimePct: 0 }), "0.0%");
  assert.equal(zoneOnTimeLabel({ hasZonePerformanceData: true, onTimePct: null }), "N/D");
  assert.equal(zoneOnTimeLabel({ hasZonePerformanceData: false, onTimePct: 99 }), "N/D");
  assert.equal(zoneOnTimeLabel({ hasZonePerformanceData: true, onTimePct: 101 }), "N/D");
});

test("production date reflects the report window, not the import date or local timezone", () => {
  assert.equal(productionPeriodLabel({ periodStart: "2026-09-05", periodEnd: "2026-10-04", generatedAt: "2026-10-05T16:00:00Z" }), "Produção: 05/09 a 04/10/2026");
  assert.equal(productionPeriodLabel({ periodStart: "2025-12-15", periodEnd: "2026-01-13" }), "Produção: 15/12/2025 a 13/01/2026");
  assert.equal(productionPeriodLabel({ generatedAt: "2026-10-05T16:00:00Z" }), null);
});

test("labels stay inside concave polygons and outside holes", () => {
  const polygon = [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
      [4, 4],
    ],
  ];
  const point = labelPoint({ type: "Polygon", coordinates: polygon });
  assert(inPolygon([point.longitude, point.latitude], polygon));
  assert(!inPolygon([5, 5], polygon));
});

test("all 964 geographic zones have an interior label anchor", () => {
  const geo = JSON.parse(
    fs.readFileSync(
      new URL("../public/data/coverage_zip3.geojson", import.meta.url),
    ),
  );
  assert.equal(geo.features.length, 964);
  for (const feature of geo.features) {
    const point = labelPoint(feature.geometry);
    assert(point, feature.properties.zoneId);
    const polygons =
      feature.geometry.type === "MultiPolygon"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
    assert(
      polygons.some((p) => inPolygon([point.longitude, point.latitude], p)),
      feature.properties.zoneId,
    );
  }
});

test("label collision checks allow adjacent non-overlapping labels", () => {
  const a = { left: 0, right: 20, top: 0, bottom: 20 };
  assert(overlaps(a, { left: 10, right: 30, top: 10, bottom: 30 }));
  assert(!overlaps(a, { left: 20, right: 40, top: 0, bottom: 20 }));
});

test("on-time is weighted by reported volume, excluding missing observations", () => {
  assert.equal(
    weightedOnTime([
      { hasZonePerformanceData: true, volume30Day: 100, onTimePct: 90 },
      { hasZonePerformanceData: true, volume30Day: 300, onTimePct: 70 },
      { hasZonePerformanceData: true, volume30Day: 900, onTimePct: null },
      { hasZonePerformanceData: false, volume30Day: 100, onTimePct: 0 },
    ]),
    75,
  );
  assert.equal(weightedOnTime([]), null);
  assert.equal(
    weightedOnTime([
      { hasZonePerformanceData: true, volume30Day: 50, onTimePct: 0 },
    ]),
    0,
  );
});

test("operational data and pink coverage share a reporting window and contain only aggregate fields", () => {
  const read = (file) => JSON.parse(fs.readFileSync(new URL(`../public/data/${file}`, import.meta.url)));
  const performance = read("zone_performance_30day.json");
  const coverage = read("secret_focus_zones.json");
  const known = new Set(read("coverage_zip3_zones.json").map((z) => z.zoneId));
  const sum = (rows) => rows.reduce((s, z) => s + z.volume30Day, 0);
  const performanceKeys = ["zoneId", "state", "zip3", "volume30Day", "onTimePct", "volume30DayRank", "volume30DayStateRank", "volume30DayStateZoneCount", "topVendors"].sort();
  const coverageKeys = ["zoneId", "state", "zip3", "volume30Day", "onTimePct", "entryCount"].sort();
  for (const key of ["sourceFile", "periodStart", "periodEnd"]) {
    assert(performance.source[key]);
    assert.equal(performance.source[key], coverage.meta[key]);
  }
  assert.equal(performance.totals.zoneCount, performance.zones.length);
  assert.equal(new Set(performance.zones.map((z) => z.zoneId)).size, performance.zones.length);
  assert.equal(performance.totals.totalVolume30Day, sum(performance.zones));
  assert.equal(performance.totals.matchedZoneCount, performance.zones.filter((z) => known.has(z.zoneId)).length);
  assert.equal(performance.totals.reportedStateVolume30Day, performance.totals.totalVolume30Day + performance.totals.nonZip3Volume30Day + performance.totals.unlocatedVolume30Day);
  performance.zones.forEach((z, i) => {
    assert.deepEqual(Object.keys(z).sort(), performanceKeys);
    assert.equal(z.volume30DayRank, i + 1);
    assert(Number.isInteger(z.volume30Day) && z.volume30Day >= 0);
    assert(z.onTimePct == null || (z.onTimePct >= 0 && z.onTimePct <= 100));
    assert(Array.isArray(z.topVendors) && z.topVendors.length <= 3);
    assert(sum(z.topVendors) <= z.volume30Day);
    z.topVendors.forEach((v, index) => {
      assert.deepEqual(Object.keys(v).sort(), ["onTimePct", "rank", "volume30Day"]);
      assert.equal(v.rank, index + 1);
      assert(v.volume30Day > 0);
      assert(v.onTimePct == null || (v.onTimePct >= 0 && v.onTimePct <= 100));
      if (index) assert(z.topVendors[index - 1].volume30Day >= v.volume30Day);
    });
    if (i) assert(performance.zones[i - 1].volume30Day >= z.volume30Day);
  });
  assert.equal(coverage.meta.zoneCount, coverage.zones.length);
  assert.equal(new Set(coverage.zones.map((z) => z.zoneId)).size, coverage.zones.length);
  assert.equal(coverage.meta.totalVolume30Day, sum(coverage.zones));
  for (const z of coverage.zones) {
    assert.deepEqual(Object.keys(z).sort(), coverageKeys);
    assert(known.has(z.zoneId), z.zoneId);
    assert(z.volume30Day > 0);
    const total = performance.zones.find((p) => p.zoneId === z.zoneId);
    assert(total && total.volume30Day >= z.volume30Day, z.zoneId);
  }
});

test("top vendors use 30-day volume, anonymous ranks, and zone boundaries", () => {
  const row = (A, B, C, D = 100) => ({ row: 1, cells: { A, B, C, D } });
  const rows = [
    row("Estado / Zona / Vendor", "30 Day Vol", "OT% 30d"),
    row("OH", 260, 80), row("  OH Z431", 201, 80),
    row("      EXAMPLE-A", 100, 70), row("      EXAMPLE-B", 50, 80),
    row("      XX", 50, 0), row("      EXAMPLE-C", 1, 100),
    row("      EXAMPLE-ZERO", 0, null), row("  OH NO_ZONE", 59, 99),
    row("      EXAMPLE-NO-ZONE", 59, 99),
    row("NJ", 2, 50), row("  NJ Z070", 2, 50), row("      EXAMPLE-NEW  (novo)", 2, null),
    row("  NJ Z071", 0, null), row("      EXAMPLE-ZERO", 0, null),
    row("WV", 100, 80), row("  WV Z8", 100, 80), row("      EXAMPLE-NON-ZIP3", 100, 80),
  ];
  const result = parseVendorRankings(rows);
  assert.equal(result.size, 3);
  assert.deepEqual(result.get("OH-431").topVendors, [
    { rank: 1, volume30Day: 100, onTimePct: 70 },
    { rank: 2, volume30Day: 50, onTimePct: 80 },
    { rank: 3, volume30Day: 50, onTimePct: 0 },
  ]);
  assert.deepEqual(result.get("NJ-070").topVendors, [{ rank: 1, volume30Day: 2, onTimePct: null }]);
  assert.deepEqual(result.get("NJ-071").topVendors, []);
  assert(!JSON.stringify([...result]).includes("EXAMPLE"));
  assert.throws(() => parseVendorRankings(rows.map((r, i) => i === 2 ? row("  OH Z431", 999, 80) : r)), /Vendor total mismatch/);
  assert.throws(() => parseVendorRankings(rows.map((r, i) => i === 4 ? row("      EXAMPLE-A  (novo)", 50, 80) : r)), /Duplicate vendor/);
});
