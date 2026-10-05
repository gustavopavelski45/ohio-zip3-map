import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  zoneColor,
  labelPoint,
  inPolygon,
  overlaps,
  weightedOnTime,
} from "../public/atlas-utils.js";

test("pastel colors are stable, including ZIPs with leading zeroes", () => {
  assert.equal(zoneColor("010", "MA"), zoneColor(10, "MA"));
  assert.notEqual(zoneColor("430", "OH"), zoneColor("431", "OH"));
  assert.match(zoneColor("999", "AK"), /^#[a-f\d]{6}$/);
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
