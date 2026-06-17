import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COUNTY_SOURCE_URL =
  process.env.COUNTY_SOURCE_URL ||
  "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";

const STATE_FIPS_TO_ABBR = new Map([
  ["01", "AL"], ["02", "AK"], ["04", "AZ"], ["05", "AR"], ["06", "CA"],
  ["08", "CO"], ["09", "CT"], ["10", "DE"], ["12", "FL"], ["13", "GA"],
  ["15", "HI"], ["16", "ID"], ["17", "IL"], ["18", "IN"], ["19", "IA"],
  ["20", "KS"], ["21", "KY"], ["22", "LA"], ["23", "ME"], ["24", "MD"],
  ["25", "MA"], ["26", "MI"], ["27", "MN"], ["28", "MS"], ["29", "MO"],
  ["30", "MT"], ["31", "NE"], ["32", "NV"], ["33", "NH"], ["34", "NJ"],
  ["35", "NM"], ["36", "NY"], ["37", "NC"], ["38", "ND"], ["39", "OH"],
  ["40", "OK"], ["41", "OR"], ["42", "PA"], ["44", "RI"], ["45", "SC"],
  ["46", "SD"], ["47", "TN"], ["48", "TX"], ["49", "UT"], ["50", "VT"],
  ["51", "VA"], ["53", "WA"], ["54", "WV"], ["55", "WI"], ["56", "WY"]
]);

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, "..");
  const outputPath = path.join(projectRoot, "public", "data", "coverage_counties.geojson");
  const response = await fetch(COUNTY_SOURCE_URL, {
    headers: {
      "User-Agent": "pavelski-zope-map-county-builder"
    }
  });

  if (!response.ok) {
    throw new Error(`Could not download county GeoJSON (${response.status})`);
  }

  const payload = await response.json();
  if (!payload || payload.type !== "FeatureCollection" || !Array.isArray(payload.features)) {
    throw new Error("Unexpected county GeoJSON format.");
  }

  const features = payload.features
    .map((feature) => {
      const stateFips = String(feature?.properties?.STATE || "").padStart(2, "0");
      const countyCode = String(feature?.properties?.COUNTY || "").padStart(3, "0");
      const state = STATE_FIPS_TO_ABBR.get(stateFips);
      if (!state || !feature?.geometry) {
        return null;
      }

      const countyName = String(feature.properties.NAME || "").trim();
      const adminType = String(feature.properties.LSAD || "County").trim();

      return {
        type: "Feature",
        properties: {
          countyFips: `${stateFips}${countyCode}`,
          state,
          countyName,
          adminType,
          label: `${countyName} ${adminType}, ${state}`
        },
        geometry: feature.geometry
      };
    })
    .filter(Boolean);

  features.sort((a, b) => a.properties.countyFips.localeCompare(b.properties.countyFips));

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    JSON.stringify({
      type: "FeatureCollection",
      metadata: {
        source: COUNTY_SOURCE_URL,
        generatedAt: new Date().toISOString(),
        countyCount: features.length
      },
      features
    })
  );

  console.log(`Generated ${features.length.toLocaleString("en-US")} county features`);
  console.log("Saved coverage_counties.geojson");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
