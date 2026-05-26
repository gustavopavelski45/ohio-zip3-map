import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { lookupZip } = require("zipcode-detail-lookup");

const COORD_PRECISION = 5;
const POINT_SAMPLE_STEP = 12;

const SOURCE_BASE_URL =
  "https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master";

const TARGET_STATES = [
  { state: "OH", stateName: "Ohio", file: "oh_ohio_zip_codes_geo.min.json" },
  { state: "PA", stateName: "Pennsylvania", file: "pa_pennsylvania_zip_codes_geo.min.json" },
  { state: "MI", stateName: "Michigan", file: "mi_michigan_zip_codes_geo.min.json" },
  { state: "NJ", stateName: "New Jersey", file: "nj_new_jersey_zip_codes_geo.min.json" },
  { state: "NY", stateName: "New York", file: "ny_new_york_zip_codes_geo.min.json" },
  { state: "NH", stateName: "New Hampshire", file: "nh_new_hampshire_zip_codes_geo.min.json" },
  { state: "NC", stateName: "North Carolina", file: "nc_north_carolina_zip_codes_geo.min.json" },
  { state: "SC", stateName: "South Carolina", file: "sc_south_carolina_zip_codes_geo.min.json" },
  { state: "CT", stateName: "Connecticut", file: "ct_connecticut_zip_codes_geo.min.json" },
  { state: "GA", stateName: "Georgia", file: "ga_georgia_zip_codes_geo.min.json" },
  { state: "DE", stateName: "Delaware", file: "de_delaware_zip_codes_geo.min.json" },
  { state: "MD", stateName: "Maryland", file: "md_maryland_zip_codes_geo.min.json" },
  { state: "CA", stateName: "California", file: "ca_california_zip_codes_geo.min.json" },
  { state: "FL", stateName: "Florida", file: "fl_florida_zip_codes_geo.min.json" },
  { state: "VA", stateName: "Virginia", file: "va_virginia_zip_codes_geo.min.json" },
  { state: "KY", stateName: "Kentucky", file: "ky_kentucky_zip_codes_geo.min.json" }
];

function toNumber(value) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundCoord(value) {
  return Number(value.toFixed(COORD_PRECISION));
}

function createZone(zoneId, state, stateName, zip3) {
  return {
    zoneId,
    state,
    stateName,
    zip3,
    zips: new Set(),
    cities: new Set(),
    latSum: 0,
    lngSum: 0,
    pointCount: 0,
    population: 0,
    sampledPoints: [],
    sampleCursor: 0
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

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHull(points) {
  if (points.length <= 1) {
    return points;
  }

  const sorted = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

function uniquePoints(points) {
  const seen = new Set();
  const unique = [];

  for (const [lon, lat] of points) {
    const key = `${lon.toFixed(COORD_PRECISION)}|${lat.toFixed(COORD_PRECISION)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push([lon, lat]);
  }

  return unique;
}

function fallbackSquare(longitude, latitude) {
  const delta = 0.08;
  const lon = Number.isFinite(longitude) ? longitude : -83;
  const lat = Number.isFinite(latitude) ? latitude : 40;

  return [
    [roundCoord(lon - delta), roundCoord(lat - delta)],
    [roundCoord(lon + delta), roundCoord(lat - delta)],
    [roundCoord(lon + delta), roundCoord(lat + delta)],
    [roundCoord(lon - delta), roundCoord(lat + delta)],
    [roundCoord(lon - delta), roundCoord(lat - delta)]
  ];
}

function toZoneGeometry(zone) {
  const unique = uniquePoints(zone.sampledPoints);

  if (unique.length < 3) {
    return {
      type: "Polygon",
      coordinates: [fallbackSquare(average(zone.lngSum, zone.pointCount), average(zone.latSum, zone.pointCount))]
    };
  }

  const hull = convexHull(unique);
  if (hull.length < 3) {
    return {
      type: "Polygon",
      coordinates: [fallbackSquare(average(zone.lngSum, zone.pointCount), average(zone.latSum, zone.pointCount))]
    };
  }

  const closedHull = [...hull, hull[0]];

  return {
    type: "Polygon",
    coordinates: [closedHull]
  };
}

function collectGeometryPoints(geometry, zone) {
  if (!geometry || typeof geometry !== "object") {
    return;
  }

  if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    for (const subGeometry of geometry.geometries) {
      collectGeometryPoints(subGeometry, zone);
    }
    return;
  }

  const walk = (coordinates) => {
    if (!Array.isArray(coordinates)) {
      return;
    }

    if (
      coordinates.length >= 2 &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number"
    ) {
      const lon = coordinates[0];
      const lat = coordinates[1];

      zone.sampleCursor += 1;
      if (
        zone.sampleCursor % POINT_SAMPLE_STEP === 0 &&
        Number.isFinite(lon) &&
        Number.isFinite(lat)
      ) {
        zone.sampledPoints.push([roundCoord(lon), roundCoord(lat)]);
      }

      return;
    }

    for (const next of coordinates) {
      walk(next);
    }
  };

  walk(geometry.coordinates);
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

  const zoneMap = new Map();
  const cityMap = new Map();
  const stateStats = new Map();

  for (const stateConfig of TARGET_STATES) {
    const { state, stateName, file } = stateConfig;
    console.log(`Downloading ${state} ZIP boundaries...`);

    const rawGeojson = await downloadStateGeojson(file);
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

      let zone = zoneMap.get(zoneId);
      if (!zone) {
        zone = createZone(zoneId, state, stateName, zip3);
        zoneMap.set(zoneId, zone);
      }

      zone.zips.add(zip5);
      zone.population += population;
      if (city) {
        zone.cities.add(city);
      }

      includePoint(zone, latitude, longitude);
      collectGeometryPoints(feature.geometry, zone);

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

    stateStats.set(state, {
      state,
      stateName,
      featureCount,
      zoneCount: 0,
      cityCount: 0,
      population: 0
    });

    console.log(`${state}: ${featureCount} ZIP5 processed`);
  }

  const zones = [...zoneMap.values()]
    .map((zone) => ({
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
      geometry: toZoneGeometry(zone)
    }))
    .sort((a, b) => b.population - a.population || a.label.localeCompare(b.label));

  const hotspotCount = Math.max(1, Math.ceil(zones.length * 0.15));
  const hotspotSet = new Set(zones.slice(0, hotspotCount).map((zone) => zone.zoneId));

  const zonesWithRank = zones
    .map((zone, index) => ({
      ...zone,
      populationRank: index + 1,
      isPopulationHotspot: hotspotSet.has(zone.zoneId)
    }))
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
        populationRank: zone.populationRank,
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
    populationRank: zone.populationRank,
    isPopulationHotspot: zone.isPopulationHotspot
  }));

  const states = TARGET_STATES.map((stateConfig) => {
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
