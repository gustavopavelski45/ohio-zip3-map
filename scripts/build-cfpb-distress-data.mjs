import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CFPB_API_BASE_URL =
  process.env.CFPB_API_BASE_URL ||
  "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/";
const CFPB_PRODUCT = process.env.CFPB_PRODUCT || "Mortgage";
const CFPB_ISSUES = (process.env.CFPB_ISSUES || "Struggling to pay mortgage")
  .split("|")
  .map((entry) => entry.trim())
  .filter(Boolean);
const CFPB_LOOKBACK_MONTHS_RAW = Number.parseInt(process.env.CFPB_LOOKBACK_MONTHS || "12", 10);
const CFPB_LOOKBACK_MONTHS = Number.isFinite(CFPB_LOOKBACK_MONTHS_RAW)
  ? Math.min(36, Math.max(1, CFPB_LOOKBACK_MONTHS_RAW))
  : 12;
const CFPB_PAGE_SIZE_RAW = Number.parseInt(process.env.CFPB_PAGE_SIZE || "10000", 10);
const CFPB_PAGE_SIZE = Number.isFinite(CFPB_PAGE_SIZE_RAW)
  ? Math.min(10000, Math.max(100, CFPB_PAGE_SIZE_RAW))
  : 10000;
const CFPB_OUTPUT_FILE = process.env.CFPB_OUTPUT_FILE || "cfpb_mortgage_distress_12m.json";
const REQUEST_TIMEOUT_MS_RAW = Number.parseInt(process.env.CFPB_TIMEOUT_MS || "60000", 10);
const REQUEST_TIMEOUT_MS = Number.isFinite(REQUEST_TIMEOUT_MS_RAW)
  ? Math.min(120000, Math.max(10000, REQUEST_TIMEOUT_MS_RAW))
  : 60000;
const CFPB_RETRY_COUNT_RAW = Number.parseInt(process.env.CFPB_RETRY_COUNT || "3", 10);
const CFPB_RETRY_COUNT = Number.isFinite(CFPB_RETRY_COUNT_RAW)
  ? Math.min(6, Math.max(1, CFPB_RETRY_COUNT_RAW))
  : 3;

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
];

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function computeDateReceivedMin() {
  if (process.env.CFPB_DATE_RECEIVED_MIN) {
    return process.env.CFPB_DATE_RECEIVED_MIN;
  }

  const now = new Date();
  const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (CFPB_LOOKBACK_MONTHS - 1), 1));
  return formatDate(firstDay);
}

function normalizeZip3(zipCode) {
  const digits = String(zipCode || "").replaceAll(/\D/g, "");
  if (digits.length < 3) {
    return null;
  }
  return digits.slice(0, 3);
}

function normalizeState(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return US_STATES.includes(normalized) ? normalized : null;
}

function isUntimely(value) {
  return String(value || "").trim().toLowerCase() === "no";
}

function parseComplaintDate(value) {
  const parsed = new Date(String(value || ""));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createZoneEntry(zoneId, state, zip3) {
  return {
    zoneId,
    state,
    zip3,
    complaintCount: 0,
    untimelyCount: 0,
    strugglingCount: 0,
    paymentTroubleCount: 0,
    latestComplaintDate: null
  };
}

function createStateEntry(state) {
  return {
    state,
    complaintCount: 0,
    untimelyCount: 0,
    strugglingCount: 0,
    paymentTroubleCount: 0,
    latestComplaintDate: null
  };
}

function updateLatestDate(target, dateValue) {
  if (!dateValue) {
    return;
  }

  const date = parseComplaintDate(dateValue);
  if (!date) {
    return;
  }

  if (!target.latestComplaintDate) {
    target.latestComplaintDate = formatDate(date);
    return;
  }

  const current = parseComplaintDate(target.latestComplaintDate);
  if (!current || date.getTime() > current.getTime()) {
    target.latestComplaintDate = formatDate(date);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchJson(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= CFPB_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "pavelski-zope-map-cfpb-builder"
        }
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`CFPB API error ${response.status}: ${body.slice(0, 300)}`);
      }

      const payload = await response.json();
      if (payload?.error) {
        throw new Error(`CFPB API payload error: ${payload.error}`);
      }

      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < CFPB_RETRY_COUNT) {
        await sleep(1200 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

async function fetchComplaintsForStateIssue({ state, issue, dateReceivedMin }) {
  const params = new URLSearchParams();
  params.set("size", String(CFPB_PAGE_SIZE));
  params.set("product", CFPB_PRODUCT);
  params.set("issue", issue);
  params.set("state", state);
  params.set("date_received_min", dateReceivedMin);

  const url = `${CFPB_API_BASE_URL}?${params.toString()}`;
  const payload = await fetchJson(url);
  const hits = Array.isArray(payload?.hits?.hits) ? payload.hits.hits : [];
  const total = Number.parseInt(String(payload?.hits?.total?.value || hits.length), 10) || hits.length;

  if (total > CFPB_PAGE_SIZE) {
    throw new Error(
      `Query overflow for ${state} / "${issue}". total=${total}, size=${CFPB_PAGE_SIZE}. ` +
        "Increase partitioning or reduce date range."
    );
  }

  return {
    hits,
    total,
    apiLastUpdated: payload?._meta?.last_updated || null
  };
}

async function main() {
  const dateReceivedMin = computeDateReceivedMin();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, "..");
  const outputDir = path.join(projectRoot, "public", "data");
  const outputFile = path.join(outputDir, CFPB_OUTPUT_FILE);

  const zoneMap = new Map();
  const stateMap = new Map();
  const seenComplaintIds = new Set();
  const totalsByIssue = new Map();
  const warnings = [];
  let apiLastUpdated = null;

  for (const issue of CFPB_ISSUES) {
    let issueCount = 0;
    console.log(`Fetching CFPB issue "${issue}"...`);

    for (const state of US_STATES) {
      let result;
      try {
        result = await fetchComplaintsForStateIssue({
          state,
          issue,
          dateReceivedMin
        });
      } catch (error) {
        const message = `Could not fetch CFPB for ${state} / "${issue}": ${error.message}`;
        warnings.push(message);
        console.warn(message);
        continue;
      }

      const { hits, total, apiLastUpdated: apiDate } = result;
      issueCount += total;
      if (apiDate && (!apiLastUpdated || apiDate > apiLastUpdated)) {
        apiLastUpdated = apiDate;
      }

      for (const hit of hits) {
        const source = hit?._source || {};
        const complaintId = String(source.complaint_id || hit?._id || "").trim();
        if (!complaintId || seenComplaintIds.has(complaintId)) {
          continue;
        }

        const complaintState = normalizeState(source.state);
        const zip3 = normalizeZip3(source.zip_code);
        if (!complaintState || !zip3) {
          continue;
        }

        seenComplaintIds.add(complaintId);

        const zoneId = `${complaintState}-${zip3}`;
        if (!zoneMap.has(zoneId)) {
          zoneMap.set(zoneId, createZoneEntry(zoneId, complaintState, zip3));
        }
        if (!stateMap.has(complaintState)) {
          stateMap.set(complaintState, createStateEntry(complaintState));
        }

        const zone = zoneMap.get(zoneId);
        const stateEntry = stateMap.get(complaintState);
        const untimely = isUntimely(source.timely);
        const lowerIssue = issue.toLowerCase();

        zone.complaintCount += 1;
        stateEntry.complaintCount += 1;

        if (untimely) {
          zone.untimelyCount += 1;
          stateEntry.untimelyCount += 1;
        }

        if (lowerIssue === "struggling to pay mortgage") {
          zone.strugglingCount += 1;
          stateEntry.strugglingCount += 1;
        } else if (lowerIssue === "trouble during payment process") {
          zone.paymentTroubleCount += 1;
          stateEntry.paymentTroubleCount += 1;
        }

        updateLatestDate(zone, source.date_received);
        updateLatestDate(stateEntry, source.date_received);
      }
    }

    totalsByIssue.set(issue, issueCount);
    console.log(`Issue "${issue}": ${issueCount.toLocaleString("en-US")} complaints in range.`);
  }

  const states = [...stateMap.values()].sort((a, b) => b.complaintCount - a.complaintCount || a.state.localeCompare(b.state));
  const zones = [...zoneMap.values()].sort((a, b) => b.complaintCount - a.complaintCount || a.zoneId.localeCompare(b.zoneId));

  const totalComplaints = zones.reduce((sum, zone) => sum + zone.complaintCount, 0);
  const totalUntimelyComplaints = zones.reduce((sum, zone) => sum + zone.untimelyCount, 0);

  if (zones.length === 0) {
    warnings.push("No complaints found for selected filters. Check CFPB_DATE_RECEIVED_MIN or issues.");
  }

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    outputFile,
    JSON.stringify({
      source: {
        apiBaseUrl: CFPB_API_BASE_URL,
        product: CFPB_PRODUCT,
        issues: CFPB_ISSUES,
        lookbackMonths: CFPB_LOOKBACK_MONTHS,
        dateReceivedMin,
        apiLastUpdated,
        generatedAt: new Date().toISOString()
      },
      totals: {
        complaintCount: totalComplaints,
        untimelyCount: totalUntimelyComplaints,
        zoneCount: zones.length,
        stateCount: states.length,
        totalsByIssue: Object.fromEntries(totalsByIssue)
      },
      warnings,
      states,
      zones
    })
  );

  console.log(`Saved ${CFPB_OUTPUT_FILE}`);
  console.log(`Complaints captured: ${totalComplaints.toLocaleString("en-US")}`);
  console.log(`Untimely complaints: ${totalUntimelyComplaints.toLocaleString("en-US")}`);
  if (apiLastUpdated) {
    console.log(`CFPB API last updated: ${apiLastUpdated}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
