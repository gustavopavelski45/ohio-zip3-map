import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Read the 30-day values and vendor codes used in zone details.
const READ_XLSX = String.raw`
import json, posixpath, sys, zipfile
from xml.etree import ElementTree as ET
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as book:
    strings = []
    if 'xl/sharedStrings.xml' in book.namelist():
        strings = [''.join(n.itertext()) for n in ET.fromstring(book.read('xl/sharedStrings.xml'))]
    rels = {r.attrib['Id']: r.attrib['Target'] for r in ET.fromstring(book.read('xl/_rels/workbook.xml.rels'))}
    sheets = {}
    for sheet in ET.fromstring(book.read('xl/workbook.xml')).findall('s:sheets/s:sheet', ns):
        if sheet.attrib['name'] not in ('Production Report', 'Criterios'):
            continue
        target = rels[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
        target = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
        rows = []
        for row in ET.fromstring(book.read(target)).findall('s:sheetData/s:row', ns):
            cells = {}
            for cell in row.findall('s:c', ns):
                column = ''.join(c for c in cell.attrib['r'] if c.isalpha())
                if column not in ('A', 'B', 'C'):
                    continue
                value = cell.find('s:v', ns)
                kind = cell.attrib.get('t')
                if kind == 'inlineStr':
                    value = ''.join(n.text or '' for n in cell.findall('.//s:t', ns))
                elif value is None or value.text is None:
                    value = None
                elif kind == 's':
                    value = strings[int(value.text)]
                elif kind in ('str', 'e', 'd'):
                    value = value.text
                else:
                    value = float(value.text)
                cells[column] = value
            rows.append({'row': int(row.attrib['r']), 'cells': cells})
        sheets[sheet.attrib['name']] = rows
    print(json.dumps(sheets))
`;

export function parseZoneReport(rows) {
  assert.equal(rows[0]?.cells.B, "30 Day Vol", "Expected 30-day volume column");
  assert(["OT%", "OT% 30d"].includes(rows[0]?.cells.C), "Expected 30-day on-time column");
  const groups = new Map();
  const stateTotals = new Map();
  let nonZip3Volume30Day = 0;
  let unlocatedVolume30Day = 0;
  let state = null;
  let group = null;
  let rowOrder = 0;
  const metrics = (cells, row) => {
    assert(Number.isInteger(cells.B) && cells.B >= 0, `Invalid volume at row ${row}`);
    assert(cells.C == null || (typeof cells.C === "number" && cells.C >= 0 && cells.C <= 100), `Invalid OT at row ${row}`);
    return { volume30Day: cells.B, onTimePct: cells.C ?? null };
  };
  for (const { row, cells } of rows.slice(1)) {
    const raw = String(cells.A ?? "");
    const label = raw.trim();
    if (!label) continue;
    if (raw === label && /^[A-Z]{2}$/.test(label)) {
      state = label;
      const summary = metrics(cells, row);
      assert(!stateTotals.has(state), `Duplicate state at row ${row}`);
      stateTotals.set(state, summary.volume30Day);
      group = null;
      continue;
    }
    const header = label.match(/^([A-Z]{2})\s+(Z?\d+|NO_ZONE)$/);
    if (header) {
      group = null;
      assert.equal(header[1], state, `Unexpected state at row ${row}`);
      const zip3 = header[2].replace(/^Z/, "");
      const { volume30Day, onTimePct } = metrics(cells, row);
      if (zip3 === "NO_ZONE") {
        unlocatedVolume30Day += volume30Day;
        continue;
      }
      if (!/^\d{3}$/.test(zip3)) {
        nonZip3Volume30Day += volume30Day;
        continue;
      }
      const zoneId = `${state}-${zip3}`;
      assert(!groups.has(zoneId), `Duplicate zone at row ${row}`);
      group = { zoneId, state, zip3, volume30Day, onTimePct, vendors: [], identifiers: new Set(), rowOrder: rowOrder++ };
      groups.set(zoneId, group);
      continue;
    }
    if (!group) continue;
    const identifier = label.replace(/\s+\(novo\)$/i, "");
    assert(!group.identifiers.has(identifier), `Duplicate vendor at row ${row}`);
    group.identifiers.add(identifier);
    group.vendors.push({ vendorCode: identifier, ...metrics(cells, row) });
  }
  const zones = new Map([...groups].map(([zoneId, entry]) => {
    assert.equal(entry.vendors.reduce((sum, v) => sum + v.volume30Day, 0), entry.volume30Day, `Vendor total mismatch: ${zoneId}`);
    const topVendors = entry.vendors
      .filter((v) => v.volume30Day > 0)
      .sort((a, b) => b.volume30Day - a.volume30Day || (b.onTimePct ?? -1) - (a.onTimePct ?? -1))
      .slice(0, 3)
      .map((vendor, index) => ({ rank: index + 1, ...vendor }));
    return [zoneId, { ...entry, topVendors }];
  }));

  assert(stateTotals.size > 0, "Missing state totals");
  const stateVolume = [...stateTotals.values()].reduce((sum, volume) => sum + volume, 0);
  const zoneVolume = [...zones.values()].reduce((sum, zone) => sum + zone.volume30Day, 0);
  assert.equal(stateVolume, zoneVolume + nonZip3Volume30Day + unlocatedVolume30Day, "State, ZIP3, non-ZIP3, and unlocated totals do not reconcile");

  return { zones, stateTotals, nonZip3Volume30Day, unlocatedVolume30Day, reportedStateVolume30Day: stateVolume };
}

export function parseVendorRankings(rows) {
  const report = parseZoneReport(rows);
  return new Map([...report.zones].map(([zoneId, zone]) => [zoneId, {
    volume30Day: zone.volume30Day,
    onTimePct: zone.onTimePct,
    topVendors: zone.topVendors
  }]));
}

function rankZones(zones) {
  const sorted = zones.slice().sort((a, b) => b.volume30Day - a.volume30Day || a.zoneId.localeCompare(b.zoneId));
  sorted.forEach((zone, index) => { zone.volume30DayRank = index + 1; });

  const byState = new Map();
  for (const zone of sorted) {
    if (!byState.has(zone.state)) byState.set(zone.state, []);
    byState.get(zone.state).push(zone);
  }
  for (const stateZones of byState.values()) {
    stateZones.forEach((zone, index) => {
      zone.volume30DayStateRank = index + 1;
      zone.volume30DayStateZoneCount = stateZones.length;
    });
  }
  return sorted;
}

function weightedOnTimePct(zones) {
  const observed = zones.filter((zone) => zone.onTimePct != null);
  const volume = observed.reduce((sum, zone) => sum + zone.volume30Day, 0);
  if (volume <= 0) return null;
  const weighted = observed.reduce((sum, zone) => sum + zone.volume30Day * zone.onTimePct, 0);
  return Number((weighted / volume).toFixed(1));
}

async function loadMapZoneIds(projectRoot) {
  const raw = await fs.readFile(path.join(projectRoot, "public", "data", "coverage_zip3_zones.json"), "utf8");
  const zones = JSON.parse(raw);
  assert(Array.isArray(zones), "Map ZIP3 zone data is invalid");
  return new Set(zones.map((zone) => zone.zoneId).filter(Boolean));
}

async function main() {
  const input = process.argv[2];
  assert(input, "Usage: npm run prepare-vendor-data -- /path/to/report.xlsx");
  const sheets = JSON.parse(execFileSync(process.env.PYTHON_BIN || "python3", ["-c", READ_XLSX, input], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  const period = sheets.Criterios?.find((r) => r.cells.A === "Producao 30d")?.cells.B;
  const match = String(period || "").match(/^(\d{4}-\d{2}-\d{2}) a (\d{4}-\d{2}-\d{2});/);
  assert(match, "Missing reporting period");
  const report = parseZoneReport(sheets["Production Report"]);
  const mapZoneIds = await loadMapZoneIds(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const zones = rankZones([...report.zones.values()].map(({ identifiers, vendors, rowOrder, ...zone }) => zone));
  const matchedZoneIds = new Set(zones.filter((zone) => mapZoneIds.has(zone.zoneId)).map((zone) => zone.zoneId));
  const unmatchedZoneIds = zones.map((zone) => zone.zoneId).filter((zoneId) => !mapZoneIds.has(zoneId));
  const totalVolume30Day = zones.reduce((sum, zone) => sum + zone.volume30Day, 0);
  const matchedVolume30Day = zones.filter((zone) => matchedZoneIds.has(zone.zoneId)).reduce((sum, zone) => sum + zone.volume30Day, 0);
  const periodStart = match[1];
  const periodEnd = match[2];
  const generatedAt = new Date().toISOString();
  const sourceFile = path.basename(input);
  const performance = {
    source: {
      reportWindow: "30 Day",
      sourceFile,
      sheetName: "Production Report",
      periodStart,
      periodEnd,
      generatedAt,
      vendorRanking: "volume30Day descending; onTimePct descending on ties"
    },
    totals: {
      zoneCount: zones.length,
      matchedZoneCount: matchedZoneIds.size,
      unmatchedZoneIds,
      totalVolume30Day,
      weightedOnTimePct: weightedOnTimePct(zones),
      matchedVolume30Day,
      unmatchedVolume30Day: totalVolume30Day - matchedVolume30Day,
      unlocatedVolume30Day: report.unlocatedVolume30Day,
      nonZip3Volume30Day: report.nonZip3Volume30Day,
      reportedStateVolume30Day: report.reportedStateVolume30Day
    },
    zones
  };

  const focusPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/data/secret_focus_zones.json");
  const focusCurrent = JSON.parse(await fs.readFile(focusPath, "utf8"));
  const focusZones = [];
  for (const [zoneId, reportZone] of report.zones) {
    const vendor = reportZone.vendors.find((entry) => entry.vendorCode === "J9OHFI" && entry.volume30Day > 0);
    if (!vendor || !mapZoneIds.has(zoneId)) continue;
    focusZones.push({
      zoneId,
      state: reportZone.state,
      zip3: reportZone.zip3,
      volume30Day: vendor.volume30Day,
      onTimePct: vendor.onTimePct,
      entryCount: 1
    });
  }
  focusZones.sort((a, b) => b.volume30Day - a.volume30Day || a.zoneId.localeCompare(b.zoneId));
  const focusPayload = {
    meta: {
      ...focusCurrent.meta,
      zoneCount: focusZones.length,
      totalVolume30Day: focusZones.reduce((sum, zone) => sum + zone.volume30Day, 0),
      weightedOnTimePct: weightedOnTimePct(focusZones),
      sourceFile,
      sheetName: "Production Report",
      periodStart,
      periodEnd,
      generatedAt
    },
    zones: focusZones
  };

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await fs.writeFile(path.join(projectRoot, "public/data/zone_performance_30day.json"), JSON.stringify(performance) + "\n");
  await fs.writeFile(path.join(projectRoot, "public/data/secret_focus_zones.json"), JSON.stringify(focusPayload) + "\n");
  console.log(`Imported ${zones.length} ZIP3 zones from ${sourceFile} (${periodStart} to ${periodEnd}).`);
  console.log(`Matched map zones: ${matchedZoneIds.size}; unmatched: ${unmatchedZoneIds.length}.`);
  console.log(`30-day volume: ${totalVolume30Day.toLocaleString("en-US")}; weighted OT: ${performance.totals.weightedOnTimePct ?? "N/D"}%.`);
  console.log(`J9OHFI coverage: ${focusZones.length} zones; ${focusPayload.meta.totalVolume30Day.toLocaleString("en-US")} volume.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
