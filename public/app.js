import {
  zoneColor,
  labelPoint,
  overlaps,
  weightedOnTime,
  zoneVolumeLabel,
  productionPeriodLabel,
} from "./atlas-utils.js?v=all-us-v22";

const map = L.map("map", {
  zoomControl: false,
  preferCanvas: true,
  zoomSnap: 0.25,
  minZoom: 3,
});

const DATA_VERSION = "all-us-v22";

L.control.zoom({ position: "topright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
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
createMapPane("secret-focus-pane", 476, "none");

createMapPane("primary-county-pane", 490, "none");

const countyFillRenderer = L.canvas({ pane: "county-fill-pane", padding: 0.5 });
const zip3Renderer = L.canvas({ pane: "zip3-pane", padding: 0.5 });
const countyOutlineRenderer = L.canvas({
  pane: "county-outline-pane",
  padding: 0.5,
});
const secretFocusRenderer = L.canvas({
  pane: "secret-focus-pane",
  padding: 0.5,
});

const primaryCountyRenderer = L.canvas({
  pane: "primary-county-pane",
  padding: 0.5,
});

map.setView([40.2, -79.2], 6);
map.on("zoomend moveend", () => {
  renderLabels();
});

const zip3LayerGroup = L.layerGroup().addTo(map);
const cityLayerGroup = L.layerGroup().addTo(map);
const countyLabelLayerGroup = L.layerGroup().addTo(map);

const state = {
  selectedZoneId: null,
  mode: "zone-performance",
  selectedState: "OH",
  labelPoints: new Map(),
  hasMortgageData: false,
  hasCfpbDistressData: false,
  hasZonePerformanceData: false,
  dataReady: false,
  mortgageYear: null,
  zonePerformanceTotals: null,
  zonePerformanceSource: null,
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
  secretFocusLayer: null,
  secretFocusEnabled: false,
  coverageOnly: false,
  secretFocusZoneIds: new Set(),
  secretFocusByZoneId: new Map(),
  secretFocusTotals: null,
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
    housingMin: "",
  },
  mapShowsFilteredZones: true,
  mapLayerMode: "zip3",
  popupMode: "summary",
  showCities: true,
  showZip3Labels: true,
  showZoneVolume: false,
  showCountyLabels: true,
  highlightHotspots: false,
  totalCountyFeatureCount: 0,
  totalZoneFeatureCount: 0,
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
const secretFocusToggleButton = document.querySelector("#secret-focus-toggle");
const secretFocusSummaryEl = document.querySelector("#secret-focus-summary");
const modeHintEl = document.querySelector("#analysis-mode-hint");
const filterSummaryEl = document.querySelector("#filter-summary");
const toggleCitiesInput = document.querySelector("#toggle-cities");
const toggleZip3LabelsInput = document.querySelector("#toggle-zip3-labels");
const zoneVolumeToggleButton = document.querySelector("#toggle-zone-volume");
const toggleCountyLabelsInput = document.querySelector("#toggle-county-labels");
const toggleHotspotsInput = document.querySelector("#toggle-hotspots");
const toggleFilteredMapInput = document.querySelector("#toggle-filtered-map");
const zoneListEl = document.querySelector("#zone-list");
const statsEl = document.querySelector("#stats");
const selectionDetailsEl = document.querySelector("#selection-details");
const legendLayerSwatchEl = document.querySelector(
  ".legend .swatch:not(.hotspot)",
);
const legendLayerLabelEl = document.querySelector("#legend-layer-label");
const legendHotspotLabelEl = document.querySelector("#legend-hotspot-label");
const appShellEl = document.querySelector("#app-shell");
const panelCollapseToggleButton = document.querySelector(
  "#panel-collapse-toggle",
);
const panelReopenButton = document.querySelector("#panel-reopen");
const systemStatusEl = document.querySelector("#system-status");
const dataStatusTextEl = document.querySelector("#data-status-text");
const dataStatusDateEl = document.querySelector("#data-status-date");
const mapContextModeEl = document.querySelector("#map-context-mode");
const mapContextLayerEl = document.querySelector("#map-context-layer");
const filterActiveCountEl = document.querySelector("#filter-active-count");
const zoneResultCountEl = document.querySelector("#zone-result-count");

const MODE_LABELS = {
  population: "População",
  mortgage: "Mortgage Opportunity",
  delinquency: "Delinquency Proxy",
  "cfpb-delinquency": "Atraso CFPB",
  "zone-performance": "30 dias / OT%",
};

const LAYER_LABELS = {
  zip3: "Zonas ZIP3",
  counties: "Counties",
  both: "ZIP3 + Counties",
};

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
  if (value == null || value === "" || !Number.isFinite(numericValue)) {
    return "N/D";
  }

  return new Intl.NumberFormat("en-US").format(Math.round(numericValue));
}

function formatCurrency(value) {
  const numericValue = Number(value);
  if (value == null || value === "" || !Number.isFinite(numericValue)) {
    return "N/D";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
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
  if (value == null || value === "" || !Number.isFinite(numericValue)) {
    return "N/D";
  }

  return `${numericValue.toFixed(1)}/100`;
}

function formatPercent(value) {
  const numericValue = Number(value);
  if (value == null || value === "" || !Number.isFinite(numericValue)) {
    return "N/D";
  }

  return `${numericValue.toFixed(2)}%`;
}

function formatDataStatusDate() {
  const period = productionPeriodLabel(state.zonePerformanceSource);
  if (period) return period;
  const generatedAt = state.zonePerformanceSource?.generatedAt;
  if (!generatedAt) {
    return "Cobertura nacional ZIP3 + counties";
  }

  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) {
    return "Cobertura nacional ZIP3 + counties";
  }

  const formattedDate = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);

  return `Produção atualizada em ${formattedDate}`;
}

function refreshInterfaceStatus() {
  if (mapContextModeEl) {
    mapContextModeEl.textContent =
      MODE_LABELS[state.mode] || MODE_LABELS.population;
  }

  if (mapContextLayerEl) {
    mapContextLayerEl.textContent =
      LAYER_LABELS[state.mapLayerMode] || LAYER_LABELS.zip3;
  }

  const activeFilters = activeFilterDescriptions().length;
  if (filterActiveCountEl) {
    filterActiveCountEl.textContent = `${activeFilters} ${activeFilters === 1 ? "ativo" : "ativos"}`;
    filterActiveCountEl.classList.toggle("active", activeFilters > 0);
  }

  if (zoneResultCountEl) {
    zoneResultCountEl.textContent = formatNumber(getActiveZones().length);
  }

  if (systemStatusEl) {
    systemStatusEl.classList.toggle("ready", state.dataReady);
  }

  if (dataStatusTextEl) {
    dataStatusTextEl.textContent = state.dataReady
      ? `Base operacional • ${formatNumber(state.zones.length)} zonas`
      : "Carregando base nacional";
  }

  if (dataStatusDateEl) {
    dataStatusDateEl.textContent = formatDataStatusDate();
  }
}

function setPanelCollapsed(collapsed) {
  appShellEl.classList.toggle("panel-collapsed", collapsed);
  panelCollapseToggleButton?.setAttribute("aria-expanded", String(!collapsed));
  panelReopenButton?.setAttribute("aria-expanded", String(!collapsed));
  requestAnimationFrame(() => {
    map.invalidateSize();
    renderLabels();
  });
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
  if (
    !zone ||
    !zone.topZip5 ||
    !Number.isFinite(Number(zone.topZipPopulation)) ||
    zone.topZipPopulation <= 0
  ) {
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

  return zone.topZipCity
    ? `${zone.topZip5} • ${zone.topZipCity}`
    : zone.topZip5;
}

function primaryCountySummary(zone) {
  if (!zone || !zone.primaryCountyFips) {
    return zone?.primaryCountyName ? `${zone.primaryCountyName} County` : "N/D";
  }

  const county = state.countyByFips.get(zone.primaryCountyFips);
  if (county?.label) {
    return county.label;
  }

  return zone.primaryCountyName
    ? `${zone.primaryCountyName} County`
    : zone.primaryCountyFips;
}

function opportunityScoreForFilter(zone) {
  const score = Number(zone?.mortgageOpportunityScore);
  return Number.isFinite(score) ? score : null;
}

function volume30DayForFilter(zone) {
  if (!zone?.hasZonePerformanceData) return null;
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
  return String(value || "")
    .trim()
    .padStart(3, "0");
}

function colorForZone(zone) {
  return zoneColor(zone.zip3, zone.state);
}
const COUNTY_FILL_COLORS = [
  "#b2d6c9",
  "#c4dcd4",
  "#a9cdd1",
  "#d4dfb9",
  "#c9d8df",
  "#c3d3bd",
];

function hashText(value) {
  return String(value || "")
    .split("")
    .reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0);
}

function colorForCounty(feature) {
  const props = feature?.properties || {};
  const key =
    props.countyFips || `${props.state || ""}-${props.countyName || ""}`;
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
  return (
    (!state.selectedState || zone.state === state.selectedState) &&
    (!state.secretFocusEnabled ||
      !state.coverageOnly ||
      isSecretFocusZone(zone.zoneId)) &&
    zonePassesActiveFilters(zone)
  );
}

function isMapVisibleZone(zone) {
  if (!zone || !isWorkZone(zone.zoneId)) {
    return false;
  }

  if (
    state.secretFocusEnabled &&
    state.coverageOnly &&
    !isSecretFocusZone(zone.zoneId)
  )
    return false;

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
  const zone = state.zoneById.get(feature.properties.zoneId);
  if (!zone || !isActiveZone(zone.zoneId))
    return { weight: 0, opacity: 0, fillOpacity: 0 };
  const selected = state.selectedZoneId === zone.zoneId;
  if (state.secretFocusEnabled) {
    const covered = isSecretFocusZone(zone.zoneId);
    return {
      color: selected ? "#313b33" : "#9ba397",
      weight: selected ? 2.5 : 1.1,
      opacity: covered ? 0 : 0.8,
      fillColor: "#d8ddd2",
      fillOpacity: covered ? 0 : 0.34,
      dashArray: null,
    };
  }
  const hotspot = state.highlightHotspots && isZoneHotspot(zone);
  return {
    color: hotspot && !selected ? "#9a6226" : "#262a23",
    weight: selected ? 3 : 1.65,
    opacity: 1,
    fillColor: colorForZone(zone),
    fillOpacity: selected ? 0.7 : state.mapLayerMode === "both" ? 0.35 : 0.58,
    dashArray: hotspot && !selected ? "5,3" : null,
    lineJoin: "round",
  };
}

function styleForCountyFeature(feature) {
  return {
    color: "#377d79",
    weight: 1.25,
    opacity: 0.85,
    fillColor: colorForCounty(feature),
    fillOpacity: state.mapLayerMode === "both" ? 0.15 : 0.58,
    dashArray: "5,4",
  };
}

function styleForCountyOutlineFeature() {
  return {
    color: "#247e7c",
    weight: 1.3,
    opacity: 0.9,
    fillOpacity: 0,
    dashArray: "5,4",
    interactive: false,
  };
}

function styleForSecretFocusFeature(feature) {
  const visible = isActiveZone(feature.properties.zoneId);
  return {
    color: "#962858",
    weight: state.selectedZoneId === feature.properties.zoneId ? 3.5 : 2.6,
    opacity: visible ? 0.95 : 0,
    fillColor: "#ec7eae",
    fillOpacity: visible ? 0.68 : 0,
    interactive: false,
  };
}

function styleForPrimaryCountyFeature() {
  return {
    color: "#ac552c",
    weight: 2.5,
    opacity: 1,
    fillColor: "#efd3a4",
    fillOpacity: 0.12,
    dashArray: "7,4",
    interactive: false,
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

  const stateMortgageRank = formatRank(
    zone.mortgageStateRank,
    zone.mortgageStateZoneCount,
  );
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

  const stateDelinquencyRank = formatRank(
    zone.delinquencyEstimatedStateRank,
    zone.delinquencyStateZoneCount,
  );
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

  const stateRank = formatRank(
    zone.cfpbDistressStateRank,
    zone.cfpbDistressStateZoneCount,
  );
  const rangeLabel = zone.cfpbDistressLookbackMonths
    ? `${formatNumber(zone.cfpbDistressLookbackMonths)}m`
    : "janela ativa";
  const latestLabel =
    zone.cfpbDistressLatestComplaintDate ||
    zone.cfpbDistressLastUpdated ||
    "N/D";

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

  const stateRank = formatRank(
    zone.volume30DayStateRank,
    zone.volume30DayStateZoneCount,
  );
  return `
    30 dias: <strong>${formatNumber(zone.volume30Day)}</strong> volume<br/>
    On-time: <strong>${escapeHtml(formatPercent(zone.onTimePct))}</strong><br/>
    Rank volume: #${formatNumber(zone.volume30DayRank)} (geral) • ${escapeHtml(stateRank)} (estado)
  `;
}

function secretFocusSummaryBlock(zone) {
  if (!state.secretFocusEnabled || !isSecretFocusZone(zone.zoneId)) {
    return "";
  }

  return `Camada rosa: <strong>${escapeHtml(secretFocusMetricSummary(zone.zoneId))}</strong><br/>`;
}

function formatSummaryPopup(zone) {
  return `<div class="zone-popup">
    <div class="popup-kicker">${escapeHtml(zone.stateName)} / ${escapeHtml(zone.state)}</div>
    <h3 class="popup-title">Zona Z${escapeHtml(zone.zip3)}</h3>
    <div class="popup-metrics"><div><strong>${zone.hasZonePerformanceData ? formatNumber(zone.volume30Day) : "N/D"}</strong><span>Volume · 30 dias</span></div><div><strong>${zone.hasZonePerformanceData ? formatPercent(zone.onTimePct) : "N/D"}</strong><span>On-time</span></div></div>
    <dl class="popup-facts"><div><dt>ZIP principal</dt><dd>${escapeHtml(primaryZipSummary(zone))}</dd></div><div><dt>County principal</dt><dd>${escapeHtml(primaryCountySummary(zone))}</dd></div></dl>
    ${state.secretFocusEnabled && isSecretFocusZone(zone.zoneId) ? `<div class="popup-pink">Sua cobertura: ${escapeHtml(secretFocusMetricSummary(zone.zoneId))}</div>` : ""}
  </div>`;
}

function formatPopup(feature, full = false) {
  const zone = state.zoneById.get(feature.properties.zoneId);
  if (!zone) {
    return "Zona indisponivel";
  }

  if (!full && state.popupMode === "summary") {
    return formatSummaryPopup(zone);
  }

  const hotspotLabel = isZoneHotspot(zone) ? "Sim" : "Nao";
  const stateRankLabel = formatRank(
    zone.statePopulationRank,
    zone.stateZoneCount,
  );
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
    ${secretFocusSummaryBlock(zone)}
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

  if (state.secretFocusLayer) {
    state.secretFocusLayer.setStyle(styleForSecretFocusFeature);
  }

  if (state.zoneLayer) {
    state.zoneLayer.setStyle(styleForFeature);
    bringSelectionToFront();
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
  refreshInterfaceStatus();

  document.querySelector(".legend-note").textContent = state.secretFocusEnabled
    ? state.coverageOnly
      ? "Somente suas zonas"
      : "Vizinhas em cinza"
    : "Cores distinguem territórios";
  if (state.secretFocusEnabled) {
    legendLayerLabelEl.textContent = "Sua cobertura";
    legendLayerSwatchEl.classList.remove("county", "combined");
    return;
  }

  if (!legendLayerLabelEl) {
    return;
  }

  if (legendLayerSwatchEl) {
    legendLayerSwatchEl.classList.toggle(
      "county",
      state.mapLayerMode === "counties",
    );
    legendLayerSwatchEl.classList.toggle(
      "combined",
      state.mapLayerMode === "both",
    );
  }

  if (state.mapLayerMode === "counties") {
    legendLayerLabelEl.textContent = "County colorido";
    return;
  }

  if (state.mapLayerMode === "both") {
    legendLayerLabelEl.textContent = "Zonas + counties";
    return;
  }

  legendLayerLabelEl.textContent = "Zona ZIP3";
}

function refreshLayerVisibility() {
  refreshStyles();
  setLayerVisible(state.countyLayer, shouldShowCountyLayer());
  setLayerVisible(state.countyOutlineLayer, shouldShowCountyOutlineLayer());
  setLayerVisible(state.zoneLayer, shouldShowZip3Layer());
  setLayerVisible(
    state.secretFocusLayer,
    state.secretFocusEnabled && shouldShowZip3Layer(),
  );

  if (shouldShowZip3Layer()) {
    bringLayerToFront(state.zoneLayer);
    bringLayerToFront(state.secretFocusLayer);
  }

  if (shouldShowCountyOutlineLayer()) {
    bringLayerToFront(state.countyOutlineLayer);
  } else if (shouldShowCountyLayer()) {
    bringLayerToFront(state.countyLayer);
  }

  refreshLayerLegendText();
  refreshPrimaryCountyHighlight();
  renderLabels();
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
  if (!zone?.primaryCountyFips || !shouldShowCountyLayer()) {
    return;
  }

  const countyFeature = state.countyFeatureByFips.get(zone.primaryCountyFips);
  if (!countyFeature) {
    return;
  }

  state.primaryCountyLayer = L.geoJSON(countyFeature, {
    renderer: primaryCountyRenderer,
    interactive: false,
    style: styleForPrimaryCountyFeature,
  }).addTo(map);
}

function getActiveZones() {
  return state.zones.filter(isListedZone);
}

function refreshModeText() {
  refreshInterfaceStatus();
  const hints = {
    population: "Da maior para a menor população estimada.",
    mortgage: `Score e volume de hipotecas · base ${state.mortgageYear || "disponível"}.`,
    delinquency:
      "Estimativa de atraso, não uma contagem de contratos inadimplentes.",
    "cfpb-delinquency":
      "Reclamações CFPB: sinal de dificuldade, não atraso confirmado.",
    "zone-performance": "Volume por zona e entregas dentro do prazo.",
  };
  modeHintEl.textContent = hints[state.mode];
  legendHotspotLabelEl.textContent = "Destaques do ranking";
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
    descriptions.push(
      `volume 30d ${volumeMin ?? "min"} a ${volumeMax ?? "max"}`,
    );
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

  const workZoneCount = state.zones.filter((zone) =>
    isWorkZone(zone.zoneId),
  ).length;
  const filteredZoneCount = getActiveZones().length;
  const descriptions = activeFilterDescriptions();
  const mapMode = state.mapShowsFilteredZones
    ? "Mapa mostrando apenas filtradas"
    : "Mapa mostrando todas ativas";

  refreshInterfaceStatus();

  if (descriptions.length === 0) {
    filterSummaryEl.textContent = `${mapMode}. ${filteredZoneCount}/${workZoneCount} zonas na lista.`;
    return;
  }

  filterSummaryEl.textContent = `${mapMode}. ${filteredZoneCount}/${workZoneCount} zonas: ${descriptions.join(" • ")}.`;
}

function refreshSelectionDetails() {
  const zone = state.zoneById.get(state.selectedZoneId);
  selectionDetailsEl.hidden = !zone;
  if (!zone) {
    selectionDetailsEl.innerHTML = "";
    return;
  }
  selectionDetailsEl.innerHTML = `<div class="selection-heading"><span class="eyebrow">ZONA SELECIONADA</span><button type="button" class="icon-button" data-action="clear-selection" aria-label="Limpar seleção">×</button></div>
    ${formatSummaryPopup(zone)}
    <button type="button" class="text-button county-action" data-action="show-county">Ver county principal no mapa ↗</button>
    <details><summary>Ver todos os indicadores</summary><div class="full-details">${formatPopup({ properties: { zoneId: zone.zoneId } }, true)}</div></details>`;
}

function refreshDecisionPanel() {
  refreshFilterSummary();
  refreshSelectionDetails();
  refreshSecretFocusUi();
}

function refreshStats() {
  const zones = getActiveZones();
  let first, second, firstLabel, secondLabel;
  if (isZonePerformanceMode()) {
    first = formatNumber(
      zones.reduce((sum, z) => sum + (z.volume30Day || 0), 0),
    );
    second = formatPercent(weightedOnTime(zones));
    firstLabel = "Volume · 30 dias";
    secondLabel = "On-time ponderado";
  } else if (isMortgageMode()) {
    first = formatNumber(
      zones.reduce((sum, z) => sum + (z.mortgageOriginationsCount || 0), 0),
    );
    second = formatNumber(
      zones.filter((z) => z.mortgageOpportunityScore >= 90).length,
    );
    firstLabel = `Hipotecas · ${state.mortgageYear}`;
    secondLabel = "Zonas com score ≥ 90";
  } else if (isDelinquencyMode()) {
    first = formatNumber(
      zones.reduce((sum, z) => sum + (z.estimatedDelinquentLoans || 0), 0),
    );
    second = formatNumber(zones.filter((z) => z.isDelinquencyHotspot).length);
    firstLabel = "Atrasos estimados";
    secondLabel = "Zonas em destaque";
  } else if (isCfpbDelinquencyMode()) {
    first = formatNumber(
      zones.reduce((sum, z) => sum + (z.cfpbDistressComplaintCount || 0), 0),
    );
    second = formatNumber(zones.filter((z) => z.isCfpbDistressHotspot).length);
    firstLabel = "Reclamações CFPB";
    secondLabel = "Zonas em destaque";
  } else {
    first = new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(zones.reduce((sum, z) => sum + z.population, 0));
    second = formatNumber(zones.reduce((sum, z) => sum + z.zipCount, 0));
    firstLabel = "População estimada";
    secondLabel = "ZIPs de 5 dígitos";
  }
  statsEl.innerHTML = `<div class="stat"><strong>${first}</strong><span>${firstLabel}</span></div><div class="stat"><strong>${second}</strong><span>${secondLabel}</span></div>`;
}

function updateSelection(zoneId, focus = true) {
  if (zoneId && !isActiveZone(zoneId)) return;
  state.selectedZoneId = zoneId;
  const zone = state.zoneById.get(zoneId);
  if (zone && state.selectedState && zone.state !== state.selectedState) {
    state.selectedState = zone.state;
    document.querySelector("#state-select").value = zone.state;
    refreshStateTitle();
  }
  refreshStyles();
  refreshPrimaryCountyHighlight();
  renderZoneList();
  renderLabels();
  refreshStats();
  refreshDecisionPanel();
  if (zone && focus) {
    const bounds = state.boundsByZoneId.get(zoneId);
    if (bounds)
      map.fitBounds(bounds.pad(0.2), {
        maxZoom: 10,
        animate: false,
        padding: [35, 70],
      });
  }
  if (!zone) map.closePopup();
}

function buildCountyLayers(geojson) {
  state.countyLabelPoints = (geojson.features || [])
    .map((feature) => {
      const center = labelPoint(feature.geometry);
      if (!center) {
        return null;
      }

      return {
        ...center,
        label:
          feature.properties?.label ||
          `${feature.properties?.countyName || "County"}, ${feature.properties?.state || ""}`,
        state: feature.properties?.state || "",
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.state.localeCompare(b.state) || a.label.localeCompare(b.label),
    );

  state.countyLayer = L.geoJSON(geojson, {
    renderer: countyFillRenderer,
    style: styleForCountyFeature,
    onEachFeature(feature, layer) {
      layer.bindPopup(() => formatCountyPopup(feature));
    },
  });

  state.countyOutlineLayer = L.geoJSON(geojson, {
    renderer: countyOutlineRenderer,
    interactive: false,
    style: styleForCountyOutlineFeature,
  });
}

function buildSecretFocusLayer(geojson) {
  const focusFeatures = (geojson.features || []).filter((feature) =>
    state.secretFocusZoneIds.has(feature.properties?.zoneId),
  );

  if (focusFeatures.length === 0) {
    return;
  }

  state.secretFocusLayer = L.geoJSON(
    {
      type: "FeatureCollection",
      features: focusFeatures,
    },
    {
      renderer: secretFocusRenderer,
      interactive: false,
      style: styleForSecretFocusFeature,
    },
  );
}

function buildZoneLayer(geojson) {
  buildSecretFocusLayer(geojson);

  state.zoneLayer = L.geoJSON(geojson, {
    renderer: zip3Renderer,
    style: styleForFeature,
    onEachFeature(feature, layer) {
      const zoneId = feature.properties.zoneId;
      layer.bindPopup(() => formatPopup(feature), { maxWidth: 300 });
      const point = labelPoint(feature.geometry);
      if (point) state.labelPoints.set(zoneId, point);

      layer.on("click", () => {
        if (isActiveZone(zoneId)) updateSelection(zoneId, false);
        else layer.closePopup();
      });

      const featureBounds = layer.getBounds();
      if (!state.boundsByZoneId.has(zoneId)) {
        state.boundsByZoneId.set(zoneId, L.latLngBounds(featureBounds));
      } else {
        state.boundsByZoneId.get(zoneId).extend(featureBounds);
      }
    },
  }).addTo(map);

  fitState();
}

function zoneMatchesFilter(zone, query) {
  if (!query) {
    return true;
  }

  if (zone.label.toLowerCase().includes(query) || `z${zone.zip3}` === query) {
    return true;
  }

  if (
    zone.state.toLowerCase().includes(query) ||
    zone.stateName.toLowerCase().includes(query)
  ) {
    return true;
  }

  if (
    String(zone.primaryCountyName || "")
      .toLowerCase()
      .includes(query)
  ) {
    return true;
  }

  if (
    String(zone.topZip5 || "").includes(query) ||
    String(zone.topZipCity || "")
      .toLowerCase()
      .includes(query)
  ) {
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
      (b.cfpbDistressComplaintCount || 0) -
        (a.cfpbDistressComplaintCount || 0) ||
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
  const zones = getActiveZones().sort(
    (a, b) =>
      (state.secretFocusEnabled
        ? Number(isSecretFocusZone(b.zoneId)) -
          Number(isSecretFocusZone(a.zoneId))
        : 0) || compareZoneByMode(a, b),
  );
  zoneResultCountEl.textContent = formatNumber(zones.length);
  if (!zones.length) {
    zoneListEl.innerHTML =
      '<div class="empty-state">Nenhuma zona encontrada neste estado. Tente outro estado ou ajuste os filtros.<button class="quiet-button" data-action="clear-filters">Limpar filtros</button></div>';
    return;
  }
  zoneListEl.innerHTML = zones
    .map((zone) => {
      let value, hint;
      if (isZonePerformanceMode()) {
        value = zone.hasZonePerformanceData
          ? formatNumber(zone.volume30Day)
          : "N/D";
        hint = zone.hasZonePerformanceData
          ? `OT ${formatPercent(zone.onTimePct)}`
          : "Sem relatório";
      } else if (isMortgageMode()) {
        value = formatScore(zone.mortgageOpportunityScore);
        hint = `${formatNumber(zone.mortgageOriginationsCount)} hipotecas`;
      } else if (isDelinquencyMode()) {
        value = formatNumber(zone.estimatedDelinquentLoans);
        hint = "Atrasos estimados";
      } else if (isCfpbDelinquencyMode()) {
        value = formatNumber(zone.cfpbDistressComplaintCount);
        hint = "Reclamações CFPB";
      } else {
        value = formatNumber(zone.population);
        hint = `Pop. · #${zone.statePopulationRank} no estado`;
      }
      return `<button type="button" class="zone-item${zone.zoneId === state.selectedZoneId ? " active" : ""}${state.secretFocusEnabled && isSecretFocusZone(zone.zoneId) ? " secret-focus-zone" : ""}" data-zone="${escapeHtml(zone.zoneId)}" aria-pressed="${zone.zoneId === state.selectedZoneId}" style="--zone-color:${colorForZone(zone)}"><span class="zone-color" aria-hidden="true"></span><span class="zone-name"><strong>Z${escapeHtml(zone.zip3)} <small>${escapeHtml(zone.state)}</small></strong><span>${escapeHtml(primaryCountySummary(zone))}</span></span><span class="zone-value"><strong>${value}</strong><span>${hint}</span></span></button>`;
    })
    .join("");
}

function renderZip3Labels() {
  zip3LayerGroup.clearLayers();
  if (!state.showZip3Labels || !shouldShowZip3Layer()) return;
  const candidates = state.zones
    .filter((z) => isActiveZone(z.zoneId))
    .sort(
      (a, b) =>
        Number(b.zoneId === state.selectedZoneId) -
          Number(a.zoneId === state.selectedZoneId) ||
        b.population - a.population,
    );
  for (const zone of candidates) {
    const point = state.labelPoints.get(zone.zoneId);
    if (!point || !map.getBounds().contains([point.latitude, point.longitude]))
      continue;
    const bounds = state.boundsByZoneId.get(zone.zoneId);
    const size = map
      .latLngToContainerPoint(bounds.getNorthEast())
      .subtract(map.latLngToContainerPoint(bounds.getSouthWest()));
    if (Math.abs(size.x) < 35 || Math.abs(size.y) < 20) continue;
    const volume = zoneVolumeLabel(zone);
    const width = state.showZoneVolume ? 100 + volume.length * 8 : 58;
    if (!reserveLabel(point, width, 28)) continue;
    zip3LayerGroup.addLayer(
      L.marker([point.latitude, point.longitude], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: `zip3-label${state.showZoneVolume ? " with-volume" : ""}${zone.zoneId === state.selectedZoneId ? " selected" : ""}${state.secretFocusEnabled ? (isSecretFocusZone(zone.zoneId) ? " covered" : " neighbor") : ""}`,
          html: `<span class="zip3-code">Z${escapeHtml(zone.zip3)}</span>${state.showZoneVolume ? ` <span class="zip3-volume" aria-label="Volume total de 30 dias: ${volume}">${volume} <small>vol</small></span>` : ""}`,
          iconSize: [width, 28],
          iconAnchor: [width / 2, 14],
        }),
      }),
    );
  }
}

function renderCountyLabels() {
  countyLabelLayerGroup.clearLayers();
  if (!state.showCountyLabels || !shouldShowCountyLayer() || map.getZoom() < 6)
    return;
  for (const county of state.countyLabelPoints) {
    if (!map.getBounds().contains([county.latitude, county.longitude]))
      continue;
    const name = county.label.replace(/,?\s+[A-Z]{2}$/, "");
    const width = Math.max(70, name.length * 7);
    if (!reserveLabel(county, width, 22)) continue;
    countyLabelLayerGroup.addLayer(
      L.marker([county.latitude, county.longitude], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "county-label",
          html: escapeHtml(name),
          iconSize: [width, 18],
          iconAnchor: [width / 2, 9],
        }),
      }),
    );
  }
}

function renderCityLabels() {
  cityLayerGroup.clearLayers();
  if (!state.showCities || map.getZoom() < 6) return;
  const bounds = map.getBounds();
  const cities = state.cities
    .filter(
      (city) =>
        Number.isFinite(city.latitude) &&
        Number.isFinite(city.longitude) &&
        bounds.contains([city.latitude, city.longitude]) &&
        city.zoneIds.some(isActiveZone),
    )
    .sort((a, b) => b.population - a.population);
  let count = 0;
  for (const city of cities) {
    const width = city.city.length * 6 + 12;
    const offsets =
      city.population >= 100000
        ? [
            [0, 0],
            [4, 22],
            [4, -22],
            [-width - 4, 0],
            [-width / 2, 32],
            [-width / 2, -32],
            [34, 16],
            [34, -16],
            [-width - 8, 34],
            [-width - 8, -34],
          ]
        : [[0, 0]];
    const offset = offsets.find(([x, y]) =>
      reserveLabel(city, width, 20, false, x, y),
    );
    if (!offset) continue;
    cityLayerGroup.addLayer(
      L.marker([city.latitude, city.longitude], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "city-label",
          html: `<span data-city="${escapeHtml(city.key)}">${escapeHtml(city.city)}</span>`,
          iconSize: [width, 18],
          iconAnchor: [-offset[0], 9 - offset[1]],
        }),
      }),
    );
    if (++count >= 100) break;
  }
}

let labelBoxes = [];
function reserveLabel(
  point,
  width,
  height,
  centered = true,
  offsetX = 0,
  offsetY = 0,
) {
  const p = map.latLngToContainerPoint([point.latitude, point.longitude]);
  p.x += offsetX;
  p.y += offsetY;
  const size = map.getSize();
  const box = {
    left: p.x - (centered ? width / 2 : 0) - 3,
    right: p.x + (centered ? width / 2 : width) + 3,
    top: p.y - height / 2 - 3,
    bottom: p.y + height / 2 + 3,
  };
  if (
    box.left < 4 ||
    box.right > size.x - 4 ||
    box.top < 4 ||
    box.bottom > size.y - 32 ||
    labelBoxes.some((b) => overlaps(box, b))
  )
    return false;
  labelBoxes.push(box);
  return true;
}
function renderLabels() {
  if (!state.dataReady) return;
  const mapRect = map.getContainer().getBoundingClientRect();
  labelBoxes = [...document.querySelectorAll(
    ".map-toolbar, #coverage-toolbar, #toggle-zone-volume, .map-reset, .map-bottom, .leaflet-control-zoom",
  )].filter((el) => el.getClientRects().length).map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left - mapRect.left - 8,
      right: rect.right - mapRect.left + 8,
      top: rect.top - mapRect.top - 8,
      bottom: rect.bottom - mapRect.top + 8,
    };
  });
  renderZip3Labels();
  renderCountyLabels();
  renderCityLabels();
}
function refreshStateTitle() {
  document.querySelector("#map-state-title").textContent =
    state.states.find((s) => s.state === state.selectedState)?.stateName ||
    "ESTADOS UNIDOS";
}
function fitState() {
  // Alaska straddles the date line; raw longitude bounds would frame almost the entire world.
  if (state.selectedState === "AK") {
    map.fitBounds(
      [
        [51, -180],
        [72, -129],
      ],
      { animate: false, padding: [32, 65] },
    );
    return;
  }
  if (!state.selectedState) {
    map.fitBounds(
      [
        [24, -125],
        [50, -66],
      ],
      { animate: false, padding: [35, 70] },
    );
    return;
  }
  const bounds = L.latLngBounds([]);
  for (const zone of state.zones.filter(
    (z) => z.state === state.selectedState,
  )) {
    const b = state.boundsByZoneId.get(zone.zoneId);
    if (b) bounds.extend(b);
  }
  if (bounds.isValid())
    map.fitBounds(bounds, { animate: false, padding: [32, 65], maxZoom: 9 });
}
function fitResults() {
  const zones = getActiveZones();
  if (!state.selectedState && zones.length > 100) {
    fitState();
    return;
  }
  const bounds = L.latLngBounds([]);
  for (const zone of zones) {
    const b = state.boundsByZoneId.get(zone.zoneId);
    if (b) bounds.extend(b);
  }
  if (bounds.isValid())
    map.fitBounds(bounds, { animate: false, padding: [32, 65], maxZoom: 10 });
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
    const stateSet = new Set(
      payload.states.map((entry) => String(entry).trim().toUpperCase()),
    );
    for (const zone of state.zones) {
      if (stateSet.has(zone.state)) {
        activeZoneIds.add(zone.zoneId);
      }
    }
  }

  if (Array.isArray(payload?.zip3)) {
    const prefixSet = new Set(
      payload.zip3.map((entry) => normalizeZip3(entry)),
    );
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
    const workZonesResp = await fetch(
      `./data/work_zones.json?v=${DATA_VERSION}`,
    );
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
    payload.zones.map((zone) => [normalizeZoneId(zone.zoneId), zone]),
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
        isZonePerformanceHotspot: false,
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
      isZonePerformanceHotspot: performance.volume30DayRank <= hotspotLimit,
    });
  }

  state.hasZonePerformanceData = state.zones.some(
    (zone) => zone.hasZonePerformanceData,
  );
  state.zonePerformanceTotals = payload.totals || null;
  state.zonePerformanceSource = payload.source || null;
}

function attachSecretFocusData(payload) {
  state.secretFocusZoneIds = new Set();
  state.secretFocusByZoneId = new Map();
  state.secretFocusTotals = null;

  if (!payload || !Array.isArray(payload.zones)) {
    return;
  }

  for (const zone of payload.zones) {
    const zoneId = normalizeZoneId(zone.zoneId);
    if (!zoneId || !state.zoneById.has(zoneId)) {
      continue;
    }

    const entry = {
      zoneId,
      volume30Day: Number(zone.volume30Day) || 0,
      onTimePct: zone.onTimePct != null && Number.isFinite(Number(zone.onTimePct))
        ? Number(zone.onTimePct)
        : null,
    };
    state.secretFocusZoneIds.add(zoneId);
    state.secretFocusByZoneId.set(zoneId, entry);
  }

  const totalVolume30Day = [...state.secretFocusByZoneId.values()].reduce(
    (sum, zone) => sum + zone.volume30Day,
    0,
  );
  const weightedOnTimePct = weightedOnTime(
    [...state.secretFocusByZoneId.values()].map((zone) => ({
      ...zone, hasZonePerformanceData: true,
    })),
  );

  state.secretFocusTotals = {
    zoneCount: state.secretFocusZoneIds.size,
    totalVolume30Day,
    weightedOnTimePct,
  };
}

function isSecretFocusZone(zoneId) {
  return state.secretFocusZoneIds.has(zoneId);
}

function secretFocusMetricSummary(zoneId) {
  const focus = state.secretFocusByZoneId.get(zoneId);
  if (!focus) {
    return "";
  }

  return `${formatNumber(focus.volume30Day)} vol 30d • OT ${formatPercent(focus.onTimePct)}`;
}

function refreshSecretFocusUi() {
  const showHotspots = state.highlightHotspots && !state.secretFocusEnabled;
  legendHotspotLabelEl.hidden = !showHotspots;
  document.querySelector(".swatch.hotspot").hidden = !showHotspots;
  appShellEl.classList.toggle("coverage-active", state.secretFocusEnabled);
  document.querySelector("#coverage-toolbar").hidden =
    !state.secretFocusEnabled;
  document
    .querySelector("#coverage-only")
    .setAttribute("aria-pressed", String(state.coverageOnly));
  if (secretFocusToggleButton) {
    secretFocusToggleButton.disabled =
      !state.dataReady || !state.secretFocusTotals;
    secretFocusToggleButton.classList.toggle(
      "active",
      state.secretFocusEnabled,
    );
    secretFocusToggleButton.setAttribute(
      "aria-pressed",
      String(state.secretFocusEnabled),
    );
  }

  if (!secretFocusSummaryEl) {
    return;
  }

  if (!state.secretFocusEnabled || !state.secretFocusTotals) {
    secretFocusSummaryEl.hidden = true;
    secretFocusSummaryEl.textContent = "";
    return;
  }

  const zones = coverageZonesInScope();
  const region =
    state.states.find((s) => s.state === state.selectedState)?.stateName ||
    "EUA";
  const countLabel = `${zones.length} ${zones.length === 1 ? "zona sua" : "zonas suas"} em ${region}`;
  document.querySelector("#coverage-count").textContent = countLabel;
  document.querySelector("#coverage-fit").disabled = !zones.length;
  secretFocusSummaryEl.hidden = false;
  secretFocusSummaryEl.textContent = zones.length
    ? `${countLabel}. Rosa mostra onde você já trabalha; cinza mostra as vizinhas. Os filtros continuam valendo.`
    : `Nenhuma área sua neste recorte. Altere o estado ou limpe os filtros para ver sua cobertura.`;
}

function coverageZonesInScope() {
  return state.zones.filter(
    (zone) =>
      isSecretFocusZone(zone.zoneId) &&
      (!state.selectedState || zone.state === state.selectedState) &&
      zonePassesActiveFilters(zone),
  );
}

function fitCoverage() {
  const bounds = L.latLngBounds([]);
  for (const zone of coverageZonesInScope()) {
    const zoneBounds = state.boundsByZoneId.get(zone.zoneId);
    if (zoneBounds) bounds.extend(zoneBounds);
  }
  if (bounds.isValid())
    map.fitBounds(bounds, {
      animate: false,
      paddingTopLeft: [35, 190],
      paddingBottomRight: [35, 60],
      maxZoom: 10,
    });
}

function syncFilterStateFromInputs() {
  state.filters.scoreMin = scoreMinInput?.value || "";
  state.filters.scoreMax = scoreMaxInput?.value || "";
  state.filters.volume30DayMin = volume30DayMinInput?.value || "";
  state.filters.volume30DayMax = volume30DayMaxInput?.value || "";
  state.filters.mortgageLoansMin = mortgageLoansMinInput?.value || "";
  state.filters.housingMin = housingMinInput?.value || "";
  state.mapShowsFilteredZones = toggleFilteredMapInput
    ? toggleFilteredMapInput.checked
    : true;
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
    housingMinInput,
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
    map.closePopup();
  }

  refreshSecretFocusUi();
  refreshLayerLegendText();
  refreshStyles();
  refreshPrimaryCountyHighlight();
  renderZoneList();
  renderLabels();
  refreshStats();
  refreshDecisionPanel();
}

function setupControls() {
  zoneVolumeToggleButton.addEventListener("click", () => {
    state.showZoneVolume = !state.showZoneVolume;
    zoneVolumeToggleButton.setAttribute("aria-pressed", String(state.showZoneVolume));
    if (state.showZoneVolume) {
      state.showZip3Labels = true;
      toggleZip3LabelsInput.checked = true;
      if (state.mapLayerMode === "counties") {
        state.mapLayerMode = "both";
        layerModeSelect.value = "both";
        refreshLayerVisibility();
      }
    }
    renderLabels();
  });
  document.querySelector("#coverage-only").addEventListener("click", () => {
    state.coverageOnly = !state.coverageOnly;
    applyFilterChanges();
  });
  document
    .querySelector("#coverage-fit")
    .addEventListener("click", fitCoverage);
  if (window.matchMedia("(max-width:700px)").matches) setPanelCollapsed(true);
  document
    .querySelector("#state-select")
    .addEventListener("change", (event) => {
      state.selectedState = event.target.value;
      state.selectedZoneId = null;
      map.closePopup();
      clearFilters();
      refreshStateTitle();
      applyFilterChanges();
      fitState();
    });
  document.querySelector("#view-usa").addEventListener("click", () => {
    state.selectedState = "";
    document.querySelector("#state-select").value = "";
    state.selectedZoneId = null;
    map.closePopup();
    clearFilters();
    refreshStateTitle();
    applyFilterChanges();
    fitState();
  });
  document.querySelector("#fit-state").addEventListener("click", fitState);
  document.querySelector("#fit-results").addEventListener("click", () => {
    if (window.matchMedia("(max-width:700px)").matches) setPanelCollapsed(true);
    fitResults();
  });
  zoneListEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-zone]");
    if (button) {
      if (window.matchMedia("(max-width:700px)").matches)
        setPanelCollapsed(true);
      updateSelection(button.dataset.zone);
      const zone = state.zoneById.get(button.dataset.zone);
      const point = state.labelPoints.get(zone.zoneId);
      if (point)
        L.popup({ maxWidth: 300 })
          .setLatLng([point.latitude, point.longitude])
          .setContent(formatPopup({ properties: { zoneId: zone.zoneId } }))
          .openOn(map);
    } else if (event.target.closest('[data-action="clear-filters"]')) {
      clearFilters();
      applyFilterChanges();
    }
  });
  selectionDetailsEl.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "clear-selection") updateSelection(null);
    if (action === "show-county") {
      map.closePopup();
      state.mapLayerMode = "both";
      layerModeSelect.value = "both";
      refreshLayerVisibility();
      if (window.matchMedia("(max-width:700px)").matches)
        setPanelCollapsed(true);
      const bounds = state.boundsByZoneId.get(state.selectedZoneId);
      if (bounds)
        map.fitBounds(bounds.pad(0.1), {
          animate: false,
          padding: [35, 70],
          maxZoom: 10,
        });
    }
  });
  panelCollapseToggleButton?.addEventListener("click", () => {
    setPanelCollapsed(true);
  });

  panelReopenButton?.addEventListener("click", () => {
    setPanelCollapsed(false);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      setPanelCollapsed(false);
      filterInput?.focus();
    }

    if (
      event.key === "Escape" &&
      document.activeElement === filterInput &&
      filterInput.value
    ) {
      filterInput.value = "";
      state.filter = "";
      applyFilterChanges();
    }
  });

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
    housingMinInput,
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

  secretFocusToggleButton?.addEventListener("click", () => {
    state.secretFocusEnabled = !state.secretFocusEnabled;
    if (!state.secretFocusEnabled) state.coverageOnly = false;
    if (state.secretFocusEnabled && state.mapLayerMode === "counties") {
      state.mapLayerMode = "both";
      layerModeSelect.value = "both";
    }
    refreshSecretFocusUi();
    refreshLayerVisibility();
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

    if (
      !state.hasMortgageData &&
      (state.mode === "mortgage" || state.mode === "delinquency")
    ) {
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
    renderLabels();
    refreshStyles();
    renderZoneList();
    refreshStats();
    refreshDecisionPanel();
  });

  layerModeSelect.addEventListener("change", (event) => {
    const nextMode = String(event.target.value || "zip3");
    state.mapLayerMode =
      nextMode === "counties" || nextMode === "both" ? nextMode : "zip3";
    if (state.mapLayerMode === "counties") {
      state.showZoneVolume = false;
      zoneVolumeToggleButton.setAttribute("aria-pressed", "false");
    }
    if (state.mapLayerMode === "counties" && state.secretFocusEnabled) {
      state.secretFocusEnabled = false;
      state.coverageOnly = false;
      applyFilterChanges();
    }
    refreshLayerVisibility();
  });

  popupModeSelect.addEventListener("change", (event) => {
    state.popupMode =
      String(event.target.value || "summary") === "full" ? "full" : "summary";
    map.closePopup();
  });

  toggleCitiesInput.addEventListener("change", (event) => {
    state.showCities = event.target.checked;
    renderLabels();
  });

  toggleZip3LabelsInput.addEventListener("change", (event) => {
    state.showZip3Labels = event.target.checked;
    if (!state.showZip3Labels) {
      state.showZoneVolume = false;
      zoneVolumeToggleButton.setAttribute("aria-pressed", "false");
    }
    renderLabels();
  });

  toggleCountyLabelsInput.addEventListener("change", (event) => {
    state.showCountyLabels = event.target.checked;
    renderLabels();
  });

  toggleHotspotsInput.addEventListener("change", (event) => {
    state.highlightHotspots = event.target.checked;
    legendHotspotLabelEl.hidden = !state.highlightHotspots;
    document.querySelector(".swatch.hotspot").hidden = !state.highlightHotspots;
    refreshStyles();
    renderZoneList();
    refreshStats();
    refreshDecisionPanel();
  });
}

async function loadData() {
  const [
    geoResp,
    zonesResp,
    citiesResp,
    statesResp,
    performanceResp,
    countiesResp,
    secretFocusResp,
  ] = await Promise.all([
    fetch(`./data/coverage_zip3.geojson?v=${DATA_VERSION}`),
    fetch(`./data/coverage_zip3_zones.json?v=${DATA_VERSION}`),
    fetch(`./data/coverage_cities.json?v=${DATA_VERSION}`),
    fetch(`./data/coverage_states.json?v=${DATA_VERSION}`),
    fetch(`./data/zone_performance_30day.json?v=${DATA_VERSION}`).catch(
      () => null,
    ),
    fetch(`./data/coverage_counties.geojson?v=${DATA_VERSION}`).catch(
      () => null,
    ),
    fetch(`./data/secret_focus_zones.json?v=${DATA_VERSION}`).catch(() => null),
  ]);

  if (!geoResp.ok || !zonesResp.ok || !citiesResp.ok || !statesResp.ok) {
    throw new Error(
      "Nao foi possivel carregar os arquivos de dados. Rode 'npm run prepare-data'.",
    );
  }

  const zoneGeojson = await geoResp.json();
  const countyGeojson = countiesResp?.ok ? await countiesResp.json() : null;
  state.zones = await zonesResp.json();
  state.cities = await citiesResp.json();
  state.states = await statesResp.json();
  state.totalZoneFeatureCount = zoneGeojson.features.length;
  state.totalCountyFeatureCount = Array.isArray(countyGeojson?.features)
    ? countyGeojson.features.length
    : 0;
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

  if (secretFocusResp?.ok) {
    attachSecretFocusData(await secretFocusResp.json());
  }

  state.activeZoneIds = new Set(state.zones.map((zone) => zone.zoneId));
  await loadWorkZones();

  if (state.zones.length > 0) {
    state.hasMortgageData = Boolean(state.zones[0].hasMortgageData);
    state.hasCfpbDistressData = Boolean(state.zones[0].hasCfpbDistressData);
    state.mortgageYear = state.zones[0].mortgageYear || null;
  }

  if (
    (!state.hasMortgageData &&
      (state.mode === "mortgage" || state.mode === "delinquency")) ||
    (!state.hasCfpbDistressData && state.mode === "cfpb-delinquency") ||
    (!state.hasZonePerformanceData && state.mode === "zone-performance")
  ) {
    modeSelect.value = "population";
    state.mode = "population";
  }

  if (state.totalCountyFeatureCount > 0) {
    buildCountyLayers(countyGeojson);
  }

  buildZoneLayer(zoneGeojson);
  const stateSelect = document.querySelector("#state-select");
  stateSelect.innerHTML =
    '<option value="">Todos os estados</option>' +
    [...state.states]
      .sort((a, b) => a.stateName.localeCompare(b.stateName))
      .map(
        (s) =>
          `<option value="${escapeHtml(s.state)}">${escapeHtml(s.stateName)}</option>`,
      )
      .join("");
  stateSelect.value = state.selectedState;
  refreshStateTitle();
  state.dataReady = true;
  document.querySelector("#map-loading").hidden = true;
  refreshLayerVisibility();
  refreshModeText();
  renderZoneList();
  refreshStats();
  refreshSecretFocusUi();
  refreshDecisionPanel();
}

setupControls();

loadData().catch((error) => {
  console.error(error);
  state.dataReady = false;
  refreshInterfaceStatus();
  statsEl.textContent = "Não foi possível carregar os dados.";
  dataStatusTextEl.textContent = "Falha no carregamento";
  const loading = document.querySelector("#map-loading");
  loading.innerHTML =
    '<strong>Não foi possível abrir o mapa</strong><span>Verifique sua conexão e tente novamente.</span><button type="button" class="quiet-button" id="retry-loading">Tentar novamente</button>';
  document
    .querySelector("#retry-loading")
    .addEventListener("click", () => location.reload());
});
