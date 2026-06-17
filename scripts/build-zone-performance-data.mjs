import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OUTPUT_FILE = "zone_performance_30day.json";

function parseNumber(value) {
  const normalized = String(value || "")
    .trim()
    .replaceAll(".", "")
    .replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseZoneRows(rawText) {
  const zones = [];

  for (const line of rawText.split(/\r?\n/)) {
    const columns = line.trim().split(/\t+/);
    if (columns.length < 3) {
      continue;
    }

    const match = columns[0].trim().match(/^([A-Z]{2})\s+Z?(\d{3})$/);
    if (!match) {
      continue;
    }

    const volume30Day = parseNumber(columns[1]);
    const onTimePct = parseNumber(columns[2]);
    if (!Number.isFinite(volume30Day) || !Number.isFinite(onTimePct)) {
      continue;
    }

    const state = match[1];
    const zip3 = match[2];
    zones.push({
      zoneId: `${state}-${zip3}`,
      state,
      zip3,
      volume30Day: Math.round(volume30Day),
      onTimePct: Number(onTimePct.toFixed(1))
    });
  }

  return zones;
}

function applyRankings(zones) {
  zones.sort((a, b) => b.volume30Day - a.volume30Day || a.zoneId.localeCompare(b.zoneId));
  zones.forEach((zone, index) => {
    zone.volume30DayRank = index + 1;
  });

  const byState = new Map();
  for (const zone of zones) {
    if (!byState.has(zone.state)) {
      byState.set(zone.state, []);
    }
    byState.get(zone.state).push(zone);
  }

  for (const stateZones of byState.values()) {
    stateZones.sort((a, b) => b.volume30Day - a.volume30Day || a.zoneId.localeCompare(b.zoneId));
    stateZones.forEach((zone, index) => {
      zone.volume30DayStateRank = index + 1;
      zone.volume30DayStateZoneCount = stateZones.length;
    });
  }
}

function weightedOnTimePct(zones) {
  const volume = zones.reduce((sum, zone) => sum + zone.volume30Day, 0);
  if (volume <= 0) {
    return null;
  }

  const weighted = zones.reduce((sum, zone) => sum + zone.volume30Day * zone.onTimePct, 0);
  return Number((weighted / volume).toFixed(1));
}

async function loadCoverageZoneIds(projectRoot) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, "public", "data", "coverage_zip3_zones.json"), "utf-8");
    const zones = JSON.parse(raw);
    if (!Array.isArray(zones)) {
      return new Set();
    }
    return new Set(zones.map((zone) => zone.zoneId).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function main() {
  const inputFile = process.argv[2] || process.env.ZONE_PERFORMANCE_INPUT;
  if (!inputFile) {
    throw new Error("Usage: npm run prepare-zone-performance-data -- /path/to/source.txt");
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, "..");
  const outputFile = process.env.ZONE_PERFORMANCE_OUTPUT || DEFAULT_OUTPUT_FILE;
  const outputPath = path.join(projectRoot, "public", "data", outputFile);
  const rawText = await fs.readFile(inputFile, "utf-8");
  const coverageZoneIds = await loadCoverageZoneIds(projectRoot);
  const zones = parseZoneRows(rawText);

  applyRankings(zones);

  const unmatchedZoneIds = coverageZoneIds.size > 0
    ? zones.map((zone) => zone.zoneId).filter((zoneId) => !coverageZoneIds.has(zoneId))
    : [];
  const matchedZoneCount = coverageZoneIds.size > 0 ? zones.length - unmatchedZoneIds.length : null;

  const payload = {
    source: {
      reportWindow: "30 Day",
      generatedAt: new Date().toISOString()
    },
    totals: {
      zoneCount: zones.length,
      matchedZoneCount,
      unmatchedZoneIds,
      totalVolume30Day: zones.reduce((sum, zone) => sum + zone.volume30Day, 0),
      weightedOnTimePct: weightedOnTimePct(zones)
    },
    zones
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(payload));

  console.log(`Saved ${outputFile}`);
  console.log(`Zones: ${zones.length.toLocaleString("en-US")}`);
  if (matchedZoneCount !== null) {
    console.log(`Matched map zones: ${matchedZoneCount.toLocaleString("en-US")}`);
    console.log(`Unmatched zones: ${unmatchedZoneIds.length.toLocaleString("en-US")}`);
  }
  console.log(`30 day volume: ${payload.totals.totalVolume30Day.toLocaleString("en-US")}`);
  console.log(`Weighted OT%: ${payload.totals.weightedOnTimePct ?? "N/D"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
