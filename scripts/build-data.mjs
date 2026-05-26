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

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, "..");
  const outputDir = path.join(projectRoot, "public", "data");
  const targetStates = await loadTargetStates();
  console.log(`Loaded ${targetStates.length} states from source catalog.`);

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

      let zone = stateZoneMap.get(zoneId);
      if (!zone) {
        zone = createZone(zoneId, state, stateName, zip3);
        stateZoneMap.set(zoneId, zone);
      }

      zone.zips.add(zip5);
      zone.population += population;
      if (city) {
        zone.cities.add(city);
      }
      if (population > zone.topZipPopulation) {
        zone.topZipPopulation = population;
        zone.topZip5 = zip5;
        zone.topZipCity = city || null;
      }

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
      topZip5: zone.topZip5,
      topZipCity: zone.topZipCity,
      topZipPopulation: zone.topZipPopulation,
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

  const rankedZones = zones
    .slice()
    .sort((a, b) => b.population - a.population || a.label.localeCompare(b.label));

  const hotspotCount = Math.max(1, Math.ceil(rankedZones.length * 0.15));
  const hotspotSet = new Set(rankedZones.slice(0, hotspotCount).map((zone) => zone.zoneId));
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
        populationRank: index + 1,
        isPopulationHotspot: hotspotSet.has(zone.zoneId),
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
        topZip5: zone.topZip5,
        topZipCity: zone.topZipCity,
        topZipPopulation: zone.topZipPopulation,
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
    topZip5: zone.topZip5,
    topZipCity: zone.topZipCity,
    topZipPopulation: zone.topZipPopulation,
    populationRank: zone.populationRank,
    statePopulationRank: zone.statePopulationRank,
    stateZoneCount: zone.stateZoneCount,
    isPopulationHotspot: zone.isPopulationHotspot
  }));

  const states = targetStates.map((stateConfig) => {
    const base = stateStats.get(stateConfig.state);
    const zoneCount = zonesForJson.filter((zone) => zone.state === stateConfig.state).length;
    const cityCount = cities.filter((city) => city.state === stateConfig.state).length;
    const population = zonesForJson
      .filter((zone) => zone.state === stateConfig.state)
      .reduce((sum, zone) => sum + zone.population, 0);

    return {
      state: stateConfig.state,
      stateName: stateConfig.stateName,
      featureCount: base?.featureCount ?? 0,
      zoneCount,
      cityCount,
      population
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

  console.log(`Generated ${zoneGeojson.features.length} ZIP3 zone features`);
  console.log(`Generated ${zonesForJson.length} ZIP3 zone summaries`);
  console.log(`Generated ${cities.length} city points`);
  console.log(`Generated ${states.length} states metadata`);
  console.log(`Estimated covered population: ${totalPopulation.toLocaleString("en-US")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
