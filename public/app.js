const map = L.map("map", {
  zoomControl: false,
  preferCanvas: true
});

const DATA_VERSION = "all-us-v3";

L.control.zoom({ position: "topright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

map.setView([40.2, -79.2], 6);

const zip3LayerGroup = L.layerGroup().addTo(map);
const cityLayerGroup = L.layerGroup().addTo(map);

const state = {
  selectedZoneId: null,
  mode: "population",
  hasMortgageData: false,
  mortgageYear: null,
  zones: [],
  cities: [],
  states: [],
  activeZoneIds: new Set(),
  zoneById: new Map(),
  boundsByZoneId: new Map(),
  zoneLayer: null,
  filter: "",
  showCities: true,
  showZip3Labels: true,
  highlightHotspots: true,
  totalZoneFeatureCount: 0
};

const filterInput = document.querySelector("#zip3-filter");
const modeSelect = document.querySelector("#analysis-mode");
const modeHintEl = document.querySelector("#analysis-mode-hint");
const toggleCitiesInput = document.querySelector("#toggle-cities");
const toggleZip3LabelsInput = document.querySelector("#toggle-zip3-labels");
const toggleHotspotsInput = document.querySelector("#toggle-hotspots");
const zoneListEl = document.querySelector("#zone-list");
const statsEl = document.querySelector("#stats");
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

function normalizeZoneId(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replaceAll(" ", "");
}

function normalizeZip3(value) {
  return String(value || "").trim().padStart(3, "0");
}

function colorForZone(zone) {
  const zip3Number = Number.parseInt(zone.zip3, 10);
  const stateSeed = zone.state.charCodeAt(0) + zone.state.charCodeAt(1);
  const hue = Number.isFinite(zip3Number) ? (zip3Number * 31 + stateSeed * 11) % 360 : 210;
  return `hsl(${hue}, 72%, 50%)`;
}

function isActiveZone(zoneId) {
  return state.activeZoneIds.has(zoneId);
}

function isMortgageMode() {
  return state.mode === "mortgage" && state.hasMortgageData;
}

function isDelinquencyMode() {
  return state.mode === "delinquency" && state.hasMortgageData;
}

function isZoneHotspot(zone) {
  if (!zone) {
    return false;
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

function formatPopup(feature) {
  const zone = state.zoneById.get(feature.properties.zoneId);
  if (!zone) {
    return "Zona indisponivel";
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
    Hotspot ativo no modo atual: ${hotspotLabel}<br/>
    <small>${escapeHtml(cityPreview(zone.cities, 7))}</small>
  `;
}

function refreshStyles() {
  if (!state.zoneLayer) {
    return;
  }

  state.zoneLayer.setStyle(styleForFeature);
  bringSelectionToFront();
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

function getActiveZones() {
  return state.zones.filter((zone) => isActiveZone(zone.zoneId));
}

function refreshModeText() {
  if (!modeHintEl) {
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
  } else {
    modeHintEl.textContent = "Modo Populacao: destaque automatico para zonas mais populosas.";
  }

  if (legendHotspotLabelEl) {
    legendHotspotLabelEl.textContent = "Hotspot populacional";
  }
}

function refreshStats() {
  const activeZones = getActiveZones();
  const activeZoneCount = activeZones.length;
  const activeStates = new Set(activeZones.map((zone) => zone.state));
  const hotspotCount = activeZones.filter((zone) => isZoneHotspot(zone)).length;

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
  renderZoneList();
  renderZip3Labels();
  renderCityLabels();
  refreshStats();

  if (state.selectedZoneId) {
    const bounds = state.boundsByZoneId.get(state.selectedZoneId);
    if (bounds) {
      map.fitBounds(bounds.pad(0.2));
    }
  }
}

function buildZoneLayer(geojson) {
  state.zoneLayer = L.geoJSON(geojson, {
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

  return zone.cities.some((city) => city.toLowerCase().includes(query));
}

function compareZoneByMode(a, b) {
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

  const query = state.filter.trim().toLowerCase();
  const visibleZones = state.zones
    .filter((zone) => isActiveZone(zone.zoneId))
    .filter((zone) => zoneMatchesFilter(zone, query))
    .sort(compareZoneByMode);

  if (visibleZones.length === 0) {
    zoneListEl.innerHTML = `<div class="zone-item">Nenhuma zona encontrada para "${escapeHtml(query)}".</div>`;
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

    if (isDelinquencyMode()) {
      button.innerHTML = `
        <div class="zone-title">
          <span>${escapeHtml(zone.label)}</span>
          <span>${formatNumber(zone.estimatedDelinquentLoans)} delinquent</span>
        </div>
        <div class="zone-meta">${escapeHtml(zone.stateName)} • taxa ${escapeHtml(formatPercent(zone.estimatedDelinquencyRatePct))} • risco ${escapeHtml(formatScore(zone.delinquencyRiskScore))} ${hotspotTag}</div>
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
  if (!state.showZip3Labels) {
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

function setupControls() {
  filterInput.addEventListener("input", (event) => {
    state.filter = event.target.value;
    renderZoneList();
  });

  modeSelect.addEventListener("change", (event) => {
    const nextMode = String(event.target.value || "population");
    if (nextMode === "mortgage" || nextMode === "delinquency") {
      state.mode = nextMode;
    } else {
      state.mode = "population";
    }

    if (!state.hasMortgageData && state.mode !== "population") {
      state.mode = "population";
      modeSelect.value = "population";
    }

    refreshModeText();
    refreshStyles();
    renderZoneList();
    refreshStats();
  });

  toggleCitiesInput.addEventListener("change", (event) => {
    state.showCities = event.target.checked;
    renderCityLabels();
  });

  toggleZip3LabelsInput.addEventListener("change", (event) => {
    state.showZip3Labels = event.target.checked;
    renderZip3Labels();
  });

  toggleHotspotsInput.addEventListener("change", (event) => {
    state.highlightHotspots = event.target.checked;
    refreshStyles();
    renderZoneList();
    refreshStats();
  });
}

async function loadData() {
  const [geoResp, zonesResp, citiesResp, statesResp] = await Promise.all([
    fetch(`./data/coverage_zip3.geojson?v=${DATA_VERSION}`),
    fetch(`./data/coverage_zip3_zones.json?v=${DATA_VERSION}`),
    fetch(`./data/coverage_cities.json?v=${DATA_VERSION}`),
    fetch(`./data/coverage_states.json?v=${DATA_VERSION}`)
  ]);

  if (!geoResp.ok || !zonesResp.ok || !citiesResp.ok || !statesResp.ok) {
    throw new Error("Nao foi possivel carregar os arquivos de dados. Rode 'npm run prepare-data'.");
  }

  const zoneGeojson = await geoResp.json();
  state.zones = await zonesResp.json();
  state.cities = await citiesResp.json();
  state.states = await statesResp.json();
  state.totalZoneFeatureCount = zoneGeojson.features.length;

  state.zoneById = new Map();

  for (const zone of state.zones) {
    state.zoneById.set(zone.zoneId, zone);
  }

  state.activeZoneIds = new Set(state.zones.map((zone) => zone.zoneId));
  await loadWorkZones();

  if (state.zones.length > 0) {
    state.hasMortgageData = Boolean(state.zones[0].hasMortgageData);
    state.mortgageYear = state.zones[0].mortgageYear || null;
  }

  if (!state.hasMortgageData) {
    modeSelect.value = "population";
    state.mode = "population";
  }

  buildZoneLayer(zoneGeojson);
  refreshModeText();
  renderZoneList();
  refreshStats();
  renderZip3Labels();
  renderCityLabels();
}

setupControls();

loadData().catch((error) => {
  console.error(error);
  statsEl.textContent = "Erro ao carregar dados. Rode 'npm run prepare-data' e recarregue a pagina.";
});
