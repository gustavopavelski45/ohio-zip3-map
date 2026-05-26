import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import readline from "node:readline";
import { spawn } from "node:child_process";

const HMDA_YEAR = Number.parseInt(process.env.HMDA_YEAR || "2024", 10);
const HMDA_ZIP_URL =
  process.env.HMDA_SNAPSHOT_URL ||
  `https://files.ffiec.cfpb.gov/static-data/snapshot/${HMDA_YEAR}/${HMDA_YEAR}_public_lar_pipe.zip`;
const HMDA_ZIP_PATH =
  process.env.HMDA_ZIP_PATH || path.join(process.env.TMPDIR || "/tmp", `${HMDA_YEAR}_public_lar_pipe.zip`);
const PROGRESS_EVERY = 500_000;

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

async function fileExists(targetPath) {
  try {
    const stat = await fsp.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function ensureSnapshotZip() {
  if (await fileExists(HMDA_ZIP_PATH)) {
    const stat = await fsp.stat(HMDA_ZIP_PATH);
    console.log(`Using cached HMDA snapshot: ${HMDA_ZIP_PATH} (${Math.round(stat.size / 1024 / 1024)} MB)`);
    return HMDA_ZIP_PATH;
  }

  console.log(`Downloading HMDA snapshot ${HMDA_YEAR}...`);
  const response = await fetch(HMDA_ZIP_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download HMDA snapshot (${response.status})`);
  }

  const tmpPath = `${HMDA_ZIP_PATH}.download`;
  await fsp.mkdir(path.dirname(HMDA_ZIP_PATH), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpPath));
  await fsp.rename(tmpPath, HMDA_ZIP_PATH);

  const stat = await fsp.stat(HMDA_ZIP_PATH);
  console.log(`Downloaded HMDA snapshot to ${HMDA_ZIP_PATH} (${Math.round(stat.size / 1024 / 1024)} MB)`);
  return HMDA_ZIP_PATH;
}

function parseHeaderIndexes(headerLine) {
  const columns = headerLine.split("|");

  const indexByName = {
    state: columns.indexOf("state_code"),
    county: columns.indexOf("county_code"),
    action: columns.indexOf("action_taken"),
    loanAmount: columns.indexOf("loan_amount"),
    loanPurpose: columns.indexOf("loan_purpose"),
    occupancyType: columns.indexOf("occupancy_type")
  };

  for (const [name, index] of Object.entries(indexByName)) {
    if (index < 0) {
      throw new Error(`HMDA column not found: ${name}`);
    }
  }

  return indexByName;
}

async function aggregateCountyData(zipPath) {
  const countyMap = new Map();
  let processedRows = 0;
  let acceptedRows = 0;
  let headerIndexes = null;

  const unzip = spawn("unzip", ["-p", zipPath], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderrOutput = "";
  unzip.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString("utf-8");
    if (stderrOutput.length > 4000) {
      stderrOutput = stderrOutput.slice(-4000);
    }
  });

  const rl = readline.createInterface({
    input: unzip.stdout,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (headerIndexes === null) {
      headerIndexes = parseHeaderIndexes(line);
      continue;
    }

    processedRows += 1;
    if (processedRows % PROGRESS_EVERY === 0) {
      console.log(`Parsed ${processedRows.toLocaleString("en-US")} rows...`);
    }

    if (!line) {
      continue;
    }

    const columns = line.split("|");
    const actionTaken = String(columns[headerIndexes.action] || "").trim();

    if (actionTaken !== "1") {
      continue;
    }

    const stateCode = String(columns[headerIndexes.state] || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(stateCode)) {
      continue;
    }

    const countyFips = normalizeCountyFips(columns[headerIndexes.county]);
    if (!countyFips || countyFips === "99999") {
      continue;
    }

    const amountRaw = Number.parseFloat(String(columns[headerIndexes.loanAmount] || ""));
    const loanAmount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 0;
    const loanPurpose = String(columns[headerIndexes.loanPurpose] || "").trim();
    const occupancyType = String(columns[headerIndexes.occupancyType] || "").trim();

    let county = countyMap.get(countyFips);
    if (!county) {
      county = {
        countyFips,
        state: stateCode,
        originatedCount: 0,
        originatedAmount: 0,
        purchaseCount: 0,
        purchaseAmount: 0,
        ownerOccupiedCount: 0,
        ownerOccupiedAmount: 0
      };
      countyMap.set(countyFips, county);
    }

    county.originatedCount += 1;
    county.originatedAmount += loanAmount;

    if (loanPurpose === "1") {
      county.purchaseCount += 1;
      county.purchaseAmount += loanAmount;
    }

    if (occupancyType === "1") {
      county.ownerOccupiedCount += 1;
      county.ownerOccupiedAmount += loanAmount;
    }

    acceptedRows += 1;
  }

  const exitCode = await new Promise((resolve, reject) => {
    unzip.on("error", reject);
    unzip.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`unzip failed with code ${exitCode}. ${stderrOutput.trim()}`.trim());
  }

  const counties = [...countyMap.values()]
    .map((entry) => ({
      countyFips: entry.countyFips,
      state: entry.state,
      originatedCount: entry.originatedCount,
      originatedAmount: Math.round(entry.originatedAmount),
      purchaseCount: entry.purchaseCount,
      purchaseAmount: Math.round(entry.purchaseAmount),
      ownerOccupiedCount: entry.ownerOccupiedCount,
      ownerOccupiedAmount: Math.round(entry.ownerOccupiedAmount)
    }))
    .sort((a, b) => a.countyFips.localeCompare(b.countyFips));

  const totals = counties.reduce(
    (acc, county) => {
      acc.originatedCount += county.originatedCount;
      acc.originatedAmount += county.originatedAmount;
      acc.purchaseCount += county.purchaseCount;
      acc.purchaseAmount += county.purchaseAmount;
      acc.ownerOccupiedCount += county.ownerOccupiedCount;
      acc.ownerOccupiedAmount += county.ownerOccupiedAmount;
      return acc;
    },
    {
      originatedCount: 0,
      originatedAmount: 0,
      purchaseCount: 0,
      purchaseAmount: 0,
      ownerOccupiedCount: 0,
      ownerOccupiedAmount: 0
    }
  );

  return {
    processedRows,
    acceptedRows,
    counties,
    totals
  };
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, "..");
  const outputDir = path.join(projectRoot, "public", "data");
  const outputPath = path.join(outputDir, `hmda_county_${HMDA_YEAR}.json`);

  const zipPath = await ensureSnapshotZip();
  console.log("Aggregating HMDA county metrics (loan originations only)...");
  const aggregated = await aggregateCountyData(zipPath);

  const payload = {
    year: HMDA_YEAR,
    source: HMDA_ZIP_URL,
    generatedAt: new Date().toISOString(),
    processedRows: aggregated.processedRows,
    acceptedRows: aggregated.acceptedRows,
    countyCount: aggregated.counties.length,
    totals: aggregated.totals,
    counties: aggregated.counties
  };

  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(outputPath, JSON.stringify(payload));

  console.log(`Saved ${aggregated.counties.length.toLocaleString("en-US")} counties to ${outputPath}`);
  console.log(`Originated loans counted: ${aggregated.totals.originatedCount.toLocaleString("en-US")}`);
  console.log(`Originated volume counted: $${Math.round(aggregated.totals.originatedAmount).toLocaleString("en-US")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
