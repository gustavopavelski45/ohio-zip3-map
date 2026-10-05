const PALETTE = [
  "#e7dba0",
  "#bbce9e",
  "#bfb5cf",
  "#a9c5ce",
  "#e9b39b",
  "#d1d9ab",
];

export function zoneColor(zip3, stateCode = "") {
  const seed = [...stateCode].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0,
  );
  return PALETTE[(Number(zip3) * 5 + seed) % PALETTE.length] || PALETTE[0];
}

function ringArea(ring) {
  return Math.abs(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return sum + p[0] * q[1] - q[0] * p[1];
    }, 0),
  );
}

function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

export function inPolygon(point, polygon) {
  return (
    inRing(point, polygon[0]) &&
    !polygon.slice(1).some((ring) => inRing(point, ring))
  );
}

// Use an interior point of the largest island, never the center of an ocean-spanning bounding box.
export function labelPoint(geometry) {
  const polygons =
    geometry?.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry?.coordinates];
  const polygon = polygons
    .filter((p) => p?.[0]?.length)
    .sort((a, b) => ringArea(b[0]) - ringArea(a[0]))[0];
  if (!polygon) return null;
  const ring = polygon[0];
  const bounds = ring.reduce(
    (b, p) => [
      Math.min(b[0], p[0]),
      Math.min(b[1], p[1]),
      Math.max(b[2], p[0]),
      Math.max(b[3], p[1]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  if (inPolygon(center, polygon))
    return { latitude: center[1], longitude: center[0] };
  let best = null,
    bestDistance = Infinity;
  for (let y = 1; y < 20; y++) {
    for (let x = 1; x < 20; x++) {
      const point = [
        bounds[0] + ((bounds[2] - bounds[0]) * x) / 20,
        bounds[1] + ((bounds[3] - bounds[1]) * y) / 20,
      ];
      const distance =
        (point[0] - center[0]) ** 2 + (point[1] - center[1]) ** 2;
      if (distance < bestDistance && inPolygon(point, polygon)) {
        best = point;
        bestDistance = distance;
      }
    }
  }
  return best ? { latitude: best[1], longitude: best[0] } : null;
}

export function overlaps(a, b) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

export function weightedOnTime(zones) {
  const reported = zones.filter(
    (z) =>
      z.hasZonePerformanceData &&
      z.onTimePct != null &&
      Number.isFinite(Number(z.onTimePct)) &&
      z.volume30Day > 0,
  );
  const total = reported.reduce((sum, z) => sum + z.volume30Day, 0);
  return total
    ? reported.reduce((sum, z) => sum + z.volume30Day * z.onTimePct, 0) / total
    : null;
}

export function zoneVolumeLabel(zone) {
  if (
    !zone.hasZonePerformanceData ||
    zone.volume30Day == null ||
    !Number.isFinite(Number(zone.volume30Day))
  ) return "N/D";
  return new Intl.NumberFormat("en-US").format(Math.round(zone.volume30Day));
}

export function zoneOnTimeLabel(zone) {
  const raw = zone.onTimePct;
  const value = Number(raw);
  if (
    !zone.hasZonePerformanceData || raw == null || raw === "" ||
    !Number.isFinite(value) || value < 0 || value > 100
  ) return "N/D";
  return `${value.toFixed(1)}%`;
}

export function productionPeriodLabel(source) {
  const parseDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const start = parseDate(source?.periodStart);
  const end = parseDate(source?.periodEnd);
  if (!start || !end) return null;
  const format = (date, year) => new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", ...(year ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date);
  return `Produção: ${format(start, start.getUTCFullYear() !== end.getUTCFullYear())} a ${format(end, true)}`;
}
