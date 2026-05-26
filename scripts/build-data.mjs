import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { lookupZip } = require("zipcode-detail-lookup");
const union = require("@turf/union").default;
const simplify = require("@turf/simplify").default;
const { featureCollection } = require("@turf/helpers");

const COORD_PRECISION = 5;
const SIMPLIFY_TOLERANCE = 0.0012;
const HOUSEHOLD_SIZE_ESTIMATE = 2.6;
const HOTSPOT_RATIO = 0.15;
const HMDA_YEAR = Number.parseInt(process.env.HMDA_YEAR || "2024", 10);
const HMDA_FILE_NAME = `hmda_county_${HMDA_YEAR}.json`;

const SOURCE_BASE_URL =
  "https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master";
const SOURCE_INDEX_URL =
  "https://api.github.com/repos/OpenDataDE/State-zip-code-GeoJSON/contents";

const SOURCE_EXCLUDED_CODES = new Set(["DC"]);

function titleCaseWord(word) {
  if (word === "of") {
    return "of";
  }

  if (word.length === 0) {
    return word;
  }

  return `${word[0].toUpperCase()}${word.slice(1)}`;
}

function parseStateSourceFile(fileName) {
  const match = /^([a-z]{2})_(.+)_zip_codes_geo\.min\.json$/.exec(fileName);
  if (!match) {
    return null;
  }

  const state = match[1].toUpperCase();
  if (SOURCE_EXCLUDED_CODES.has(state)) {
    return null;
  }

  const slug = match[2];
  const stateName = slug
    .split("_")
    .map((entry) => titleCaseWord(entry))
    .join(" ");

  return { state, stateName, file: fileName };
}

async function loadTargetStates() {
  const response = await fetch(SOURCE_INDEX_URL, {
    headers: {
      "User-Agent": "pavelski-zope-map-builder"
    }
  });

  if (!response.ok) {
    throw new Error(`Could not load state catalog (${response.status})`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Unexpected state catalog format.");
  }

  const states = payload
    .map((entry) => parseStateSourceFile(String(entry?.name || "")))
    .filter(Boolean)
    .sort((a, b) => a.state.localeCompare(b.state));

  if (states.length !== 50) {
    throw new Error(`Expected 50 states but found ${states.length} in source catalog.`);
  }

  return states;
}

function toNumber(value) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundCoord(value) {
  return Number(value.toFixed(COORD_PRECISION));
}

function cloneGeometry(geometry) {
  if (typeof structuredClone === "function") {
    return structuredClone(geometry);
  }

  return JSON.parse(JSON.stringify(geometry));
}

function normalizeCoordinates(coordinates) {
  if (!Array.isArray(coordinates)) {
    return coordinates;
  }

  if (coordinates.length > 0 && typeof coordinates[0] === "number") {
    return coordinates.map((value, index) => {
      if (index < 2 && Number.isFinite(value)) {
        return roundCoord(value);
      }

      return value;
    });
  }

  return coordinates.map((entry) => normalizeCoordinates(entry));
}

function normalizeGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return geometry;
  }

  if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    return {
      type: "GeometryCollection",
      geometries: geometry.geometries.map((entry) => normalizeGeometry(entry))
    };
  }

  if (!("coordinates" in geometry)) {
    return geometry;
  }

  return {
    type: geometry.type,
    coordinates: normalizeCoordinates(geometry.coordinates)
  };
}

function simplifyGeometry(geometry) {
  try {
    const feature = {
      type: "Feature",
      properties: {},
      geometry
    };

    const simplified = simplify(feature, {
      tolerance: SIMPLIFY_TOLERANCE,
      highQuality: false,
      mutate: false
    });

    if (simplified && simplified.geometry) {
      return simplified.geometry;
    }
  } catch {
    // Keep original geometry when simplification fails.
  }

  return geometry;
}

function extractPolygonGeometries(geometry) {
  if (!geometry || typeof geometry !== "object") {
    return [];
  }

  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
    return [geometry];
  }

  if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    return geometry.geometries.flatMap((entry) => extractPolygonGeometries(entry));
  }

  return [];
}

function normalizeCountyFips(value) {
  const digits = String(value || "").replaceAll(/\D/g, "");
  if (digits.length === 5) {
    return digits;
  }

  if (digits.length === 4) {
    return `0${digits}`;
  }

  return null;
}

function parseCountyWeights(lookup) {
  if (!lookup || typeof lookup !== "object") {
    return [];
  }

  const fromWeights = [];

  if (typeof lookup.county_weights === "string" && lookup.county_weights.trim()) {
    try {
      const parsed = JSON.parse(lookup.county_weights);
      for (const [rawFips, rawWeight] of Object.entries(parsed)) {
        const countyFips = normalizeCountyFips(rawFips);
        const weight = Number.parseFloat(String(rawWeight));
        if (!countyFips || !Number.isFinite(weight) || weight <= 0) {
          continue;
        }

        fromWeights.push([countyFips, weight]);
      }
    } catch {
      // Fallback handlers below.
    }
  }

  if (fromWeights.length > 0) {
    return fromWeights;
  }

  const fallbackFips = String(lookup.county_fips_all || lookup.county_fips || "")
    .split(/[;,\s]+/)
    .map((entry) => normalizeCountyFips(entry))
    .filter(Boolean);

  if (fallbackFips.length === 0) {
    return [];
  }

  return fallbackFips.map((countyFips) => [countyFips, 1]);
}

function createZone(zoneId, state, stateName, zip3) {
  return {
    zoneId,
    state,
    stateName,
    zip3,
    zips: new Set(),
    cities: new Set(),
    topZip5: null,
    topZipCity: null,
    topZipPopulation: 0,
    housingUnitsEstimate: 0,
    topHousingZip5: null,
    topHousingCity: null,
    topHousingUnitsEstimate: 0,
    countyPopulationByFips: new Map(),
    latSum: 0,
    lngSum: 0,
    pointCount: 0,
    population: 0,
    geometryFeatures: []
  };
}

function createCity(state, city, stateName) {
  return {
    key: `${state}|${city}`,
    state,
    stateName,
    city,
    zoneIds: new Set(),
    zip3s: new Set(),
    latSum: 0,
    lngSum: 0,
    pointCount: 0,
    zipCount: 0,
    population: 0
  };
}

function includeCountyWeights(zone, lookup, population) {
  const countyWeights = parseCountyWeights(lookup);
  if (countyWeights.length === 0) {
    return;
  }

  const totalWeight = countyWeights.reduce((sum, [, weight]) => sum + weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return;
  }

  const basePopulation = population > 0 ? population : 1;

  for (const [countyFips, weight] of countyWeights) {
    const contribution = basePopulation * (weight / totalWeight);
    zone.countyPopulationByFips.set(
      countyFips,
      (zone.countyPopulationByFips.get(countyFips) || 0) + contribution
    );
  }
}

function includePoint(target, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return;
  }

  target.latSum += lat;
  target.lngSum += lng;
  target.pointCount += 1;
}

function average(sum, count) {
  if (count === 0) {
    return null;
  }

  return Number((sum / count).toFixed(6));
}

function fallbackSquare(longitude, latitude) {
  const delta = 0.08;
  const lon = Number.isFinite(longitude) ? longitude : -83;
  const lat = Number.isFinite(latitude) ? latitude : 40;

  return {
    type: "Polygon",
    coordinates: [[
      [roundCoord(lon - delta), roundCoord(lat - delta)],
      [roundCoord(lon + delta), roundCoord(lat - delta)],
      [roundCoord(lon + delta), roundCoord(lat + delta)],
      [roundCoord(lon - delta), roundCoord(lat + delta)],
      [roundCoord(lon - delta), roundCoord(lat - delta)]
    ]]
  };
}

function dissolveZoneGeometry(zone) {
  if (zone.geometryFeatures.length === 0) {
    return fallbackSquare(average(zone.lngSum, zone.pointCount), average(zone.latSum, zone.pointCount));
  }

  if (zone.geometryFeatures.length === 1) {
    return normalizeGeometry(simplifyGeometry(zone.geometryFeatures[0].geometry));
  }

  try {
    const dissolved = union(featureCollection(zone.geometryFeatures));
    if (dissolved && dissolved.geometry) {
      return normalizeGeometry(simplifyGeometry(dissolved.geometry));
    }
  } catch (error) {
    console.warn(`Zone ${zone.zoneId}: bulk dissolve failed (${error.message}). Retrying incrementally.`);
  }

  let merged = zone.geometryFeatures[0];

  for (let index = 1; index < zone.geometryFeatures.length; index += 1) {
    const nextFeature = zone.geometryFeatures[index];

    try {
      const candidate = union(featureCollection([merged, nextFeature]));
      if (candidate && candidate.geometry) {
        merged = {
          type: "Feature",
          properties: {},
          geometry: candidate.geometry
        };
      }
    } catch {
      // Ignore one-off invalid geometry and keep merging the rest.
    }
  }

  if (merged && merged.geometry) {
    return normalizeGeometry(simplifyGeometry(merged.geometry));
  }

  return fallbackSquare(average(zone.lngSum, zone.pointCount), average(zone.latSum, zone.pointCount));
}

async function downloadStateGeojson(file) {
  const url = `${SOURCE_BASE_URL}/${file}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Could not download source GeoJSON (${file}): ${response.status}`);
  }

  const payload = await response.json();
  if (!payload || payload.type !== "FeatureCollection") {
    throw new Error(`Unexpected source format (${file}). Expected FeatureCollection.`);
  }

  return payload;
}

function emptyMortgageMetrics() {
  return {
    mortgageOriginationsCount: 0,
    mortgageOriginationsAmount: 0,
    mortgagePurchaseCount: 0,
    mortgagePurchaseAmount: 0,
    mortgageOwnerOccupiedCount: 0,
    mortgageOwnerOccupiedAmount: 0,
    mortgageAmountPerResident: 0,
    mortgageLoansPer10kResidents: 0,
    mortgageOpportunityScore: null,
    mortgageVolumeRank: null,
    mortgageStateRank: null,
    mortgageStateZoneCount: null,
    isMortgageHotspot: false,
    mortgageOpportunityRank: null,
    mortgageOpportunityStateRank: null,
    isMortgageOpportunityHotspot: false
  };
}

async function loadHmdaCountyMap(outputDir) {
  const filePath = path.join(outputDir, HMDA_FILE_NAME);

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const payload = JSON.parse(raw);

    if (!Array.isArray(payload?.counties)) {
      return {
        hasMortgageData: false,
        year: HMDA_YEAR,
        countyMap: new Map(),
        totals: null
      };
    }

    const countyMap = new Map();
    for (const county of payload.counties) {
      const countyFips = normalizeCountyFips(county?.countyFips);
      if (!countyFips) {
        continue;
      }

      countyMap.set(countyFips, {
        countyFips,
        state: String(county?.state || "").trim().toUpperCase(),
        originatedCount: Math.max(0, Number.parseFloat(String(county?.originatedCount || 0)) || 0),
        originatedAmount: Math.max(0, Number.parseFloat(String(county?.originatedAmount || 0)) || 0),
        purchaseCount: Math.max(0, Number.parseFloat(String(county?.purchaseCount || 0)) || 0),
        purchaseAmount: Math.max(0, Number.parseFloat(String(county?.purchaseAmount || 0)) || 0),
        ownerOccupiedCount: Math.max(0, Number.parseFloat(String(county?.ownerOccupiedCount || 0)) || 0),
        ownerOccupiedAmount: Math.max(0, Number.parseFloat(String(county?.ownerOccupiedAmount || 0)) || 0)
      });
    }

    return {
      hasMortgageData: countyMap.size > 0,
      year: Number.parseInt(String(payload?.year || HMDA_YEAR), 10) || HMDA_YEAR,
      countyMap,
      totals: payload?.totals || null
    };
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.warn(`Could not parse ${HMDA_FILE_NAME}: ${error.message}`);
    }

    return {
      hasMortgageData: false,
      year: HMDA_YEAR,
      countyMap: new Map(),
      totals: null
    };
  }
}

function allocateCountyMortgageToZones(zones, countyMap) {
  if (countyMap.size === 0) {
    for (const zone of zones) {
      Object.assign(zone, emptyMortgageMetrics());
    }
    return;
  }

  const countyWeightTotals = new Map();

  for (const zone of zones) {
    for (const [countyFips, contribution] of zone.countyPopulationByFips.entries()) {
      if (!countyMap.has(countyFips) || !Number.isFinite(contribution) || contribution <= 0) {
        continue;
      }

      countyWeightTotals.set(countyFips, (countyWeightTotals.get(countyFips) || 0) + contribution);
    }
  }

  for (const zone of zones) {
    let mortgageOriginationsCount = 0;
    let mortgageOriginationsAmount = 0;
    let mortgagePurchaseCount = 0;
    let mortgagePurchaseAmount = 0;
    let mortgageOwnerOccupiedCount = 0;
    let mortgageOwnerOccupiedAmount = 0;

    for (const [countyFips, contribution] of zone.countyPopulationByFips.entries()) {
      const county = countyMap.get(countyFips);
      const totalContribution = countyWeightTotals.get(countyFips);

      if (!county || !Number.isFinite(totalContribution) || totalContribution <= 0) {
        continue;
      }

      const share = contribution / totalContribution;
      mortgageOriginationsCount += county.originatedCount * share;
      mortgageOriginationsAmount += county.originatedAmount * share;
      mortgagePurchaseCount += county.purchaseCount * share;
      mortgagePurchaseAmount += county.purchaseAmount * share;
      mortgageOwnerOccupiedCount += county.ownerOccupiedCount * share;
      mortgageOwnerOccupiedAmount += county.ownerOccupiedAmount * share;
    }

    const mortgageAmountPerResident =
      zone.population > 0 ? mortgageOriginationsAmount / zone.population : 0;
    const mortgageLoansPer10kResidents =
      zone.population > 0 ? (mortgageOriginationsCount * 10000) / zone.population : 0;

    Object.assign(zone, {
      mortgageOriginationsCount: Math.round(mortgageOriginationsCount),
      mortgageOriginationsAmount: Math.round(mortgageOriginationsAmount),
      mortgagePurchaseCount: Math.round(mortgagePurchaseCount),
      mortgagePurchaseAmount: Math.round(mortgagePurchaseAmount),
      mortgageOwnerOccupiedCount: Math.round(mortgageOwnerOccupiedCount),
      mortgageOwnerOccupiedAmount: Math.round(mortgageOwnerOccupiedAmount),
      mortgageAmountPerResident: Math.round(mortgageAmountPerResident),
      mortgageLoansPer10kResidents: Number(mortgageLoansPer10kResidents.toFixed(1)),
      mortgageOpportunityScore: null,
      mortgageVolumeRank: null,
      mortgageStateRank: null,
      mortgageStateZoneCount: null,
      isMortgageHotspot: false,
      mortgageOpportunityRank: null,
      mortgageOpportunityStateRank: null,
      isMortgageOpportunityHotspot: false
    });
  }
}

function logNormalized(value, maxValue) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(maxValue) || maxValue <= 0) {
    return 0;
  }

  return Math.log1p(value) / Math.log1p(maxValue);
}

function applyMortgageRankings(zones) {
  if (zones.length === 0) {
    return;
  }

  const rankedByVolume = zones
    .slice()
    .sort(
      (a, b) =>
        b.mortgageOriginationsCount - a.mortgageOriginationsCount ||
        b.mortgageOriginationsAmount - a.mortgageOriginationsAmount ||
        a.label.localeCompare(b.label)
    );

  const mortgageHotspotCount = Math.max(1, Math.ceil(rankedByVolume.length * HOTSPOT_RATIO));
  const mortgageHotspotSet = new Set(rankedByVolume.slice(0, mortgageHotspotCount).map((zone) => zone.zoneId));

  rankedByVolume.forEach((zone, index) => {
    zone.mortgageVolumeRank = index + 1;
    zone.isMortgageHotspot = mortgageHotspotSet.has(zone.zoneId);
  });

  const volumeByState = new Map();
  for (const zone of rankedByVolume) {
    if (!volumeByState.has(zone.state)) {
      volumeByState.set(zone.state, []);
    }

    volumeByState.get(zone.state).push(zone);
  }

  for (const zonesInState of volumeByState.values()) {
    zonesInState.sort(
      (a, b) =>
        b.mortgageOriginationsCount - a.mortgageOriginationsCount ||
        b.mortgageOriginationsAmount - a.mortgageOriginationsAmount ||
        a.label.localeCompare(b.label)
    );

    const stateZoneCount = zonesInState.length;
    zonesInState.forEach((zone, index) => {
      zone.mortgageStateRank = index + 1;
      zone.mortgageStateZoneCount = stateZoneCount;
    });
  }

  const maxCount = Math.max(...zones.map((zone) => zone.mortgageOriginationsCount), 1);
  const maxAmount = Math.max(...zones.map((zone) => zone.mortgageOriginationsAmount), 1);
  const maxAmountPerResident = Math.max(...zones.map((zone) => zone.mortgageAmountPerResident), 1);

  for (const zone of zones) {
    const ownerOccupiedMix =
      zone.mortgageOriginationsCount > 0
        ? zone.mortgageOwnerOccupiedCount / zone.mortgageOriginationsCount
        : 0;
    const purchaseMix =
      zone.mortgageOriginationsCount > 0
        ? zone.mortgagePurchaseCount / zone.mortgageOriginationsCount
        : 0;

    const scoreRaw =
      logNormalized(zone.mortgageOriginationsCount, maxCount) * 0.45 +
      logNormalized(zone.mortgageOriginationsAmount, maxAmount) * 0.3 +
      logNormalized(zone.mortgageAmountPerResident, maxAmountPerResident) * 0.15 +
      ownerOccupiedMix * 0.05 +
      purchaseMix * 0.05;

    zone.mortgageOpportunityScore = Number((scoreRaw * 100).toFixed(2));
  }

  const rankedByOpportunity = zones
    .slice()
    .sort(
      (a, b) =>
        b.mortgageOpportunityScore - a.mortgageOpportunityScore ||
        b.mortgageOriginationsCount - a.mortgageOriginationsCount ||
        a.label.localeCompare(b.label)
    );

  const opportunityHotspotCount = Math.max(1, Math.ceil(rankedByOpportunity.length * HOTSPOT_RATIO));
  const opportunityHotspotSet = new Set(
    rankedByOpportunity.slice(0, opportunityHotspotCount).map((zone) => zone.zoneId)
  );

  rankedByOpportunity.forEach((zone, index) => {
    zone.mortgageOpportunityRank = index + 1;
    zone.isMortgageOpportunityHotspot = opportunityHotspotSet.has(zone.zoneId);
  });

  const opportunityByState = new Map();
  for (const zone of rankedByOpportunity) {
    if (!opportunityByState.has(zone.state)) {
      opportunityByState.set(zone.state, []);
    }

    opportunityByState.get(zone.state).push(zone);
  }

  for (const zonesInState of opportunityByState.values()) {
    zonesInState.sort(
      (a, b) =>
        b.mortgageOpportunityScore - a.mortgageOpportunityScore ||
        b.mortgageOriginationsCount - a.mortgageOriginationsCount ||
        a.label.localeCompare(b.label)
    );

    zonesInState.forEach((zone, index) => {
      zone.mortgageOpportunityStateRank = index + 1;
    });
  }
}

function assignFallbackMortgageFields(zones) {
  for (const zone of zones) {
    Object.assign(zone, emptyMortgageMetrics());
  }
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, "..");
  const outputDir = path.join(projectRoot, "public", "data");
  const targetStates = await loadTargetStates();
  console.log(`Loaded ${targetStates.length} states from source catalog.`);

  const hmda = await loadHmdaCountyMap(outputDir);
  if (hmda.hasMortgageData) {
    console.log(`Loaded HMDA county file ${HMDA_FILE_NAME} with ${hmda.countyMap.size} counties.`);
  } else {
    console.log(`HMDA county file ${HMDA_FILE_NAME} not found. Mortgage metrics will be unavailable.`);
  }

  const zones = [];
  const cityMap = new Map();
  const stateStats = new Map();

  for (const stateConfig of targetStates) {
    const { state, stateName, file } = stateConfig;
    console.log(`Downloading ${state} ZIP boundaries...`);

    const rawGeojson = await downloadStateGeojson(file);
    const stateZoneMap = new Map();
    let featureCount = 0;

    for (const feature of rawGeojson.features) {
      const zip5 = String(feature?.properties?.ZCTA5CE10 ?? "").padStart(5, "0");
      if (!/^\d{5}$/.test(zip5)) {
        continue;
      }

      const zip3 = zip5.slice(0, 3);
      const zoneId = `${state}-${zip3}`;

      const lookup = lookupZip(zip5);
      const city = lookup ? String(lookup.city || "").trim() : "";

      const latitude =
        lookup && Number.isFinite(lookup.latitude)
          ? lookup.latitude
          : toNumber(feature?.properties?.INTPTLAT10);
      const longitude =
        lookup && Number.isFinite(lookup.longitude)
          ? lookup.longitude
          : toNumber(feature?.properties?.INTPTLON10);

      const population =
        lookup && Number.isFinite(lookup.population) && lookup.population > 0
          ? Math.round(lookup.population)
          : 0;

      const housingUnitsEstimate =
        population > 0 ? Math.max(0, Math.round(population / HOUSEHOLD_SIZE_ESTIMATE)) : 0;

      let zone = stateZoneMap.get(zoneId);
      if (!zone) {
        zone = createZone(zoneId, state, stateName, zip3);
        stateZoneMap.set(zoneId, zone);
      }

      zone.zips.add(zip5);
      zone.population += population;
      zone.housingUnitsEstimate += housingUnitsEstimate;
      if (city) {
        zone.cities.add(city);
      }
      if (population > zone.topZipPopulation) {
        zone.topZipPopulation = population;
        zone.topZip5 = zip5;
        zone.topZipCity = city || null;
      }
      if (housingUnitsEstimate > zone.topHousingUnitsEstimate) {
        zone.topHousingUnitsEstimate = housingUnitsEstimate;
        zone.topHousingZip5 = zip5;
        zone.topHousingCity = city || null;
      }

      includeCountyWeights(zone, lookup, population);
      includePoint(zone, latitude, longitude);

      const polygonGeometries = extractPolygonGeometries(feature.geometry);
      for (const geometry of polygonGeometries) {
        zone.geometryFeatures.push({
          type: "Feature",
          properties: {},
          geometry: cloneGeometry(geometry)
        });
      }

      if (city) {
        const cityKey = `${state}|${city}`;
        let cityEntry = cityMap.get(cityKey);
        if (!cityEntry) {
          cityEntry = createCity(state, city, stateName);
          cityMap.set(cityKey, cityEntry);
        }

        cityEntry.zoneIds.add(zoneId);
        cityEntry.zip3s.add(zip3);
        cityEntry.zipCount += 1;
        cityEntry.population += population;
        includePoint(cityEntry, latitude, longitude);
      }

      featureCount += 1;
    }

    const stateZones = [...stateZoneMap.values()].map((zone) => ({
      zoneId: zone.zoneId,
      state: zone.state,
      stateName: zone.stateName,
      zip3: zone.zip3,
      label: `${zone.state}-${zone.zip3}`,
      zipCount: zone.zips.size,
      zips: [...zone.zips].sort(),
      cities: [...zone.cities].sort((a, b) => a.localeCompare(b)),
      latitude: average(zone.latSum, zone.pointCount),
      longitude: average(zone.lngSum, zone.pointCount),
      population: zone.population,
      populationPerZip: zone.zips.size > 0 ? Math.round(zone.population / zone.zips.size) : 0,
      housingUnitsEstimate: zone.housingUnitsEstimate,
      topZip5: zone.topZip5,
      topZipCity: zone.topZipCity,
      topZipPopulation: zone.topZipPopulation,
      topHousingZip5: zone.topHousingZip5,
      topHousingCity: zone.topHousingCity,
      topHousingUnitsEstimate: zone.topHousingUnitsEstimate,
      countyPopulationByFips: zone.countyPopulationByFips,
      geometry: dissolveZoneGeometry(zone)
    }));

    zones.push(...stateZones);

    stateStats.set(state, {
      state,
      stateName,
      featureCount,
      zoneCount: stateZones.length,
      cityCount: 0,
      population: 0
    });

    console.log(`${state}: ${featureCount} ZIP5 processed, ${stateZones.length} ZIP3 zones dissolved`);
  }

  if (hmda.hasMortgageData) {
    allocateCountyMortgageToZones(zones, hmda.countyMap);
    applyMortgageRankings(zones);
  } else {
    assignFallbackMortgageFields(zones);
  }

  const rankedZones = zones
    .slice()
    .sort((a, b) => b.population - a.population || a.label.localeCompare(b.label));

  const populationHotspotCount = Math.max(1, Math.ceil(rankedZones.length * HOTSPOT_RATIO));
  const populationHotspotSet = new Set(rankedZones.slice(0, populationHotspotCount).map((zone) => zone.zoneId));
  const stateRanksByZoneId = new Map();

  const zonesByState = new Map();
  for (const zone of rankedZones) {
    if (!zonesByState.has(zone.state)) {
      zonesByState.set(zone.state, []);
    }
    zonesByState.get(zone.state).push(zone);
  }

  for (const [stateCode, stateZones] of zonesByState.entries()) {
    stateZones.sort((a, b) => b.population - a.population || a.label.localeCompare(b.label));
    const stateZoneCount = stateZones.length;

    stateZones.forEach((zone, index) => {
      stateRanksByZoneId.set(zone.zoneId, {
        state: stateCode,
        statePopulationRank: index + 1,
        stateZoneCount
      });
    });
  }

  const zonesWithRank = rankedZones
    .map((zone, index) => {
      const stateRank = stateRanksByZoneId.get(zone.zoneId);

      return {
        ...zone,
        hasMortgageData: hmda.hasMortgageData,
        mortgageYear: hmda.year,
        populationRank: index + 1,
        isPopulationHotspot: populationHotspotSet.has(zone.zoneId),
        statePopulationRank: stateRank?.statePopulationRank ?? null,
        stateZoneCount: stateRank?.stateZoneCount ?? null
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const cities = [...cityMap.values()]
    .map((city) => ({
      key: city.key,
      state: city.state,
      stateName: city.stateName,
      city: city.city,
      label: `${city.city}, ${city.state}`,
      zipCount: city.zipCount,
      zoneIds: [...city.zoneIds].sort(),
      zip3s: [...city.zip3s].sort(),
      latitude: average(city.latSum, city.pointCount),
      longitude: average(city.lngSum, city.pointCount),
      population: city.population
    }))
    .sort((a, b) => b.population - a.population || a.label.localeCompare(b.label));

  const zoneGeojson = {
    type: "FeatureCollection",
    features: zonesWithRank.map((zone) => ({
      type: "Feature",
      geometry: zone.geometry,
      properties: {
        zoneId: zone.zoneId,
        state: zone.state,
        stateName: zone.stateName,
        zip3: zone.zip3,
        label: zone.label,
        zipCount: zone.zipCount,
        population: zone.population,
        populationPerZip: zone.populationPerZip,
        housingUnitsEstimate: zone.housingUnitsEstimate,
        topZip5: zone.topZip5,
        topZipCity: zone.topZipCity,
        topZipPopulation: zone.topZipPopulation,
        topHousingZip5: zone.topHousingZip5,
        topHousingCity: zone.topHousingCity,
        topHousingUnitsEstimate: zone.topHousingUnitsEstimate,
        hasMortgageData: zone.hasMortgageData,
        mortgageYear: zone.mortgageYear,
        mortgageOriginationsCount: zone.mortgageOriginationsCount,
        mortgageOriginationsAmount: zone.mortgageOriginationsAmount,
        mortgageVolumeRank: zone.mortgageVolumeRank,
        mortgageStateRank: zone.mortgageStateRank,
        mortgageStateZoneCount: zone.mortgageStateZoneCount,
        mortgageOpportunityScore: zone.mortgageOpportunityScore,
        mortgageOpportunityRank: zone.mortgageOpportunityRank,
        mortgageOpportunityStateRank: zone.mortgageOpportunityStateRank,
        isMortgageHotspot: zone.isMortgageHotspot,
        isMortgageOpportunityHotspot: zone.isMortgageOpportunityHotspot,
        populationRank: zone.populationRank,
        statePopulationRank: zone.statePopulationRank,
        stateZoneCount: zone.stateZoneCount,
        isPopulationHotspot: zone.isPopulationHotspot
      }
    }))
  };

  const zonesForJson = zonesWithRank.map((zone) => ({
    zoneId: zone.zoneId,
    state: zone.state,
    stateName: zone.stateName,
    zip3: zone.zip3,
    label: zone.label,
    zipCount: zone.zipCount,
    zips: zone.zips,
    cities: zone.cities,
    latitude: zone.latitude,
    longitude: zone.longitude,
    population: zone.population,
    populationPerZip: zone.populationPerZip,
    housingUnitsEstimate: zone.housingUnitsEstimate,
    topZip5: zone.topZip5,
    topZipCity: zone.topZipCity,
    topZipPopulation: zone.topZipPopulation,
    topHousingZip5: zone.topHousingZip5,
    topHousingCity: zone.topHousingCity,
    topHousingUnitsEstimate: zone.topHousingUnitsEstimate,
    hasMortgageData: zone.hasMortgageData,
    mortgageYear: zone.mortgageYear,
    mortgageOriginationsCount: zone.mortgageOriginationsCount,
    mortgageOriginationsAmount: zone.mortgageOriginationsAmount,
    mortgagePurchaseCount: zone.mortgagePurchaseCount,
    mortgagePurchaseAmount: zone.mortgagePurchaseAmount,
    mortgageOwnerOccupiedCount: zone.mortgageOwnerOccupiedCount,
    mortgageOwnerOccupiedAmount: zone.mortgageOwnerOccupiedAmount,
    mortgageAmountPerResident: zone.mortgageAmountPerResident,
    mortgageLoansPer10kResidents: zone.mortgageLoansPer10kResidents,
    mortgageVolumeRank: zone.mortgageVolumeRank,
    mortgageStateRank: zone.mortgageStateRank,
    mortgageStateZoneCount: zone.mortgageStateZoneCount,
    mortgageOpportunityScore: zone.mortgageOpportunityScore,
    mortgageOpportunityRank: zone.mortgageOpportunityRank,
    mortgageOpportunityStateRank: zone.mortgageOpportunityStateRank,
    isMortgageHotspot: zone.isMortgageHotspot,
    isMortgageOpportunityHotspot: zone.isMortgageOpportunityHotspot,
    populationRank: zone.populationRank,
    statePopulationRank: zone.statePopulationRank,
    stateZoneCount: zone.stateZoneCount,
    isPopulationHotspot: zone.isPopulationHotspot
  }));

  const states = targetStates.map((stateConfig) => {
    const base = stateStats.get(stateConfig.state);
    const stateZones = zonesForJson.filter((zone) => zone.state === stateConfig.state);
    const zoneCount = stateZones.length;
    const cityCount = cities.filter((city) => city.state === stateConfig.state).length;
    const population = stateZones.reduce((sum, zone) => sum + zone.population, 0);
    const housingUnitsEstimate = stateZones.reduce((sum, zone) => sum + zone.housingUnitsEstimate, 0);
    const mortgageOriginationsCount = stateZones.reduce((sum, zone) => sum + zone.mortgageOriginationsCount, 0);
    const mortgageOriginationsAmount = stateZones.reduce((sum, zone) => sum + zone.mortgageOriginationsAmount, 0);

    return {
      state: stateConfig.state,
      stateName: stateConfig.stateName,
      featureCount: base?.featureCount ?? 0,
      zoneCount,
      cityCount,
      population,
      housingUnitsEstimate,
      mortgageOriginationsCount: hmda.hasMortgageData ? mortgageOriginationsCount : null,
      mortgageOriginationsAmount: hmda.hasMortgageData ? mortgageOriginationsAmount : null
    };
  });

  await fs.mkdir(outputDir, { recursive: true });

  await fs.writeFile(
    path.join(outputDir, "coverage_zip3.geojson"),
    JSON.stringify(zoneGeojson)
  );

  await fs.writeFile(
    path.join(outputDir, "coverage_zip3_zones.json"),
    JSON.stringify(zonesForJson)
  );

  await fs.writeFile(
    path.join(outputDir, "coverage_cities.json"),
    JSON.stringify(cities)
  );

  await fs.writeFile(
    path.join(outputDir, "coverage_states.json"),
    JSON.stringify(states)
  );

  const totalPopulation = zonesForJson.reduce((sum, zone) => sum + zone.population, 0);
  const totalHousingUnits = zonesForJson.reduce((sum, zone) => sum + zone.housingUnitsEstimate, 0);
  const totalMortgageLoans = zonesForJson.reduce((sum, zone) => sum + zone.mortgageOriginationsCount, 0);
  const totalMortgageAmount = zonesForJson.reduce((sum, zone) => sum + zone.mortgageOriginationsAmount, 0);

  console.log(`Generated ${zoneGeojson.features.length} ZIP3 zone features`);
  console.log(`Generated ${zonesForJson.length} ZIP3 zone summaries`);
  console.log(`Generated ${cities.length} city points`);
  console.log(`Generated ${states.length} states metadata`);
  console.log(`Estimated covered population: ${totalPopulation.toLocaleString("en-US")}`);
  console.log(`Estimated households covered: ${totalHousingUnits.toLocaleString("en-US")}`);

  if (hmda.hasMortgageData) {
    console.log(`Mortgage year: ${hmda.year}`);
    console.log(`Estimated originated loans (ZIP3 allocation): ${totalMortgageLoans.toLocaleString("en-US")}`);
    console.log(`Estimated originated volume (ZIP3 allocation): $${Math.round(totalMortgageAmount).toLocaleString("en-US")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
