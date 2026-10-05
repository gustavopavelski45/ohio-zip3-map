import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Read values only. Vendor identifiers never leave the importer in public output.
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
                elif kind in ('str', 'e'):
                    value = value.text
                else:
                    value = float(value.text)
                cells[column] = value
            rows.append({'row': int(row.attrib['r']), 'cells': cells})
        sheets[sheet.attrib['name']] = rows
    print(json.dumps(sheets))
`;

export function parseVendorRankings(rows) {
  assert.equal(rows[0]?.cells.B, "30 Day Vol", "Expected 30-day volume column");
  assert(["OT%", "OT% 30d"].includes(rows[0]?.cells.C), "Expected 30-day on-time column");
  const groups = new Map();
  let state = null;
  let group = null;
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
      group = null;
      continue;
    }
    const header = label.match(/^([A-Z]{2})\s+(Z?\d+|NO_ZONE)$/);
    if (header) {
      group = null;
      assert.equal(header[1], state, `Unexpected state at row ${row}`);
      const zip3 = header[2].replace(/^Z/, "");
      if (!/^\d{3}$/.test(zip3)) continue;
      const zoneId = `${state}-${zip3}`;
      assert(!groups.has(zoneId), `Duplicate zone at row ${row}`);
      group = { ...metrics(cells, row), vendors: [], identifiers: new Set() };
      groups.set(zoneId, group);
      continue;
    }
    if (!group) continue;
    const identifier = label.replace(/\s+\(novo\)$/i, "");
    assert(!group.identifiers.has(identifier), `Duplicate vendor at row ${row}`);
    group.identifiers.add(identifier);
    group.vendors.push(metrics(cells, row));
  }
  return new Map([...groups].map(([zoneId, entry]) => {
    assert.equal(entry.vendors.reduce((sum, v) => sum + v.volume30Day, 0), entry.volume30Day, `Vendor total mismatch: ${zoneId}`);
    const topVendors = entry.vendors
      .filter((v) => v.volume30Day > 0)
      .sort((a, b) => b.volume30Day - a.volume30Day || (b.onTimePct ?? -1) - (a.onTimePct ?? -1))
      .slice(0, 3)
      .map((vendor, index) => ({ rank: index + 1, ...vendor }));
    return [zoneId, { volume30Day: entry.volume30Day, onTimePct: entry.onTimePct, topVendors }];
  }));
}

async function main() {
  const input = process.argv[2];
  assert(input, "Usage: npm run prepare-vendor-data -- /path/to/report.xlsx");
  const dataPath = new URL("../public/data/zone_performance_30day.json", import.meta.url);
  const performance = JSON.parse(await fs.readFile(dataPath, "utf8"));
  assert.equal(path.basename(input), performance.source.sourceFile, "Update the zone report first; source files must match");
  const sheets = JSON.parse(execFileSync(process.env.PYTHON_BIN || "python3", ["-c", READ_XLSX, input], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  const period = sheets.Criterios?.find((r) => r.cells.A === "Producao 30d")?.cells.B;
  const match = String(period || "").match(/^(\d{4}-\d{2}-\d{2}) a (\d{4}-\d{2}-\d{2});/);
  assert(match, "Missing reporting period");
  assert.equal(match[1], performance.source.periodStart);
  assert.equal(match[2], performance.source.periodEnd);
  const rankings = parseVendorRankings(sheets["Production Report"]);
  assert.equal(rankings.size, performance.zones.length, "Zone count differs from the current report");
  for (const zone of performance.zones) {
    const ranking = rankings.get(zone.zoneId);
    assert(ranking, `Missing zone ${zone.zoneId}`);
    assert.equal(ranking.volume30Day, zone.volume30Day, zone.zoneId);
    assert.equal(ranking.onTimePct, zone.onTimePct, zone.zoneId);
    zone.topVendors = ranking.topVendors;
  }
  performance.source.vendorRanking = "volume30Day descending; onTimePct descending on ties";
  await fs.writeFile(dataPath, JSON.stringify(performance) + "\n");
  console.log(`Updated anonymous vendor rankings for ${rankings.size} zones.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
