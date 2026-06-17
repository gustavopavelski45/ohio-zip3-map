const map = L.map("map", {
  zoomControl: false,
  preferCanvas: true
});

const DATA_VERSION = "all-us-v11";

L.control.zoom({ position: "topright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

function createMapPane(name, zIndex, pointerEvents = "auto") {
  const pane = map.createPane(name);
  pane.style.zIndex = String(zIndex);
  pane.style.pointerEvents = pointerEvents;
  return pane;
}

createMapPane("county-fill-pane", 380);
createMapPane("zip3-pane", 430);
createMapPane("county-outline-pane", 470, "none");
createMapPane("zip3-glow-pane", 482, "none");
createMapPane("primary-county-pane", 490, "none");

const countyFillRenderer = L.canvas({ pane: "county-fill-pane", padding: 0.5 });
const zip3Renderer = L.canvas({ pane: "zip3-pane", padding: 0.5 });
const countyOutlineRenderer = L.canvas({ pane: "county-outline-pane", padding: 0.5 });
const zip3GlowRenderer = L.canvas({ pane: "zip3-glow-pane", padding: 0.5 });
const primaryCountyRenderer = L.canvas({ pane: "primary-county-pane", padding: 0.5 });

map.setView([40.2, -79.2], 6);
map.on("zoomend moveend", () => {
  renderCountyLabels();
});

const zip3LayerGroup = L.layerGroup().addTo(map);
const cityLayerGroup = L.layerGroup().addTo(map);
const countyLabelLayerGroup = L.layerGroup().addTo(map);

const state = {
  selectedZoneId: null,
  mode: "population",
  hasMortgageData: false,
  hasCfpbDistressData: false,
  hasZonePerformanceData: false,
  mortgageYear: null,
  zonePerformanceTotals: null,
  zones: [],
  cities: [],
  states: [],
  counties: [],
  countyLabelPoints: [],
  activeZoneIds: new Set(),
  zoneById: new Map(),
  countyByFips: new Map(),
  countyFeatureByFips: new Map(),
  boundsByZoneId: new Map(),
  zoneLayer: null,
  zoneGlowLayer: null,
  countyLayer: null,
  countyOutlineLayer: null,
  primaryCountyLayer: null,
  filter: "",
  filters: {
    scoreMin: "",
    scoreMax: "",
    volume30DayMin: "",
    volume30DayMax: "",
    mortgageLoansMin: "",
    housingMin: ""
  },
  mapShowsFilteredZones: true,
  mapLayerMode: "zip3",
  popupMode: "summary",
  showCities: true,
  showZip3Labels: true,
  showCountyLabels: true,
  highlightHotspots: true,
  totalCountyFeatureCount: 0,
  totalZoneFeatureCount: 0
};

const filterInput = document.querySelector("#zip3-filter");
const modeSelect = document.querySelector("#analysis-mode");
const layerModeSelect = document.querySelector("#map-layer-mode");
const popupModeSelect = document.querySelector("#popup-mode");
const scoreMinInput = document.querySelector("#score-min");
const scoreMaxInput = document.querySelector("#score-max");
const volume30DayMinInput = document.querySelector("#volume-30day-min");
const volume30DayMaxInput = document.querySelector("#volume-30day-max");
const mortgageLoansMinInput = document.querySelector("#mortgage-loans-min");
const housingMinInput = document.querySelector("#housing-min");
const resetFiltersButton = document.querySelector("#reset-filters");
const modeHintEl = document.querySelector("#analysis-mode-hint");
const filterSummaryEl = document.querySelector("#filter-summary");
const toggleCitiesInput = document.querySelector("#toggle-cities");
const toggleZip3LabelsInput = document.querySelector("#toggle-zip3-labels");
const toggleCountyLabelsInput = document.querySelector("#toggle-county-labels");
const toggleHotspotsInput = document.querySelector("#toggle-hotspots");
const toggleFilteredMapInput = document.querySelector("#toggle-filtered-map");
const zoneListEl = document.querySelector("#zone-list");
const statsEl = document.querySelector("#stats");
const selectionDetailsEl = document.querySelector("#selection-details");
const legendLayerSwatchEl = document.querySelector(".legend .swatch:not(.hotspot)");
const legendLayerLabelEl = document.querySelector("#legend-layer-label");
const legendHotspotLabelEl = document.querySelector("#legend-hotspot-label");

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "N/D";
  }

  return new Intl.NumberFormat("en-US").format(Math.round(numericValue));
}

function formatCurrency(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "N/D";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(Math.round(numericValue));
}

function formatRank(rankValue, totalValue) {
  const rank = Number(rankValue);
  const total = Number(totalValue);
  if (!Number.isFinite(rank) || !Number.isFinite(total) || total <= 0) {
    return "N/D";
  }

  return `#${rank}/${total}`;
}

function formatScore(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "N/D";
  }

  return `${numericValue.toFixed(1)}/100`;
}

function formatPercent(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "N/D";
  }

  return `${numericValue.toFixed(2)}%`;
}

function parseFilterNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const numericValue = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(numericValue) ? numericValue : null;
}

function getNumericFilter(key) {
  return parseFilterNumber(state.filters[key]);
}

function topZipSummary(zone) {
  if (!zone || !zone.topZip5 || !Number.isFinite(Number(zone.topZipPopulation)) || zone.topZipPopulation <= 0) {
    return "N/D";
  }

  const cityPart = zone.topZipCity ? ` • ${zone.topZipCity}` : "";
  return `${zone.topZip5}${cityPart} • ${formatNumber(zone.topZipPopulation)} hab`;
}

function topHousingSummary(zone) {
  if (
    !zone ||
    !zone.topHousingZip5 ||
    !Number.isFinite(Number(zone.topHousingUnitsEstimate)) ||
    zone.topHousingUnitsEstimate <= 0
  ) {
    return "N/D";
  }

  const cityPart = zone.topHousingCity ? ` • ${zone.topHousingCity}` : "";
  return `${zone.topHousingZip5}${cityPart} • ${formatNumber(zone.topHousingUnitsEstimate)} casas (estimado)`;
}

function primaryZipSummary(zone) {
  if (!zone || !zone.topZip5) {
    return "N/D";
  }

  return zone.topZipCity ? `${zone.topZip5} • ${zone.topZipCity}` : zone.topZip5;
}

function primaryCountySummary(zone) {
  if (!zone || !zone.primaryCountyFips) {
    return zone?.primaryCountyName ? `${zone.primaryCountyName} County` : "N/D";
  }

  const county = state.countyByFips.get(zone.primaryCountyFips);
  if (county?.label) {
    return county.label;
  }

  return zone.primaryCountyName ? `${zone.primaryCountyName} County` : zone.primaryCountyFips;
}

function opportunityScoreForFilter(zone) {
  const score = Number(zone?.mortgageOpportunityScore);
  return Number.isFinite(score) ? score : null;
}

function volume30DayForFilter(zone) {
  const volume = Number(zone?.volume30Day);
  return Number.isFinite(volume) ? volume : null;
}

function mortgageLoansForFilter(zone) {
  const loans = Number(zone?.mortgageOriginationsCount);
  return Number.isFinite(loans) ? loans : null;
}

function housingForFilter(zone) {
  const houses = Number(zone?.housingUnitsEstimate);
  return Number.isFinite(houses) ? houses : null;
}

function metricInRange(value, minValue, maxValue) {
  if (minValue !== null && (value === null || value < minValue)) {
    return false;
  }

  if (maxValue !== null && (value === null || value > maxValue)) {
    return false;
  }

  return true;
}

function normalizeZoneId(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replaceAll(" ", "");
}

function normalizeZip3(value) {
  return String(value || "").trim().padStart(3, "0");
}

function includeCoordinateInBounds(bounds, coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return;
  }

  const lng = Number(coordinate[0]);
  const lat = Number(coordinate[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return;
  }

  bounds.minLat = Math.min(bounds.minLat, lat);
  bounds.maxLat = Math.max(bounds.maxLat, lat);
  bounds.minLng = Math.min(bounds.minLng, lng);
  bounds.maxLng = Math.max(bounds.maxLng, lng);
}

function walkCoordinates(coordinates, bounds) {
  if (!Array.isArray(coordinates)) {
    return;
  }

  if (coordinates.length > 0 && typeof coordinates[0] === "number") {
    includeCoordinateInBounds(bounds, coordinates);
    return;
  }

  for (const entry of coordinates) {
    walkCoordinates(entry, bounds);
  }
}

function geometryCenter(geometry) {
  const bounds = {
    minLat: Infinity,
    maxLat: -Infinity,
    minLng: Infinity,
    maxLng: -Infinity
  };

  walkCoordinates(geometry?.coordinates, bounds);

  if (!Number.isFinite(bounds.minLat) || !Number.isFinite(bounds.minLng)) {
    return null;
  }

  return {
    latitude: (bounds.minLat + bounds.maxLat) / 2,
    longitude: (bounds.minLng + bounds.maxLng) / 2
  };
}

function colorForZone(zone) {
  const zip3Number = Number.parseInt(zone.zip3, 10);
  const stateSeed = zone.state.charCodeAt(0) + zone.state.charCodeAt(1);
  const hue = Number.isFinite(zip3Number) ? (zip3Number * 31 + stateSeed * 11) % 360 : 210;
  return `hsl(${hue}, 72%, 50%)`;
}

const COUNTY_FILL_COLORS = [
  "#67e8f9",
  "#99f6e4",
  "#a7f3d0",
  "#fde68a",
  "#fed7aa",
  "#bfdbfe",
  "#c4b5fd",
  "#fecdd3"
];

function hashText(value) {
  return String(value || "")
    .split("")
    .reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0);
}

function colorForCounty(feature) {
  const props = feature?.properties || {};
  const key = props.countyFips || `${props.state || ""}-${props.countyName || ""}`;
  const index = Math.abs(hashText(key)) % COUNTY_FILL_COLORS.length;
  return COUNTY_FILL_COLORS[index];
}

function isWorkZone(zoneId) {
  return state.activeZoneIds.has(zoneId);
}

function zonePassesActiveFilters(zone) {
  if (!zone || !isWorkZone(zone.zoneId)) {
    return false;
  }

  const query = state.filter.trim().toLowerCase();
  if (!zoneMatchesFilter(zone, query)) {
    return false;
  }

  const scoreMin = getNumericFilter("scoreMin");
  const scoreMax = getNumericFilter("scoreMax");
  if (!metricInRange(opportunityScoreForFilter(zone), scoreMin, scoreMax)) {
    return false;
  }

  const volumeMin = getNumericFilter("volume30DayMin");
  const volumeMax = getNumericFilter("volume30DayMax");
  if (!metricInRange(volume30DayForFilter(zone), volumeMin, volumeMax)) {
    return false;
  }

  const mortgageLoansMin = getNumericFilter("mortgageLoansMin");
  if (!metricInRange(mortgageLoansForFilter(zone), mortgageLoansMin, null)) {
    return false;
  }

  const housingMin = getNumericFilter("housingMin");
  if (!metricInRange(housingForFilter(zone), housingMin, null)) {
    return false;
  }

  return true;
}

function isListedZone(zone) {
  return zonePassesActiveFilters(zone);
}

function isMapVisibleZone(zone) {
  if (!zone || !isWorkZone(zone.zoneId)) {
    return false;
  }

  return state.mapShowsFilteredZones ? zonePassesActiveFilters(zone) : true;
}

function isActiveZone(zoneId) {
  const zone = state.zoneById.get(zoneId);
  return isMapVisibleZone(zone);
}

function shouldShowZip3Layer() {
  return state.mapLayerMode === "zip3" || state.mapLayerMode === "both";
}

function shouldShowCountyLayer() {
  return state.mapLayerMode === "counties" || state.mapLayerMode === "both";
}

function shouldShowCountyOutlineLayer() {
  return state.mapLayerMode === "both";
}

function isMortgageMode() {
  return state.mode === "mortgage" && state.hasMortgageData;
}

function isDelinquencyMode() {
  return state.mode === "delinquency" && state.hasMortgageData;
}

function isCfpbDelinquencyMode() {
  return state.mode === "cfpb-delinquency" && state.hasCfpbDistressData;
}

function isZonePerformanceMode() {
  return state.mode === "zone-performance" && state.hasZonePerformanceData;
}

function isZoneHotspot(zone) {
  if (!zone) {
    return false;
  }

  if (isCfpbDelinquencyMode()) {
    return Boolean(zone.isCfpbDistressHotspot);
  }

  if (isZonePerformanceMode()) {
    return Boolean(zone.isZonePerformanceHotspot);
  }

  if (isDelinquencyMode()) {
    return Boolean(zone.isDelinquencyHotspot);
  }

  if (isMortgageMode()) {
    return Boolean(zone.isMortgageOpportunityHotspot);
  }

  return Boolean(zone.isPopulationHotspot);
}

function styleForFeature(feature) {
  const zoneId = feature.properties.zoneId;
  const zone = state.zoneById.get(zoneId);
  const isSelected = state.selectedZoneId === zoneId;
  const hasSelection = Boolean(state.selectedZoneId);
  const isActive = isActiveZone(zoneId);
  const isMuted = hasSelection && !isSelected;
  const isHotspot = state.highlightHotspots && isZoneHotspot(zone);

  if (!zone || !isActive) {
    return {
      color: "#9db0d2",
      weight: 0.6,
      opacity: 0.3,
      fillColor: "#c8d5ea",
      fillOpacity: 0.04
    };
  }

  if (isSelected) {
    return {
      color: "#3b1812",
      weight: 2.8,
      opacity: 1,
      fillColor: colorForZone(zone),
      fillOpacity: 0.42,
      dashArray: null
    };
  }

  if (isMuted) {
    return {
      color: "#b9c6dc",
      weight: 0.45,
      opacity: 0.12,
      fillColor: colorForZone(zone),
      fillOpacity: 0.015,
      dashArray: null
    };
  }

  if (isHotspot) {
    return {
      color: "#92400e",
      weight: 1.6,
      opacity: 0.88,
      fillColor: colorForZone(zone),
      fillOpacity: 0.5,
      dashArray: "4,3"
    };
  }

  return {
    color: "#1d2d45",
    weight: 0.7,
    opacity: 0.6,
    fillColor: colorForZone(zone),
    fillOpacity: 0.22,
    dashArray: null
  };
}

function styleForZip3GlowFeature(feature) {
  const zoneId = feature.properties.zoneId;
  const zone = state.zoneById.get(zoneId);
  const isSelected = state.selectedZoneId === zoneId;
  const hasSelection = Boolean(state.selectedZoneId);
  const isActive = isActiveZone(zoneId);
  const isMuted = hasSelection && !isSelected;
  const isHotspot = state.highlightHotspots && isZoneHotspot(zone);

  if (!zone || !isActive) {
    return {
      color: "#67e8f9",
      weight: 0,
      opacity: 0,
      fillOpacity: 0,
      interactive: false
    };
  }

  if (isSelected) {
    return {
      color: "#39ff14",
      weight: 7.5,
      opacity: 0.96,
      fillOpacity: 0,
      dashArray: null,
      interactive: false
    };
  }

  if (isMuted) {
    return {
      color: "#22d3ee",
      weight: 1.6,
      opacity: 0.22,
      fillOpacity: 0,
      dashArray: null,
      interactive: false
    };
  }

  if (isHotspot) {
    return {
      color: "#faff00",
      weight: 5.2,
      opacity: 0.82,
      fillOpacity: 0,
      dashArray: "1,5",
      interactive: false
    };
  }

  return {
    color: "#00e5ff",
    weight: 3.4,
    opacity: 0.74,
    fillOpacity: 0,
    dashArray: null,
    interactive: false
  };
}

function styleForCountyFeature(feature) {
  const isCombined = state.mapLayerMode === "both";

  return {
    color: isCombined ? "#042f2e" : "#0f766e",
    weight: isCombined ? 1.05 : 1.35,
    opacity: isCombined ? 0.72 : 0.9,
    fillColor: colorForCounty(feature),
    fillOpacity: isCombined ? 0.16 : 0.34,
    dashArray: isCombined ? "8,5" : "6,3",
    lineJoin: "round"
  };
}

function styleForCountyOutlineFeature() {
  const isCombined = state.mapLayerMode === "both";

  return {
    color: isCombined ? "#111827" : "#115e59",
    weight: isCombined ? 2.15 : 1.55,
    opacity: isCombined ? 0.78 : 0.95,
    fillOpacity: 0,
    dashArray: isCombined ? "7,4" : "5,4",
    interactive: false
  };
}

function styleForPrimaryCountyFeature() {
  return {
    color: "#7c2d12",
    weight: 4,
    opacity: 0.98,
    fillColor: "#facc15",
    fillOpacity: 0.12,
    dashArray: "2,3",
    interactive: false
  };
}

function cityPreview(cities, limit = 5) {
  if (!cities || cities.length === 0) {
    return "Sem cidade associada";
  }

  if (cities.length <= limit) {
    return cities.join(", ");
  }

  return `${cities.slice(0, limit).join(", ")} +${cities.length - limit}`;
}

function mortgageSummaryBlock(zone) {
  if (!zone.hasMortgageData) {
    return "Dados de mortgage indisponiveis";
  }

  const stateMortgageRank = formatRank(zone.mortgageStateRank, zone.mortgageStateZoneCount);
  return `
    Mortgage (${escapeHtml(zone.mortgageYear)}): <strong>${formatNumber(zone.mortgageOriginationsCount)}</strong> loans<br/>
    Volume estimado: <strong>${escapeHtml(formatCurrency(zone.mortgageOriginationsAmount))}</strong><br/>
    Rank mortgage: #${formatNumber(zone.mortgageVolumeRank)} (geral) • ${escapeHtml(stateMortgageRank)} (estado)<br/>
    Score oportunidade: <strong>${escapeHtml(formatScore(zone.mortgageOpportunityScore))}</strong> • rank #${formatNumber(zone.mortgageOpportunityRank)}
  `;
}

function delinquencySummaryBlock(zone) {
  if (!zone.hasMortgageData) {
    return "Proxy de delinquency indisponivel";
  }

  const stateDelinquencyRank = formatRank(zone.delinquencyEstimatedStateRank, zone.delinquencyStateZoneCount);
  return `
    Proxy delinquency: <strong>${formatNumber(zone.estimatedDelinquentLoans)}</strong> loans<br/>
    Volume proxy: <strong>${escapeHtml(formatCurrency(zone.estimatedDelinquentVolume))}</strong><br/>
    Taxa estimada: <strong>${escapeHtml(formatPercent(zone.estimatedDelinquencyRatePct))}</strong> • risco ${escapeHtml(formatScore(zone.delinquencyRiskScore))}<br/>
    Rank delinquency: #${formatNumber(zone.delinquencyEstimatedRank)} (geral) • ${escapeHtml(stateDelinquencyRank)} (estado)
  `;
}

function cfpbDelinquencySummaryBlock(zone) {
  if (!zone.hasCfpbDistressData) {
    return "Sinal gratis CFPB indisponivel";
  }

  const stateRank = formatRank(zone.cfpbDistressStateRank, zone.cfpbDistressStateZoneCount);
  const rangeLabel = zone.cfpbDistressLookbackMonths
    ? `${formatNumber(zone.cfpbDistressLookbackMonths)}m`
    : "janela ativa";
  const latestLabel = zone.cfpbDistressLatestComplaintDate || zone.cfpbDistressLastUpdated || "N/D";

  return `
    CFPB atraso (${escapeHtml(rangeLabel)}): <strong>${formatNumber(zone.cfpbDistressComplaintCount)}</strong> complaints<br/>
    Nao pontuais: <strong>${formatNumber(zone.cfpbDistressUntimelyCount)}</strong> (${escapeHtml(formatPercent(zone.cfpbDistressUntimelySharePct))}) • ${escapeHtml(formatNumber(zone.cfpbDistressComplaintsPer100k))}/100k hab<br/>
    Score atraso: <strong>${escapeHtml(formatScore(zone.cfpbDistressScore))}</strong> • rank #${formatNumber(zone.cfpbDistressRank)} (geral) • ${escapeHtml(stateRank)} (estado)<br/>
    Ultimo registro: ${escapeHtml(latestLabel)}
  `;
}

function zonePerformanceSummaryBlock(zone) {
  if (!zone.hasZonePerformanceData) {
    return "30 dias / OT%: sem dado para esta zona";
  }

  const stateRank = formatRank(zone.volume30DayStateRank, zone.volume30DayStateZoneCount);
  return `
    30 dias: <strong>${formatNumber(zone.volume30Day)}</strong> volume<br/>
    On-time: <strong>${escapeHtml(formatPercent(zone.onTimePct))}</strong><br/>
    Rank volume: #${formatNumber(zone.volume30DayRank)} (geral) • ${escapeHtml(stateRank)} (estado)
  `;
}

function formatSummaryPopup(zone) {
  const onTimeLabel = zone.hasZonePerformanceData ? formatPercent(zone.onTimePct) : "N/D";
  const volumeLabel = zone.hasZonePerformanceData ? formatNumber(zone.volume30Day) : "N/D";

  return `
    <strong>${escapeHtml(zone.label)}</strong><br/>
    Estado: <strong>${escapeHtml(zone.stateName)} (${escapeHtml(zone.state)})</strong><br/>
    Zona: <strong>${escapeHtml(zone.label)}</strong><br/>
    ZIP principal: <strong>${escapeHtml(primaryZipSummary(zone))}</strong><br/>
    On-time: <strong>${escapeHtml(onTimeLabel)}</strong><br/>
    Volume 30 dias: <strong>${escapeHtml(volumeLabel)}</strong><br/>
    County principal: <strong>${escapeHtml(primaryCountySummary(zone))}</strong>
  `;
}

function formatPopup(feature) {
  const zone = state.zoneById.get(feature.properties.zoneId);
  if (!zone) {
    return "Zona indisponivel";
  }

  if (state.popupMode === "summary") {
    return formatSummaryPopup(zone);
  }

  const hotspotLabel = isZoneHotspot(zone) ? "Sim" : "Nao";
  const stateRankLabel = formatRank(zone.statePopulationRank, zone.stateZoneCount);
  const topZipLabel = topZipSummary(zone);
  const topHousingLabel = topHousingSummary(zone);

  return `
    <strong>${escapeHtml(zone.label)}</strong><br/>
    Estado: <strong>${escapeHtml(zone.stateName)} (${escapeHtml(zone.state)})</strong><br/>
    ZIP5 na zona: ${formatNumber(zone.zipCount)}<br/>
    Populacao estimada: <strong>${formatNumber(zone.population)}</strong><br/>
    Casas estimadas: <strong>${formatNumber(zone.housingUnitsEstimate)}</strong><br/>
    Rank populacional: #${formatNumber(zone.populationRank)} • estado ${escapeHtml(stateRankLabel)}<br/>
    ZIP lider (pop): <strong>${escapeHtml(topZipLabel)}</strong><br/>
    ZIP com mais casas: <strong>${escapeHtml(topHousingLabel)}</strong><br/>
    ${mortgageSummaryBlock(zone)}<br/>
    ${delinquencySummaryBlock(zone)}<br/>
    ${cfpbDelinquencySummaryBlock(zone)}<br/>
    ${zonePerformanceSummaryBlock(zone)}<br/>
    Hotspot ativo no modo atual: ${hotspotLabel}<br/>
    <small>${escapeHtml(cityPreview(zone.cities, 7))}</small>
  `;
}

function formatCountyPopup(feature) {
  const props = feature.properties || {};
  const countyName = props.countyName || "County";
  const adminType = props.adminType || "County";
  const stateCode = props.state || "N/D";
  const countyFips = props.countyFips || "N/D";

  return `
    <strong>${escapeHtml(countyName)} ${escapeHtml(adminType)}</strong><br/>
    Estado: <strong>${escapeHtml(stateCode)}</strong><br/>
    FIPS county: ${escapeHtml(countyFips)}
  `;
}

function refreshStyles() {
  if (state.countyLayer) {
    state.countyLayer.setStyle(styleForCountyFeature);
  }

  if (state.countyOutlineLayer) {
    state.countyOutlineLayer.setStyle(styleForCountyOutlineFeature);
  }

  if (state.primaryCountyLayer) {
    state.primaryCountyLayer.setStyle(styleForPrimaryCountyFeature);
  }

  if (state.zoneLayer) {
    state.zoneLayer.setStyle(styleForFeature);
    bringSelectionToFront();
  }

  if (state.zoneGlowLayer) {
    state.zoneGlowLayer.setStyle(styleForZip3GlowFeature);
  }
}

function setLayerVisible(layer, visible) {
  if (!layer) {
    return;
  }

  const isVisible = map.hasLayer(layer);
  if (visible && !isVisible) {
    layer.addTo(map);
  } else if (!visible && isVisible) {
    layer.removeFrom(map);
  }
}

function bringLayerToFront(layer) {
  if (!layer?.eachLayer) {
    return;
  }

  layer.eachLayer((entry) => {
    if (entry?.bringToFront) {
      entry.bringToFront();
    }
  });
}

function refreshLayerLegendText() {
  if (!legendLayerLabelEl) {
    return;
  }

  if (legendLayerSwatchEl) {
    legendLayerSwatchEl.classList.toggle("county", state.mapLayerMode === "counties");
    legendLayerSwatchEl.classList.toggle("combined", state.mapLayerMode === "both");
  }

  if (state.mapLayerMode === "counties") {
    legendLayerLabelEl.textContent = "County colorido";
    return;
  }

  if (state.mapLayerMode === "both") {
    legendLayerLabelEl.textContent = "ZIP3 neon + counties";
    return;
  }

  legendLayerLabelEl.textContent = "Zona ZIP3 neon";
}

function refreshLayerVisibility() {
  refreshStyles();
  setLayerVisible(state.countyLayer, shouldShowCountyLayer());
  setLayerVisible(state.countyOutlineLayer, shouldShowCountyOutlineLayer());
  setLayerVisible(state.zoneLayer, shouldShowZip3Layer());
  setLayerVisible(state.zoneGlowLayer, shouldShowZip3Layer());

  if (shouldShowZip3Layer()) {
    bringLayerToFront(state.zoneLayer);
    bringLayerToFront(state.zoneGlowLayer);
  }

  if (shouldShowCountyOutlineLayer()) {
    bringLayerToFront(state.countyOutlineLayer);
  } else if (shouldShowCountyLayer()) {
    bringLayerToFront(state.countyLayer);
  }

  refreshLayerLegendText();
  renderCountyLabels();
  renderZip3Labels();
  renderCityLabels();
}

function bringSelectionToFront() {
  if (!state.zoneLayer || !state.selectedZoneId) {
    return;
  }

  state.zoneLayer.eachLayer((layer) => {
    if (layer?.feature?.properties?.zoneId === state.selectedZoneId) {
      layer.bringToFront();
    }
  });
}

function clearPrimaryCountyHighlight() {
  if (state.primaryCountyLayer && map.hasLayer(state.primaryCountyLayer)) {
    map.removeLayer(state.primaryCountyLayer);
  }

  state.primaryCountyLayer = null;
}

function refreshPrimaryCountyHighlight() {
  clearPrimaryCountyHighlight();

  const zone = state.zoneById.get(state.selectedZoneId);
  if (!zone?.primaryCountyFips) {
    return;
  }

  const countyFeature = state.countyFeatureByFips.get(zone.primaryCountyFips);
  if (!countyFeature) {
    return;
  }

  state.primaryCountyLayer = L.geoJSON(countyFeature, {
    renderer: primaryCountyRenderer,
    interactive: false,
    style: styleForPrimaryCountyFeature
  }).addTo(map);
}

function getActiveZones() {
  return state.zones.filter(isListedZone);
}

function refreshModeText() {
  if (!modeHintEl) {
    return;
  }

  if (isZonePerformanceMode()) {
    modeHintEl.textContent = "Modo 30 dias / OT%: volume operacional por zona e percentual on-time, sem codigos de vendor.";
    if (legendHotspotLabelEl) {
      legendHotspotLabelEl.textContent = "Hotspot de volume 30 dias";
    }
    return;
  }

  if (isCfpbDelinquencyMode()) {
    modeHintEl.textContent = "Modo Atraso (CFPB gratis): sinal por reclamacoes de dificuldade de pagamento e problemas no processamento.";
    if (legendHotspotLabelEl) {
      legendHotspotLabelEl.textContent = "Hotspot de atraso (CFPB)";
    }
    return;
  }

  if (isDelinquencyMode()) {
    modeHintEl.textContent = "Modo Delinquency Proxy: estimativa de inadimplencia por volume, composicao e intensidade local.";
    if (legendHotspotLabelEl) {
      legendHotspotLabelEl.textContent = "Hotspot de delinquency proxy";
    }
    return;
  }

  if (isMortgageMode()) {
    modeHintEl.textContent = "Modo Mortgage: destaque por score de oportunidade e volume estimado de loans.";
    if (legendHotspotLabelEl) {
      legendHotspotLabelEl.textContent = "Hotspot de oportunidade mortgage";
    }
    return;
  }

  if (state.mode === "mortgage" && !state.hasMortgageData) {
    modeHintEl.textContent = "Dados de mortgage ainda nao disponiveis. Rode: npm run prepare-mortgage-data && npm run prepare-data";
  } else if (state.mode === "cfpb-delinquency" && !state.hasCfpbDistressData) {
    modeHintEl.textContent = "Sinal CFPB ainda nao disponivel. Rode: npm run prepare-cfpb-data && npm run prepare-data";
  } else if (state.mode === "zone-performance" && !state.hasZonePerformanceData) {
    modeHintEl.textContent = "Dados 30 dias / OT% ainda nao disponiveis. Rode: npm run prepare-zone-performance-data -- arquivo.txt";
  } else {
    modeHintEl.textContent = "Modo Populacao: destaque automatico para zonas mais populosas.";
  }

  if (legendHotspotLabelEl) {
    legendHotspotLabelEl.textContent = "Hotspot populacional";
  }
}

function activeFilterDescriptions() {
  const descriptions = [];

  if (state.filter.trim()) {
    descriptions.push(`busca "${state.filter.trim()}"`);
  }

  const scoreMin = getNumericFilter("scoreMin");
  const scoreMax = getNumericFilter("scoreMax");
  if (scoreMin !== null || scoreMax !== null) {
    descriptions.push(`score ${scoreMin ?? "min"} a ${scoreMax ?? "max"}`);
  }

  const volumeMin = getNumericFilter("volume30DayMin");
  const volumeMax = getNumericFilter("volume30DayMax");
  if (volumeMin !== null || volumeMax !== null) {
    descriptions.push(`volume 30d ${volumeMin ?? "min"} a ${volumeMax ?? "max"}`);
  }

  const mortgageLoansMin = getNumericFilter("mortgageLoansMin");
  if (mortgageLoansMin !== null) {
    descriptions.push(`mortgage loans >= ${mortgageLoansMin}`);
  }

  const housingMin = getNumericFilter("housingMin");
  if (housingMin !== null) {
    descriptions.push(`casas >= ${housingMin}`);
  }

  return descriptions;
}

function refreshFilterSummary() {
  if (!filterSummaryEl) {
    return;
  }

  const workZoneCount = state.zones.filter((zone) => isWorkZone(zone.zoneId)).length;
  const filteredZoneCount = getActiveZones().length;
  const descriptions = activeFilterDescriptions();
  const mapMode = state.mapShowsFilteredZones ? "Mapa mostrando apenas filtradas" : "Mapa mostrando todas ativas";

  if (descriptions.length === 0) {
    filterSummaryEl.textContent = `${mapMode}. ${filteredZoneCount}/${workZoneCount} zonas na lista.`;
    return;
  }

  filterSummaryEl.textContent = `${mapMode}. ${filteredZoneCount}/${workZoneCount} zonas: ${descriptions.join(" • ")}.`;
}

function refreshSelectionDetails() {
  if (!selectionDetailsEl) {
    return;
  }

  const zone = state.zoneById.get(state.selectedZoneId);
  if (!zone) {
    const filteredZoneCount = getActiveZones().length;
    selectionDetailsEl.innerHTML = `
      <strong>Decisao visual</strong><br/>
      Selecione uma zona para ver o county principal, ZIP principal, score, volume e casas.<br/>
      <span>${formatNumber(filteredZoneCount)} zonas passam nos filtros atuais.</span>
    `;
    return;
  }

  const volumeLabel = zone.hasZonePerformanceData ? `${formatNumber(zone.volume30Day)} vol 30d` : "Volume 30d N/D";
  const onTimeLabel = zone.hasZonePerformanceData ? `OT ${escapeHtml(formatPercent(zone.onTimePct))}` : "OT N/D";
  const countyLabel = primaryCountySummary(zone);

  selectionDetailsEl.innerHTML = `
    <strong>Zona escolhida: ${escapeHtml(zone.label)}</strong><br/>
    County principal: <strong>${escapeHtml(countyLabel)}</strong><br/>
    ZIP principal: <strong>${escapeHtml(primaryZipSummary(zone))}</strong><br/>
    Score oportunidade: <strong>${escapeHtml(formatScore(zone.mortgageOpportunityScore))}</strong> • Mortgage: <strong>${formatNumber(zone.mortgageOriginationsCount)}</strong> loans<br/>
    ${escapeHtml(volumeLabel)} • ${onTimeLabel} • Casas: <strong>${formatNumber(zone.housingUnitsEstimate)}</strong>
  `;
}

function refreshDecisionPanel() {
  refreshFilterSummary();
  refreshSelectionDetails();
}

function refreshStats() {
  const activeZones = getActiveZones();
  const activeZoneCount = activeZones.length;
  const activeStates = new Set(activeZones.map((zone) => zone.state));
  const hotspotCount = activeZones.filter((zone) => isZoneHotspot(zone)).length;

  if (isZonePerformanceMode()) {
    const zonesWithData = activeZones.filter((zone) => zone.hasZonePerformanceData);
    const statesWithData = new Set(zonesWithData.map((zone) => zone.state));
    const totalVolume = zonesWithData.reduce((sum, zone) => sum + (zone.volume30Day || 0), 0);
    const weightedOt =
      totalVolume > 0
        ? zonesWithData.reduce((sum, zone) => sum + (zone.volume30Day || 0) * (zone.onTimePct || 0), 0) / totalVolume
        : null;

    if (!state.selectedZoneId) {
      statsEl.innerHTML = `${zonesWithData.length} zonas com dado 30 dias em ${statesWithData.size} estados<br/>` +
        `${formatNumber(totalVolume)} volume 30 dias • OT ponderado ${escapeHtml(formatPercent(weightedOt))} • ${hotspotCount} hotspots`;
      return;
    }

    const zone = state.zoneById.get(state.selectedZoneId);
    if (!zone || !zone.hasZonePerformanceData) {
      statsEl.innerHTML = `${zonesWithData.length} zonas com dado 30 dias em ${statesWithData.size} estados<br/>` +
        `${formatNumber(totalVolume)} volume 30 dias • OT ponderado ${escapeHtml(formatPercent(weightedOt))} • ${hotspotCount} hotspots`;
      return;
    }

    const stateRank = formatRank(zone.volume30DayStateRank, zone.volume30DayStateZoneCount);
    statsEl.innerHTML = `<strong>${escapeHtml(zone.label)}</strong> • ${escapeHtml(zone.stateName)}<br/>` +
      `${formatNumber(zone.volume30Day)} volume 30 dias • OT ${escapeHtml(formatPercent(zone.onTimePct))}<br/>` +
      `rank volume #${formatNumber(zone.volume30DayRank)} • rank estado ${escapeHtml(stateRank)}`;
    return;
  }

  if (isCfpbDelinquencyMode()) {
    const totalComplaints = activeZones.reduce(
      (sum, zone) => sum + (zone.cfpbDistressComplaintCount || 0),
      0
    );
    const totalUntimely = activeZones.reduce(
      (sum, zone) => sum + (zone.cfpbDistressUntimelyCount || 0),
      0
    );

    if (!state.selectedZoneId) {
      statsEl.innerHTML = `${activeZoneCount} zonas ZIP3 ativas em ${activeStates.size} estados<br/>` +
        `${formatNumber(totalComplaints)} complaints CFPB • ${formatNumber(totalUntimely)} nao pontuais • ${hotspotCount} hotspots`;
      return;
    }

    const zone = state.zoneById.get(state.selectedZoneId);
    if (!zone) {
      statsEl.innerHTML = `${activeZoneCount} zonas ZIP3 ativas em ${activeStates.size} estados<br/>` +
        `${formatNumber(totalComplaints)} complaints CFPB • ${formatNumber(totalUntimely)} nao pontuais • ${hotspotCount} hotspots`;
      return;
    }

    const stateRank = formatRank(zone.cfpbDistressStateRank, zone.cfpbDistressStateZoneCount);
    statsEl.innerHTML = `<strong>${escapeHtml(zone.label)}</strong> • ${escapeHtml(zone.stateName)}<br/>` +
      `${formatNumber(zone.cfpbDistressComplaintCount)} complaints • ${formatNumber(zone.cfpbDistressUntimelyCount)} nao pontuais • ${escapeHtml(formatNumber(zone.cfpbDistressComplaintsPer100k))}/100k hab<br/>` +
      `score atraso ${escapeHtml(formatScore(zone.cfpbDistressScore))} • rank #${formatNumber(zone.cfpbDistressRank)} • rank estado ${escapeHtml(stateRank)}`;
    return;
  }

  if (isDelinquencyMode()) {
    const totalEstimatedDelinquentLoans = activeZones.reduce(
      (sum, zone) => sum + (zone.estimatedDelinquentLoans || 0),
      0
    );
    const totalEstimatedDelinquentVolume = activeZones.reduce(
      (sum, zone) => sum + (zone.estimatedDelinquentVolume || 0),
      0
    );

    if (!state.selectedZoneId) {
      statsEl.innerHTML = `${activeZoneCount} zonas ZIP3 ativas em ${activeStates.size} estados<br/>` +
        `${formatNumber(totalEstimatedDelinquentLoans)} loans delinquent (proxy) • ${escapeHtml(formatCurrency(totalEstimatedDelinquentVolume))} • ${hotspotCount} hotspots`;
      return;
    }

    const zone = state.zoneById.get(state.selectedZoneId);
    if (!zone) {
      statsEl.innerHTML = `${activeZoneCount} zonas ZIP3 ativas em ${activeStates.size} estados<br/>` +
        `${formatNumber(totalEstimatedDelinquentLoans)} loans delinquent (proxy) • ${escapeHtml(formatCurrency(totalEstimatedDelinquentVolume))} • ${hotspotCount} hotspots`;
      return;
    }

    const stateRank = formatRank(zone.delinquencyEstimatedStateRank, zone.delinquencyStateZoneCount);
    statsEl.innerHTML = `<strong>${escapeHtml(zone.label)}</strong> • ${escapeHtml(zone.stateName)}<br/>` +
      `${formatNumber(zone.estimatedDelinquentLoans)} loans delinquent (proxy) • taxa ${escapeHtml(formatPercent(zone.estimatedDelinquencyRatePct))} • risco ${escapeHtml(formatScore(zone.delinquencyRiskScore))}<br/>` +
      `rank proxy #${formatNumber(zone.delinquencyEstimatedRank)} • rank estado ${escapeHtml(stateRank)} • rank risco #${formatNumber(zone.delinquencyRiskRank)}`;
    return;
  }

  if (isMortgageMode()) {
    const totalMortgageCount = activeZones.reduce((sum, zone) => sum + (zone.mortgageOriginationsCount || 0), 0);
    const totalMortgageAmount = activeZones.reduce((sum, zone) => sum + (zone.mortgageOriginationsAmount || 0), 0);

    if (!state.selectedZoneId) {
      statsEl.innerHTML = `${activeZoneCount} zonas ZIP3 ativas em ${activeStates.size} estados<br/>` +
        `${formatNumber(totalMortgageCount)} loans originados (estimado) • ${escapeHtml(formatCurrency(totalMortgageAmount))} • ${hotspotCount} hotspots`;
      return;
    }

    const zone = state.zoneById.get(state.selectedZoneId);
    if (!zone) {
      statsEl.innerHTML = `${activeZoneCount} zonas ZIP3 ativas em ${activeStates.size} estados<br/>` +
        `${formatNumber(totalMortgageCount)} loans originados (estimado) • ${escapeHtml(formatCurrency(totalMortgageAmount))} • ${hotspotCount} hotspots`;
      return;
    }

    const mortgageStateRank = formatRank(zone.mortgageStateRank, zone.mortgageStateZoneCount);
    statsEl.innerHTML = `<strong>${escapeHtml(zone.label)}</strong> • ${escapeHtml(zone.stateName)}<br/>` +
      `${formatNumber(zone.mortgageOriginationsCount)} loans • ${escapeHtml(formatCurrency(zone.mortgageOriginationsAmount))} • score ${escapeHtml(formatScore(zone.mortgageOpportunityScore))}<br/>` +
      `rank mortgage #${formatNumber(zone.mortgageVolumeRank)} • rank estado ${escapeHtml(mortgageStateRank)} • rank oportunidade #${formatNumber(zone.mortgageOpportunityRank)}`;
    return;
  }

  const totalPopulation = activeZones.reduce((sum, zone) => sum + zone.population, 0);

  if (!state.selectedZoneId) {
    statsEl.innerHTML = `${activeZoneCount} zonas ZIP3 ativas em ${activeStates.size} estados<br/>` +
      `${formatNumber(totalPopulation)} habitantes estimados • ${hotspotCount} hotspots`;
    return;
  }

  const zone = state.zoneById.get(state.selectedZoneId);
  if (!zone) {
    statsEl.innerHTML = `${activeZoneCount} zonas ZIP3 ativas em ${activeStates.size} estados<br/>` +
      `${formatNumber(totalPopulation)} habitantes estimados • ${hotspotCount} hotspots`;
    return;
  }

  statsEl.innerHTML = `<strong>${escapeHtml(zone.label)}</strong> • ${escapeHtml(zone.stateName)}<br/>` +
    `${formatNumber(zone.population)} habitantes • ${formatNumber(zone.zipCount)} ZIP5 • rank geral #${zone.populationRank} • rank estado ${formatRank(zone.statePopulationRank, zone.stateZoneCount)}<br/>` +
    `ZIP lider: ${escapeHtml(topZipSummary(zone))}`;
}

function updateSelection(zoneId) {
  if (!isActiveZone(zoneId)) {
    return;
  }

  state.selectedZoneId = state.selectedZoneId === zoneId ? null : zoneId;

  refreshStyles();
  refreshPrimaryCountyHighlight();
  renderZoneList();
  renderZip3Labels();
  renderCityLabels();
  refreshStats();
  refreshDecisionPanel();

  if (state.selectedZoneId) {
    const bounds = state.boundsByZoneId.get(state.selectedZoneId);
    if (bounds) {
      map.fitBounds(bounds.pad(0.2));
    }
  }
}

function buildCountyLayers(geojson) {
  state.countyLabelPoints = (geojson.features || [])
    .map((feature) => {
      const center = geometryCenter(feature.geometry);
      if (!center) {
        return null;
      }

      return {
        ...center,
        label: feature.properties?.label || `${feature.properties?.countyName || "County"}, ${feature.properties?.state || ""}`,
        state: feature.properties?.state || ""
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.state.localeCompare(b.state) || a.label.localeCompare(b.label));

  state.countyLayer = L.geoJSON(geojson, {
    renderer: countyFillRenderer,
    style: styleForCountyFeature,
    onEachFeature(feature, layer) {
      layer.bindPopup(() => formatCountyPopup(feature));
    }
  });

  state.countyOutlineLayer = L.geoJSON(geojson, {
    renderer: countyOutlineRenderer,
    interactive: false,
    style: styleForCountyOutlineFeature
  });
}

function buildZoneLayer(geojson) {
  state.zoneGlowLayer = L.geoJSON(geojson, {
    renderer: zip3GlowRenderer,
    interactive: false,
    style: styleForZip3GlowFeature
  });

  state.zoneLayer = L.geoJSON(geojson, {
    renderer: zip3Renderer,
    style: styleForFeature,
    onEachFeature(feature, layer) {
      const zoneId = feature.properties.zoneId;
      layer.bindPopup(() => formatPopup(feature));

      layer.on("click", () => {
        updateSelection(zoneId);
      });

      const featureBounds = layer.getBounds();
      if (!state.boundsByZoneId.has(zoneId)) {
        state.boundsByZoneId.set(zoneId, L.latLngBounds(featureBounds));
      } else {
        state.boundsByZoneId.get(zoneId).extend(featureBounds);
      }
    }
  }).addTo(map);

  const allBounds = state.zoneLayer.getBounds();
  if (allBounds.isValid()) {
    map.fitBounds(allBounds.pad(0.08));
    map.setMaxBounds(allBounds.pad(0.45));
  }
}

function zoneMatchesFilter(zone, query) {
  if (!query) {
    return true;
  }

  if (zone.label.toLowerCase().includes(query)) {
    return true;
  }

  if (zone.state.toLowerCase().includes(query) || zone.stateName.toLowerCase().includes(query)) {
    return true;
  }

  if (String(zone.primaryCountyName || "").toLowerCase().includes(query)) {
    return true;
  }

  if (String(zone.topZip5 || "").includes(query) || String(zone.topZipCity || "").toLowerCase().includes(query)) {
    return true;
  }

  return zone.cities.some((city) => city.toLowerCase().includes(query));
}

function compareZoneByMode(a, b) {
  if (isZonePerformanceMode()) {
    return (
      (b.volume30Day || 0) - (a.volume30Day || 0) ||
      (b.onTimePct || 0) - (a.onTimePct || 0) ||
      a.label.localeCompare(b.label)
    );
  }

  if (isCfpbDelinquencyMode()) {
    return (
      (b.cfpbDistressScore || 0) - (a.cfpbDistressScore || 0) ||
      (b.cfpbDistressComplaintCount || 0) - (a.cfpbDistressComplaintCount || 0) ||
      a.label.localeCompare(b.label)
    );
  }

  if (isDelinquencyMode()) {
    return (
      (b.estimatedDelinquentLoans || 0) - (a.estimatedDelinquentLoans || 0) ||
      (b.delinquencyRiskScore || 0) - (a.delinquencyRiskScore || 0) ||
      a.label.localeCompare(b.label)
    );
  }

  if (isMortgageMode()) {
    return (
      (b.mortgageOpportunityScore || 0) - (a.mortgageOpportunityScore || 0) ||
      (b.mortgageOriginationsCount || 0) - (a.mortgageOriginationsCount || 0) ||
      a.label.localeCompare(b.label)
    );
  }

  return b.population - a.population || a.label.localeCompare(b.label);
}

function renderZoneList() {
  zoneListEl.innerHTML = "";

  const visibleZones = getActiveZones().sort(compareZoneByMode);

  if (visibleZones.length === 0) {
    const filterText = activeFilterDescriptions().join(" • ") || "os filtros atuais";
    zoneListEl.innerHTML = `<div class="zone-item">Nenhuma zona encontrada para ${escapeHtml(filterText)}.</div>`;
    return;
  }

  for (const zone of visibleZones) {
    const button = document.createElement("button");
    button.type = "button";

    const classes = ["zone-item"];
    if (state.selectedZoneId === zone.zoneId) {
      classes.push("active");
    }
    if (isZoneHotspot(zone)) {
      classes.push("hotspot");
    }
    button.className = classes.join(" ");

    const hotspotTag = isZoneHotspot(zone) ? `<span class="zone-tag">HOT</span>` : "";

    if (isZonePerformanceMode()) {
      button.innerHTML = `
        <div class="zone-title">
          <span>${escapeHtml(zone.label)}</span>
          <span>${formatNumber(zone.volume30Day || 0)} vol</span>
        </div>
        <div class="zone-meta">${escapeHtml(zone.stateName)} • OT ${escapeHtml(formatPercent(zone.onTimePct))} ${hotspotTag}</div>
        <div class="zone-cities">County principal: ${escapeHtml(primaryCountySummary(zone))}</div>
        <div class="zone-cities">Rank volume: #${formatNumber(zone.volume30DayRank)} • rank estado ${formatRank(zone.volume30DayStateRank, zone.volume30DayStateZoneCount)}</div>
        <div class="zone-cities">ZIP com mais casas: ${escapeHtml(topHousingSummary(zone))}</div>
      `;
    } else if (isCfpbDelinquencyMode()) {
      button.innerHTML = `
        <div class="zone-title">
          <span>${escapeHtml(zone.label)}</span>
          <span>${formatNumber(zone.cfpbDistressComplaintCount)} complaints</span>
        </div>
        <div class="zone-meta">${escapeHtml(zone.stateName)} • score ${escapeHtml(formatScore(zone.cfpbDistressScore))} • rank #${formatNumber(zone.cfpbDistressRank)} ${hotspotTag}</div>
        <div class="zone-cities">County principal: ${escapeHtml(primaryCountySummary(zone))}</div>
        <div class="zone-cities">Nao pontuais: ${formatNumber(zone.cfpbDistressUntimelyCount)} (${escapeHtml(formatPercent(zone.cfpbDistressUntimelySharePct))}) • ${escapeHtml(formatNumber(zone.cfpbDistressComplaintsPer100k))}/100k hab</div>
        <div class="zone-cities">Rank estado: ${formatRank(zone.cfpbDistressStateRank, zone.cfpbDistressStateZoneCount)} • inicio ${escapeHtml(zone.cfpbDistressDateReceivedMin || "N/D")}</div>
        <div class="zone-cities">ZIP com mais casas: ${escapeHtml(topHousingSummary(zone))}</div>
      `;
    } else if (isDelinquencyMode()) {
      button.innerHTML = `
        <div class="zone-title">
          <span>${escapeHtml(zone.label)}</span>
          <span>${formatNumber(zone.estimatedDelinquentLoans)} delinquent</span>
        </div>
        <div class="zone-meta">${escapeHtml(zone.stateName)} • taxa ${escapeHtml(formatPercent(zone.estimatedDelinquencyRatePct))} • risco ${escapeHtml(formatScore(zone.delinquencyRiskScore))} ${hotspotTag}</div>
        <div class="zone-cities">County principal: ${escapeHtml(primaryCountySummary(zone))}</div>
        <div class="zone-cities">Volume proxy: ${escapeHtml(formatCurrency(zone.estimatedDelinquentVolume))} • rank estado ${formatRank(zone.delinquencyEstimatedStateRank, zone.delinquencyStateZoneCount)}</div>
        <div class="zone-cities">ZIP com mais casas: ${escapeHtml(topHousingSummary(zone))}</div>
      `;
    } else if (isMortgageMode()) {
      button.innerHTML = `
        <div class="zone-title">
          <span>${escapeHtml(zone.label)}</span>
          <span>${formatNumber(zone.mortgageOriginationsCount)} loans</span>
        </div>
        <div class="zone-meta">${escapeHtml(zone.stateName)} • score ${escapeHtml(formatScore(zone.mortgageOpportunityScore))} • rank oportunidade #${formatNumber(zone.mortgageOpportunityRank)} ${hotspotTag}</div>
        <div class="zone-cities">County principal: ${escapeHtml(primaryCountySummary(zone))}</div>
        <div class="zone-cities">Volume estimado: ${escapeHtml(formatCurrency(zone.mortgageOriginationsAmount))} • rank estado ${formatRank(zone.mortgageStateRank, zone.mortgageStateZoneCount)}</div>
        <div class="zone-cities">ZIP com mais casas: ${escapeHtml(topHousingSummary(zone))}</div>
      `;
    } else {
      button.innerHTML = `
        <div class="zone-title">
          <span>${escapeHtml(zone.label)}</span>
          <span>${formatNumber(zone.population)}</span>
        </div>
        <div class="zone-meta">${escapeHtml(zone.stateName)} • ${zone.zipCount} ZIP5 • rank estado ${formatRank(zone.statePopulationRank, zone.stateZoneCount)} • rank geral #${zone.populationRank} ${hotspotTag}</div>
        <div class="zone-cities">County principal: ${escapeHtml(primaryCountySummary(zone))}</div>
        <div class="zone-cities">ZIP lider: ${escapeHtml(topZipSummary(zone))}</div>
        <div class="zone-cities">ZIP com mais casas: ${escapeHtml(topHousingSummary(zone))}</div>
        <div class="zone-cities">${escapeHtml(cityPreview(zone.cities, 7))}</div>
      `;
    }

    button.addEventListener("click", () => {
      updateSelection(zone.zoneId);
    });

    zoneListEl.appendChild(button);
  }
}

function renderZip3Labels() {
  zip3LayerGroup.clearLayers();
  if (!state.showZip3Labels || !shouldShowZip3Layer()) {
    return;
  }

  const zoneList = state.zones
    .filter((zone) => isActiveZone(zone.zoneId))
    .filter((zone) => (state.selectedZoneId ? zone.zoneId === state.selectedZoneId : true));

  for (const zone of zoneList) {
    if (!Number.isFinite(zone.latitude) || !Number.isFinite(zone.longitude)) {
      continue;
    }

    const marker = L.marker([zone.latitude, zone.longitude], {
      interactive: false,
      icon: L.divIcon({
        className: "zip3-label",
        html: escapeHtml(zone.label)
      })
    });

    zip3LayerGroup.addLayer(marker);
  }
}

function renderCountyLabels() {
  countyLabelLayerGroup.clearLayers();
  if (!state.showCountyLabels || (!shouldShowCountyLayer() && !shouldShowCountyOutlineLayer())) {
    return;
  }

  const zoom = map.getZoom();
  const maxLabels = state.mapLayerMode === "counties" ? 420 : 260;
  const minZoom = state.mapLayerMode === "counties" ? 5 : 6;
  if (zoom < minZoom) {
    return;
  }

  const bounds = map.getBounds();
  const visibleCounties = state.countyLabelPoints.filter((county) =>
    bounds.contains([county.latitude, county.longitude])
  );

  for (const county of visibleCounties.slice(0, maxLabels)) {
    if (!Number.isFinite(county.latitude) || !Number.isFinite(county.longitude)) {
      continue;
    }

    const marker = L.marker([county.latitude, county.longitude], {
      interactive: false,
      icon: L.divIcon({
        className: "county-label",
        html: escapeHtml(county.label)
      })
    });

    countyLabelLayerGroup.addLayer(marker);
  }
}

function renderCityLabels() {
  cityLayerGroup.clearLayers();
  if (!state.showCities) {
    return;
  }

  const selectedZoneId = state.selectedZoneId;

  const filtered = state.cities.filter((city) => {
    const inActiveWorkArea = city.zoneIds.some((zoneId) => isActiveZone(zoneId));
    if (!inActiveWorkArea) {
      return false;
    }

    if (!selectedZoneId) {
      return true;
    }

    return city.zoneIds.includes(selectedZoneId);
  });

  const maxLabels = selectedZoneId ? 260 : 180;

  for (const city of filtered.slice(0, maxLabels)) {
    if (!Number.isFinite(city.latitude) || !Number.isFinite(city.longitude)) {
      continue;
    }

    const marker = L.marker([city.latitude, city.longitude], {
      icon: L.divIcon({
        className: "city-label",
        html: escapeHtml(city.city)
      })
    });

    marker.bindTooltip(
      `${city.city}, ${city.state} • Pop: ${formatNumber(city.population)} • Zonas: ${city.zoneIds.join(", ")}`,
      { direction: "top", sticky: true }
    );

    cityLayerGroup.addLayer(marker);
  }
}

function parseWorkZonesPayload(payload) {
  const activeZoneIds = new Set();

  if (Array.isArray(payload?.zones)) {
    for (const zoneId of payload.zones) {
      const normalized = normalizeZoneId(zoneId);
      if (state.zoneById.has(normalized)) {
        activeZoneIds.add(normalized);
      }
    }
  }

  if (Array.isArray(payload?.states)) {
    const stateSet = new Set(payload.states.map((entry) => String(entry).trim().toUpperCase()));
    for (const zone of state.zones) {
      if (stateSet.has(zone.state)) {
        activeZoneIds.add(zone.zoneId);
      }
    }
  }

  if (Array.isArray(payload?.zip3)) {
    const prefixSet = new Set(payload.zip3.map((entry) => normalizeZip3(entry)));
    for (const zone of state.zones) {
      if (prefixSet.has(zone.zip3)) {
        activeZoneIds.add(zone.zoneId);
      }
    }
  }

  return activeZoneIds;
}

async function loadWorkZones() {
  try {
    const workZonesResp = await fetch(`./data/work_zones.json?v=${DATA_VERSION}`);
    if (!workZonesResp.ok) {
      return;
    }

    const payload = await workZonesResp.json();
    const parsed = parseWorkZonesPayload(payload);
    if (parsed.size > 0) {
      state.activeZoneIds = parsed;
    }
  } catch {
    console.warn("work_zones.json not found; using all zones.");
  }
}

function attachZonePerformanceData(payload) {
  if (!payload || !Array.isArray(payload.zones)) {
    return;
  }

  const performanceByZoneId = new Map(
    payload.zones.map((zone) => [normalizeZoneId(zone.zoneId), zone])
  );
  const hotspotLimit = Math.max(1, Math.ceil(payload.zones.length * 0.15));

  for (const zone of state.zones) {
    const performance = performanceByZoneId.get(zone.zoneId);
    if (!performance) {
      Object.assign(zone, {
        hasZonePerformanceData: false,
        volume30Day: 0,
        onTimePct: null,
        volume30DayRank: null,
        volume30DayStateRank: null,
        volume30DayStateZoneCount: null,
        isZonePerformanceHotspot: false
      });
      continue;
    }

    Object.assign(zone, {
      hasZonePerformanceData: true,
      volume30Day: performance.volume30Day,
      onTimePct: performance.onTimePct,
      volume30DayRank: performance.volume30DayRank,
      volume30DayStateRank: performance.volume30DayStateRank,
      volume30DayStateZoneCount: performance.volume30DayStateZoneCount,
      isZonePerformanceHotspot: performance.volume30DayRank <= hotspotLimit
    });
  }

  state.hasZonePerformanceData = state.zones.some((zone) => zone.hasZonePerformanceData);
  state.zonePerformanceTotals = payload.totals || null;
}

function syncFilterStateFromInputs() {
  state.filters.scoreMin = scoreMinInput?.value || "";
  state.filters.scoreMax = scoreMaxInput?.value || "";
  state.filters.volume30DayMin = volume30DayMinInput?.value || "";
  state.filters.volume30DayMax = volume30DayMaxInput?.value || "";
  state.filters.mortgageLoansMin = mortgageLoansMinInput?.value || "";
  state.filters.housingMin = housingMinInput?.value || "";
  state.mapShowsFilteredZones = toggleFilteredMapInput ? toggleFilteredMapInput.checked : true;
}

function clearFilters() {
  state.filter = "";
  if (filterInput) {
    filterInput.value = "";
  }

  for (const input of [
    scoreMinInput,
    scoreMaxInput,
    volume30DayMinInput,
    volume30DayMaxInput,
    mortgageLoansMinInput,
    housingMinInput
  ]) {
    if (input) {
      input.value = "";
    }
  }

  if (toggleFilteredMapInput) {
    toggleFilteredMapInput.checked = true;
  }

  syncFilterStateFromInputs();
}

function applyFilterChanges() {
  if (state.selectedZoneId && !isActiveZone(state.selectedZoneId)) {
    state.selectedZoneId = null;
  }

  refreshStyles();
  refreshPrimaryCountyHighlight();
  renderZoneList();
  renderZip3Labels();
  renderCityLabels();
  refreshStats();
  refreshDecisionPanel();
}

function setupControls() {
  filterInput.addEventListener("input", (event) => {
    state.filter = event.target.value;
    applyFilterChanges();
  });

  for (const input of [
    scoreMinInput,
    scoreMaxInput,
    volume30DayMinInput,
    volume30DayMaxInput,
    mortgageLoansMinInput,
    housingMinInput
  ]) {
    input?.addEventListener("input", () => {
      syncFilterStateFromInputs();
      applyFilterChanges();
    });
  }

  toggleFilteredMapInput?.addEventListener("change", () => {
    syncFilterStateFromInputs();
    applyFilterChanges();
  });

  resetFiltersButton?.addEventListener("click", () => {
    clearFilters();
    applyFilterChanges();
  });

  modeSelect.addEventListener("change", (event) => {
    const nextMode = String(event.target.value || "population");
    if (
      nextMode === "mortgage" ||
      nextMode === "delinquency" ||
      nextMode === "cfpb-delinquency" ||
      nextMode === "zone-performance"
    ) {
      state.mode = nextMode;
    } else {
      state.mode = "population";
    }

    if (!state.hasMortgageData && (state.mode === "mortgage" || state.mode === "delinquency")) {
      state.mode = "population";
      modeSelect.value = "population";
    }

    if (!state.hasCfpbDistressData && state.mode === "cfpb-delinquency") {
      state.mode = "population";
      modeSelect.value = "population";
    }

    if (!state.hasZonePerformanceData && state.mode === "zone-performance") {
      state.mode = "population";
      modeSelect.value = "population";
    }

    refreshModeText();
    refreshStyles();
    renderZoneList();
    refreshStats();
    refreshDecisionPanel();
  });

  layerModeSelect.addEventListener("change", (event) => {
    const nextMode = String(event.target.value || "zip3");
    state.mapLayerMode = nextMode === "counties" || nextMode === "both" ? nextMode : "zip3";
    refreshLayerVisibility();
  });

  popupModeSelect.addEventListener("change", (event) => {
    state.popupMode = String(event.target.value || "summary") === "full" ? "full" : "summary";
    map.closePopup();
  });

  toggleCitiesInput.addEventListener("change", (event) => {
    state.showCities = event.target.checked;
    renderCityLabels();
  });

  toggleZip3LabelsInput.addEventListener("change", (event) => {
    state.showZip3Labels = event.target.checked;
    renderZip3Labels();
  });

  toggleCountyLabelsInput.addEventListener("change", (event) => {
    state.showCountyLabels = event.target.checked;
    renderCountyLabels();
  });

  toggleHotspotsInput.addEventListener("change", (event) => {
    state.highlightHotspots = event.target.checked;
    refreshStyles();
    renderZoneList();
    refreshStats();
    refreshDecisionPanel();
  });
}

async function loadData() {
  const [geoResp, zonesResp, citiesResp, statesResp, performanceResp, countiesResp] = await Promise.all([
    fetch(`./data/coverage_zip3.geojson?v=${DATA_VERSION}`),
    fetch(`./data/coverage_zip3_zones.json?v=${DATA_VERSION}`),
    fetch(`./data/coverage_cities.json?v=${DATA_VERSION}`),
    fetch(`./data/coverage_states.json?v=${DATA_VERSION}`),
    fetch(`./data/zone_performance_30day.json?v=${DATA_VERSION}`).catch(() => null),
    fetch(`./data/coverage_counties.geojson?v=${DATA_VERSION}`).catch(() => null)
  ]);

  if (!geoResp.ok || !zonesResp.ok || !citiesResp.ok || !statesResp.ok) {
    throw new Error("Nao foi possivel carregar os arquivos de dados. Rode 'npm run prepare-data'.");
  }

  const zoneGeojson = await geoResp.json();
  const countyGeojson = countiesResp?.ok ? await countiesResp.json() : null;
  state.zones = await zonesResp.json();
  state.cities = await citiesResp.json();
  state.states = await statesResp.json();
  state.totalZoneFeatureCount = zoneGeojson.features.length;
  state.totalCountyFeatureCount = Array.isArray(countyGeojson?.features) ? countyGeojson.features.length : 0;
  state.countyByFips = new Map();
  state.countyFeatureByFips = new Map();
  for (const feature of countyGeojson?.features || []) {
    const countyFips = feature.properties?.countyFips;
    if (countyFips) {
      state.countyByFips.set(countyFips, feature.properties);
      state.countyFeatureByFips.set(countyFips, feature);
    }
  }

  state.zoneById = new Map();

  for (const zone of state.zones) {
    state.zoneById.set(zone.zoneId, zone);
  }

  if (performanceResp?.ok) {
    attachZonePerformanceData(await performanceResp.json());
  }

  state.activeZoneIds = new Set(state.zones.map((zone) => zone.zoneId));
  await loadWorkZones();

  if (state.zones.length > 0) {
    state.hasMortgageData = Boolean(state.zones[0].hasMortgageData);
    state.hasCfpbDistressData = Boolean(state.zones[0].hasCfpbDistressData);
    state.mortgageYear = state.zones[0].mortgageYear || null;
  }

  if ((!state.hasMortgageData && (state.mode === "mortgage" || state.mode === "delinquency")) ||
      (!state.hasCfpbDistressData && state.mode === "cfpb-delinquency") ||
      (!state.hasZonePerformanceData && state.mode === "zone-performance")) {
    modeSelect.value = "population";
    state.mode = "population";
  }

  if (state.totalCountyFeatureCount > 0) {
    buildCountyLayers(countyGeojson);
  }

  buildZoneLayer(zoneGeojson);
  refreshLayerVisibility();
  refreshModeText();
  renderZoneList();
  refreshStats();
  refreshDecisionPanel();
}

setupControls();

loadData().catch((error) => {
  console.error(error);
  statsEl.textContent = "Erro ao carregar dados. Rode 'npm run prepare-data' e recarregue a pagina.";
});
