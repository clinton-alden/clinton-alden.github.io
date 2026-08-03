const FIRMS_API_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const FIRMS_MAP_KEY = 'ba50bf93112cabcd9ed7c7f5e71f631a';
const FEMS_API_URL = 'https://fems.fs2c.usda.gov/api/climatology/graphql';
const WESTERN_US_VIEW = {
  center: [41.8, -115.5],
  zoom: 5,
  bounds: [[31.5, -125.5], [49.5, -102]]
};

const state = {
  map: null,
  layer: null,
  fuelLayer: null,
  pm25Layer: null,
  incidentLayer: null,
  smokeOverlay: null,
  smokeWindLayer: null,
  smokeManifest: null,
  smokeWinds: null,
  smokePlayback: null,
  smokeFrameRequest: 0,
  smokeTimeElement: null,
  smokeScaleElement: null,
  incidentData: null,
  filteredIncidents: [],
  incidentListRows: [],
  fuelRows: [],
  pm25Rows: [],
  fuelDate: '',
  allRows: [],
  visibleRows: [],
  lastCsv: '',
  lastSources: [],
  fireMarkerScale: null,
  mobileIncidentListExpanded: false
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  if (!els.map || typeof L === 'undefined') return;

  initMap();
  initControls();
  updateBoundsLabel();
  loadCachedFireData();
  loadIncidents();
  loadPm25();
  renderActiveLayers();
  window.setInterval(() => {
    loadIncidents();
    loadPm25();
  }, 60 * 60 * 1000);
});

function cacheElements() {
  [
    'fire-day-range',
    'fire-date',
    'fire-min-frp',
    'fire-min-frp-label',
    'fire-reset-view',
    'load-fire-data',
    'download-fire-csv',
    'fire-status',
    'fire-bounds-label',
    'fire-count',
    'fire-updated',
    'show-fire-data',
    'show-fuel-moisture',
    'show-pm25',
    'pm25-mode',
    'show-incidents',
    'incident-filter',
    'incident-state',
    'incident-summary',
    'incident-list',
    'incident-list-toggle',
    'mobile-layers-toggle',
    'mobile-layers-close',
    'mobile-reset-view',
    'mobile-clear-overlays',
    'mobile-incidents-toggle',
    'mobile-incidents-close',
    'fuel-moisture-class',
    'fuel-moisture-date',
    'load-fuel-moisture',
    'fuel-moisture-status',
    'fuel-moisture-legend',
    'pm25-status',
    'pm25-legend',
    'show-smoke',
    'show-smoke-wind',
    'smoke-field',
    'smoke-hour',
    'smoke-hour-label',
    'smoke-play',
    'smoke-opacity',
    'smoke-opacity-label',
    'smoke-options',
    'smoke-status'
  ].forEach(id => {
    els[toCamel(id)] = document.getElementById(id);
  });
  els.map = document.getElementById('fire-map');
}

function toCamel(id) {
  return id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function initMap() {
  state.map = L.map(els.map, {
    preferCanvas: true,
    zoomControl: true,
    zoomAnimation: true,
    fadeAnimation: true,
    markerZoomAnimation: true,
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    wheelPxPerZoomLevel: 90
  }).fitBounds(WESTERN_US_VIEW.bounds);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
  }).addTo(state.map);

  state.map.createPane('smokePane');
  state.map.getPane('smokePane').style.zIndex = 350;
  state.map.createPane('roadsPane');
  state.map.getPane('roadsPane').style.zIndex = 360;
  state.map.createPane('firePane');
  state.map.getPane('firePane').style.zIndex = 410;
  state.map.createPane('pm25Pane');
  state.map.getPane('pm25Pane').style.zIndex = 420;
  state.map.createPane('windPane');
  state.map.getPane('windPane').style.zIndex = 430;
  L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    pane: 'roadsPane',
    attribution: 'Roads &copy; Esri'
  }).addTo(state.map);

  state.layer = L.layerGroup().addTo(state.map);
  state.fuelLayer = L.layerGroup().addTo(state.map);
  state.pm25Layer = L.layerGroup().addTo(state.map);
  state.smokeWindLayer = L.layerGroup().addTo(state.map);
  state.incidentLayer = L.layerGroup().addTo(state.map);
  const smokeTimeControl = L.control({ position: 'bottomleft' });
  smokeTimeControl.onAdd = () => {
    state.smokeTimeElement = L.DomUtil.create('div', 'fire-smoke-time-control');
    state.smokeTimeElement.hidden = true;
    L.DomEvent.disableClickPropagation(state.smokeTimeElement);
    return state.smokeTimeElement;
  };
  smokeTimeControl.addTo(state.map);
  const smokeScaleControl = L.control({ position: 'bottomright' });
  smokeScaleControl.onAdd = () => {
    state.smokeScaleElement = L.DomUtil.create('div', 'fire-smoke-scale-control');
    state.smokeScaleElement.hidden = true;
    L.DomEvent.disableClickPropagation(state.smokeScaleElement);
    return state.smokeScaleElement;
  };
  smokeScaleControl.addTo(state.map);
  state.map.on('moveend', updateBoundsLabel);
  state.map.on('zoomend', rerenderFireMarkersForZoom);
}

async function loadIncidents() {
  try {
    const response = await fetch('assets/live/incidents.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Incident data unavailable.');
    renderIncidents(await response.json());
  } catch (error) {
    console.warn('Incident layer unavailable.', error);
  }
}

function renderIncidents(data) {
    state.incidentData = data;
    state.incidentLayer.clearLayers();
    populateIncidentStates(data.incidents.features || []);
    const incidents = (data.incidents.features || []).filter(incidentMatches);
    state.filteredIncidents = incidents;
    if (!els.showIncidents.checked) {
      renderMarkers();
      renderIncidentList();
      return;
    }
    const majorOnly = els.incidentFilter.value === 'major';
    L.geoJSON(data.perimeters, {
      filter: feature => incidents.some(incident => incident.properties.IncidentName === feature.properties.IncidentName),
      style: { color: '#fb7185', weight: 2, fillColor: '#ef4444', fillOpacity: 0.12 },
      onEachFeature: (feature, layer) => layer.bindPopup(incidentPopup(feature.properties))
    }).addTo(state.incidentLayer);
    L.geoJSON(data.incidents, {
      filter: incidentMatches,
      pointToLayer: (feature, latlng) => L.marker(latlng, {
        icon: L.divIcon({ className: 'incident-fire-icon', html: '<span aria-hidden="true">&#128293;</span>', iconSize: [24, 24], iconAnchor: [12, 12] })
      }),
      onEachFeature: (feature, layer) => layer.bindPopup(incidentPopup(feature.properties))
    }).addTo(state.incidentLayer);
    renderMarkers();
    renderIncidentList();
}

function incidentMatches(feature) {
  const properties = feature.properties || {};
  const majorOnly = els.incidentFilter.value === 'major';
  const stateFilter = els.incidentState.value;
  return (!majorOnly || incidentAcres(properties) >= 1000) && (!stateFilter || properties.POOState === stateFilter);
}

function populateIncidentStates(features) {
  if (els.incidentState.options.length > 1) return;
  [...new Set(features.map(feature => feature.properties?.POOState).filter(Boolean))].sort().forEach(stateCode => {
    els.incidentState.add(new Option(stateCode.replace(/^US-/, ''), stateCode));
  });
}

function renderIncidentList() {
  const rows = [...state.filteredIncidents].sort((a, b) => incidentAcres(b.properties) - incidentAcres(a.properties));
  state.incidentListRows = rows;
  els.incidentSummary.textContent = `${rows.length.toLocaleString()} incident${rows.length === 1 ? '' : 's'}${state.incidentData?.stale ? ' (refresh delayed)' : ''}`;
  els.incidentList.innerHTML = rows.slice(0, 30).map((feature, index) => {
    const properties = feature.properties || {};
    const name = properties.IncidentName || 'Unnamed incident';
    const acres = incidentAcres(properties);
    const containment = properties.PercentContained;
    return `<li><button type="button" class="incident-list-button" data-incident-index="${index}"><strong>${escapeHtml(name)}</strong><span>${properties.POOState?.replace('US-', '') || 'US'} | ${formatNumber(acres)} acres${containment !== null && containment !== undefined ? ` | ${formatNumber(containment)}% contained` : ''}</span></button></li>`;
  }).join('');
  els.incidentList.classList.toggle('is-expanded', state.mobileIncidentListExpanded);
  els.incidentListToggle.hidden = rows.length <= 5;
  els.incidentListToggle.textContent = state.mobileIncidentListExpanded ? 'Show fewer incidents' : 'Show all incidents';
}

function focusIncident(index) {
  const feature = state.incidentListRows[index];
  const [longitude, latitude] = feature?.geometry?.coordinates || [];
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) state.map.setView([latitude, longitude], 10);
}

function incidentAcres(properties = {}) {
  return Number(properties.DailyAcres || properties.GISAcres || properties.CalculatedAcres || 0);
}

function incidentPopup(properties = {}) {
  const name = properties.IncidentName || properties.Incident || properties.FireName || 'Active incident';
  const acres = properties.DailyAcres || properties.GISAcres || properties.IncidentSize || properties.CalculatedAcres || properties.Acres;
  const containment = properties.PercentContained || properties.PercentPerimeterToBeContained;
  const updated = properties.ModifiedOnDateTime || properties.DateCurrent;
  const inciwebUrl = `https://inciweb.wildfire.gov/accessible-view?combine=${encodeURIComponent(name)}`;
  return `<div class="fire-popup"><strong>${escapeHtml(name)}</strong><span>${acres ? `${formatNumber(acres)} acres` : 'Acreage unavailable'}</span><span>${containment !== undefined && containment !== null ? `${formatNumber(containment)}% contained` : 'Containment unavailable'}</span><span>${updated ? `IRWIN/NIFC updated ${formatDateTime(updated)}` : 'Update time unavailable'}</span><a href="${inciwebUrl}" target="_blank" rel="noopener">Find on InciWeb</a></div>`;
}

function initControls() {
  const today = new Date().toISOString().slice(0, 10);
  const latestDailyObservation = new Date();
  latestDailyObservation.setUTCDate(latestDailyObservation.getUTCDate() - 1);
  els.fireDate.max = today;
  els.fuelMoistureDate.max = today;
  els.fuelMoistureDate.value = latestDailyObservation.toISOString().slice(0, 10);
  if (isMobileViewport()) {
    els.fireMinFrp.value = '10';
    els.fireMinFrpLabel.textContent = '10 MW';
  }

  els.fireMinFrp.addEventListener('input', () => {
    els.fireMinFrpLabel.textContent = `${els.fireMinFrp.value} MW`;
    renderRows();
  });

  els.loadFireData.addEventListener('click', () => loadFireData());
  els.downloadFireCsv.addEventListener('click', downloadCsv);
  els.fireResetView.addEventListener('click', () => state.map.fitBounds(WESTERN_US_VIEW.bounds));
  els.mobileResetView.addEventListener('click', () => state.map.fitBounds(WESTERN_US_VIEW.bounds));
  els.mobileClearOverlays.addEventListener('click', clearMapOverlays);
  els.mobileIncidentsToggle.addEventListener('click', () => {
    const results = document.getElementById('fire-results');
    setMobileIncidentsOpen(!results.classList.contains('is-mobile-open'));
  });
  els.mobileIncidentsClose.addEventListener('click', () => setMobileIncidentsOpen(false));
  els.mobileLayersToggle.addEventListener('click', () => {
    const controls = document.querySelector('.fire-controls');
    setMobileLayersOpen(!controls.classList.contains('is-mobile-open'));
  });
  els.mobileLayersClose.addEventListener('click', () => setMobileLayersOpen(false));
  els.showFireData.addEventListener('change', () => { renderMarkers(); renderActiveLayers(); });
  els.showIncidents.addEventListener('change', () => {
    if (state.incidentData) renderIncidents(state.incidentData);
  });
  els.incidentFilter.addEventListener('change', () => {
    if (state.incidentData) renderIncidents(state.incidentData);
  });
  els.incidentState.addEventListener('change', () => {
    if (state.incidentData) {
      renderIncidents(state.incidentData);
      const selected = state.filteredIncidents[0];
      if (selected) focusIncident(0);
    }
  });
  els.incidentList.addEventListener('click', event => {
    const button = event.target.closest('[data-incident-index]');
    if (button) {
      focusIncident(Number(button.dataset.incidentIndex));
      setMobileIncidentsOpen(false);
    }
  });
  els.incidentListToggle.addEventListener('click', () => {
    state.mobileIncidentListExpanded = !state.mobileIncidentListExpanded;
    els.incidentList.classList.toggle('is-expanded', state.mobileIncidentListExpanded);
    els.incidentListToggle.textContent = state.mobileIncidentListExpanded ? 'Show fewer incidents' : 'Show all incidents';
  });
  els.loadFuelMoisture.addEventListener('click', loadFuelMoisture);
  els.showFuelMoisture.addEventListener('change', () => {
    if (els.showFuelMoisture.checked && state.fuelRows.length === 0) {
      loadFuelMoisture();
    } else {
      renderFuelMarkers();
    }
  });
  els.fuelMoistureClass.addEventListener('change', renderFuelMarkers);
  els.showPm25.addEventListener('change', renderPm25Markers);
  els.pm25Mode.addEventListener('change', renderPm25Markers);
  els.showSmoke.addEventListener('change', syncSmokeLayer);
  els.showSmokeWind.addEventListener('change', renderSmokeOverlay);
  els.smokeField.addEventListener('change', renderSmokeOverlay);
  els.smokeHour.addEventListener('input', renderSmokeOverlay);
  els.smokeOpacity.addEventListener('input', updateSmokeOpacity);
  els.smokePlay.addEventListener('click', toggleSmokePlayback);
  document.addEventListener('keydown', handleSmokeKeyboard, true);
}

function clearMapOverlays() {
  els.showIncidents.checked = false;
  els.showFuelMoisture.checked = false;
  els.showPm25.checked = false;
  els.showSmoke.checked = false;
  renderIncidents(state.incidentData || { incidents: { features: [] }, perimeters: { features: [] } });
  renderFuelMarkers();
  renderPm25Markers();
  syncSmokeLayer();
  renderActiveLayers();
}

function renderActiveLayers() {
  const container = document.getElementById('fire-active-layers');
  if (!container) return;
  const layers = [
    [els.showFireData.checked, 'Satellite'], [els.showIncidents.checked, els.incidentFilter.value === 'major' ? 'Major fires' : 'Incidents'],
    [els.showFuelMoisture.checked, 'Fuel'], [els.showPm25.checked, els.pm25Mode.value === 'aqi' ? 'PM2.5 AQI' : 'PM2.5'],
    [els.showSmoke.checked, `Smoke F${String(els.smokeHour.value).padStart(3, '0')}`], [els.showSmoke.checked && els.showSmokeWind.checked, 'Wind']
  ].filter(([active]) => active);
  container.innerHTML = layers.map(([, label]) => `<span>${escapeHtml(label)}</span>`).join('');
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 640px)').matches;
}

function setMobileLayersOpen(open) {
  if (!isMobileViewport()) return;
  const controls = document.querySelector('.fire-controls');
  controls.classList.toggle('is-mobile-open', open);
  els.mobileLayersToggle.setAttribute('aria-expanded', String(open));
  if (open) window.setTimeout(() => state.map.invalidateSize(), 200);
}

function setMobileIncidentsOpen(open) {
  if (!isMobileViewport()) return;
  const results = document.getElementById('fire-results');
  results.classList.toggle('is-mobile-open', open);
  els.mobileIncidentsToggle.setAttribute('aria-expanded', String(open));
}

async function syncSmokeLayer() {
  if (!els.showSmoke.checked) {
    stopSmokePlayback();
    clearSmokeOverlay();
    return;
  }

  els.showSmokeWind.checked = true;
  els.smokeOptions.open = true;

  if (!state.smokeManifest) {
    setSmokeStatus('Loading latest HRRR Smoke forecast...');
    try {
      const response = await fetch('assets/live/hrrr-smoke/manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('HRRR Smoke frames have not been published yet.');
      state.smokeManifest = await response.json();
      if (state.smokeManifest.available === false) throw new Error(state.smokeManifest.message || 'HRRR Smoke is not available yet.');
      const windsResponse = await fetch('assets/live/hrrr-smoke/winds.json', { cache: 'no-store' });
      state.smokeWinds = windsResponse.ok ? await windsResponse.json() : null;
      const lastHour = Math.max(...(state.smokeManifest.hours || [48]));
      els.smokeHour.max = String(lastHour);
      els.smokeHour.disabled = false;
      els.smokeField.disabled = false;
      els.smokeOpacity.disabled = false;
      els.smokePlay.disabled = false;
      els.showSmokeWind.disabled = !state.smokeWinds;
      setSmokeStatus(`Loaded ${state.smokeManifest.model || 'HRRR Smoke'} run: ${formatSmokeTimes(state.smokeManifest.run)}.`);
    } catch (error) {
      els.showSmoke.checked = false;
      clearSmokeOverlay();
      setSmokeStatus(error.message || 'Unable to load HRRR Smoke data.', true);
      return;
    }
  }
  els.showSmokeWind.disabled = !state.smokeWinds;
  renderSmokeOverlay();
}

function renderSmokeOverlay() {
  if (!els.showSmoke.checked || !state.smokeManifest) return;

  const fieldName = els.smokeField.value;
  const field = state.smokeManifest.fields?.[fieldName];
  if (!field) return;
  const hour = Number(els.smokeHour.value);
  const hourToken = String(hour).padStart(3, '0');
  const imagePath = field.path.replace('{hour}', hourToken);
  const imageUrl = `assets/live/hrrr-smoke/${imagePath}`;
  const requestId = ++state.smokeFrameRequest;
  const image = new Image();
  image.onload = () => {
    if (requestId !== state.smokeFrameRequest || !els.showSmoke.checked) return;
    const nextOverlay = L.imageOverlay(imageUrl, state.smokeManifest.bounds, {
      opacity: Number(els.smokeOpacity.value) / 100,
      pane: 'smokePane',
      interactive: false
    }).addTo(state.map);
    const previousOverlay = state.smokeOverlay;
    state.smokeOverlay = nextOverlay;
    if (previousOverlay) previousOverlay.remove();
  };
  image.src = imageUrl;
  renderSmokeScale(field);
  const validTime = new Date(new Date(state.smokeManifest.run).getTime() + hour * 60 * 60 * 1000);
  els.smokeHourLabel.textContent = `F${hourToken} | valid ${formatSmokeTimes(validTime)} | ${field.label} (${field.units})`;
  if (state.smokeTimeElement) {
    state.smokeTimeElement.textContent = `HRRR Smoke F${hourToken} | ${formatSmokeTimes(validTime)}`;
    state.smokeTimeElement.hidden = false;
  }
  renderSmokeWinds(hour);
}

function clearSmokeOverlay() {
  state.smokeFrameRequest += 1;
  if (state.smokeOverlay) {
    state.smokeOverlay.remove();
    state.smokeOverlay = null;
  }
  if (state.smokeTimeElement) state.smokeTimeElement.hidden = true;
  if (state.smokeScaleElement) state.smokeScaleElement.hidden = true;
  state.smokeWindLayer.clearLayers();
  els.showSmokeWind.disabled = true;
  renderMarkers();
}

function renderSmokeWinds(hour) {
  state.smokeWindLayer.clearLayers();
  if (!els.showSmoke.checked || !els.showSmokeWind.checked || !state.smokeWinds) return;
  const frame = (state.smokeWinds.frames || []).find(item => Number(item.hour) === hour);
  (frame?.vectors || []).forEach(([latitude, longitude, u, v]) => drawWindArrow(latitude, longitude, u, v));
}

function drawWindArrow(latitude, longitude, u, v) {
  const speed = Math.hypot(u, v);
  if (!Number.isFinite(speed) || speed < 0.5) return;
  const scale = Math.min(0.38, 0.08 + speed * 0.018);
  const latScale = v * scale / speed;
  const lonScale = u * scale / (speed * Math.max(Math.cos(latitude * Math.PI / 180), 0.3));
  const tail = [latitude - latScale / 2, longitude - lonScale / 2];
  const head = [latitude + latScale / 2, longitude + lonScale / 2];
  const wingScale = 0.34;
  const left = [head[0] - latScale * wingScale - lonScale * wingScale, head[1] - lonScale * wingScale + latScale * wingScale];
  const right = [head[0] - latScale * wingScale + lonScale * wingScale, head[1] - lonScale * wingScale - latScale * wingScale];
  const options = { pane: 'windPane', color: '#f8fafc', weight: 1.4, opacity: 0.82, interactive: false };
  L.polyline([tail, head], options).addTo(state.smokeWindLayer);
  L.polyline([left, head, right], options).addTo(state.smokeWindLayer);
}

function renderSmokeScale(field) {
  if (!state.smokeScaleElement) return;
  const breaks = field.breaks || [];
  const colors = ['#fef08a', '#fdba74', '#fb923c', '#ef4444', '#be185d', '#6b21a8'];
  state.smokeScaleElement.innerHTML = `<strong>${escapeHtml(field.label)}</strong><span>${escapeHtml(field.units)}</span><div class="smoke-scale-colors">${colors.map(color => `<i style="background:${color}"></i>`).join('')}</div><div class="smoke-scale-labels">${breaks.map(value => `<span>${formatNumber(value)}</span>`).join('')}</div>`;
  state.smokeScaleElement.hidden = false;
}

function updateSmokeOpacity() {
  els.smokeOpacityLabel.textContent = `${els.smokeOpacity.value}%`;
  if (state.smokeOverlay) state.smokeOverlay.setOpacity(Number(els.smokeOpacity.value) / 100);
}

function toggleSmokePlayback() {
  if (state.smokePlayback) {
    stopSmokePlayback();
    return;
  }
  state.smokePlayback = window.setInterval(advanceSmokeFrame, 700);
  els.smokePlay.textContent = 'Pause';
  els.smokePlay.setAttribute('aria-label', 'Pause smoke forecast');
}

function stopSmokePlayback() {
  if (state.smokePlayback) window.clearInterval(state.smokePlayback);
  state.smokePlayback = null;
  if (els.smokePlay) {
    els.smokePlay.textContent = 'Play';
    els.smokePlay.setAttribute('aria-label', 'Play smoke forecast');
  }
}

function advanceSmokeFrame(direction = 1) {
  if (!els.showSmoke.checked || !state.smokeManifest) return;
  const minimum = Number(els.smokeHour.min);
  const maximum = Number(els.smokeHour.max);
  const next = Number(els.smokeHour.value) + direction;
  els.smokeHour.value = String(next > maximum ? minimum : next < minimum ? maximum : next);
  renderSmokeOverlay();
}

function handleSmokeKeyboard(event) {
  if (event.key === 'Escape' && isMobileViewport()) {
    setMobileLayersOpen(false);
    return;
  }
  if (!els.showSmoke?.checked || !state.smokeManifest || event.altKey || event.ctrlKey || event.metaKey) return;
  if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) return;
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    event.stopImmediatePropagation();
    advanceSmokeFrame(1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    event.stopImmediatePropagation();
    advanceSmokeFrame(-1);
  }
}

async function loadCachedFireData() {
  try {
    const response = await fetch('assets/live/firms.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Cached fire data unavailable.');
    const cached = await response.json();
    state.lastSources = cached.sources || [];
    state.allRows = (cached.rows || []).map(row => normalizeRow(row, row.source))
      .filter(row => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
    state.lastCsv = rowsToCsv(state.allRows);
    renderRows();
    els.downloadFireCsv.disabled = state.lastCsv.length === 0;
    const cachedTime = new Date(cached.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    els.fireUpdated.textContent = cached.stale ? `Cached ${cachedTime} (FIRMS refresh delayed)` : `Cached ${cachedTime}`;
    setStatus(`Loaded ${state.allRows.length.toLocaleString()} cached FIRMS detections${cached.stale ? '; FIRMS refresh delayed.' : '.'}`);
  } catch {
    loadFireData({ useDefaultBounds: true });
  }
}

async function loadFuelMoisture() {
  const date = els.fuelMoistureDate.value;
  if (!date) {
    setFuelStatus('Choose an observation date.', true);
    return;
  }

  setFuelLoading(true);
  els.showFuelMoisture.checked = true;
  setFuelStatus(`Fetching NFDRS station values for ${date}...`);

  try {
    const cached = await loadCachedFuelMoisture(date);
    if (cached) {
      state.fuelDate = cached.date;
      state.fuelRows = cached.rows || [];
      renderFuelMarkers();
      setFuelStatus(`Loaded ${state.fuelRows.length.toLocaleString()} cached RAWS stations for ${cached.date}${cached.stale ? '; refresh delayed.' : '.'}`);
      return;
    }
    const result = await fetchFems(`
      query {
        nfdrMinMax(startDate: "${date}", endDate: "${date}", nfdrType: "O", per_page: 20000) {
          data {
            station_id
            summary_date
            ten_hr_tl_fuel_moisture_min
            hun_hr_tl_fuel_moisture_min
            thou_hr_tl_fuel_moisture_min
          }
        }
      }
    `);
    const measurements = uniqueFuelMeasurements(result.data?.nfdrMinMax?.data || []);

    if (measurements.length === 0) {
      state.fuelRows = [];
      renderFuelMarkers();
      setFuelStatus(`No NFDRS observations were available for ${date}.`, true);
      return;
    }

    const stationIds = measurements.map(row => row.station_id);
    const stationResult = await fetchFems(`
      query {
        stationMetaData(stationIds: "${stationIds.join(',')}", networkName: "RAWS", per_page: 3000) {
          data { station_id station_name latitude longitude state }
        }
      }
    `);
    const stations = stationResult.data?.stationMetaData?.data || [];
    const stationsById = new Map(stations.map(station => [station.station_id, station]));

    state.fuelDate = date;
    state.fuelRows = measurements.map(row => ({ ...row, ...stationsById.get(row.station_id) }))
      .filter(row => Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)));
    renderFuelMarkers();
    setFuelStatus(`Loaded ${state.fuelRows.length.toLocaleString()} RAWS stations for ${date}.`);
  } catch (error) {
    console.error(error);
    setFuelStatus(error.message || 'Unable to fetch NFDRS fuel moisture.', true);
  } finally {
    setFuelLoading(false);
  }
}

async function loadCachedFuelMoisture(date) {
  try {
    const response = await fetch('assets/live/fuel-moisture.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const cached = await response.json();
    return cached.date === date ? cached : null;
  } catch {
    return null;
  }
}

async function fetchFems(query) {
  const response = await fetch(FEMS_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.[0]?.message || `FEMS returned ${response.status}.`);
  }
  return payload;
}

function uniqueFuelMeasurements(rows) {
  const measurements = new Map();
  rows.forEach(row => {
    if (!measurements.has(row.station_id)) measurements.set(row.station_id, row);
  });
  return [...measurements.values()];
}

async function loadFireData(options = {}) {
  const mapKey = FIRMS_MAP_KEY;
  const sources = getSelectedSources();
  const dayRange = els.fireDayRange.value;
  const startDate = els.fireDate.value;
  const bounds = options.useDefaultBounds ? '-125,31,-102,49' : getApiBounds();

  if (sources.length === 0) {
    setStatus('Select at least one fire source.', true);
    return;
  }

  setLoading(true);
  setStatus(`Fetching ${sources.length} source${sources.length === 1 ? '' : 's'} for ${bounds}...`);

  try {
    const results = await Promise.allSettled(sources.map(async source => ({
      source,
      csv: await fetchSource({ mapKey, source, bounds, dayRange, startDate })
    })));
    const responses = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const unavailableSources = results.flatMap((result, index) => result.status === 'rejected' ? [sources[index]] : []);
    if (responses.length === 0) throw new Error('No selected FIRMS sources were available.');

    state.lastSources = responses.map(response => response.source);
    state.allRows = responses.flatMap(({ source, csv }) => parseCsv(csv).map(row => normalizeRow(row, source)));
    state.allRows = state.allRows.filter(row => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
    state.lastCsv = rowsToCsv(state.allRows);
    renderRows();
    const skipped = unavailableSources.length ? ` Skipped: ${unavailableSources.join(', ')}.` : '';
    setStatus(`Loaded ${state.allRows.length.toLocaleString()} raw detections from NASA FIRMS.${skipped}`);
    els.fireUpdated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    els.downloadFireCsv.disabled = state.lastCsv.length === 0;
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Unable to fetch FIRMS detections.', true);
  } finally {
    setLoading(false);
  }
}

async function fetchSource({ mapKey, source, bounds, dayRange, startDate }) {
  const datePart = startDate ? `/${encodeURIComponent(startDate)}` : '';
  const url = `${FIRMS_API_BASE}/${encodeURIComponent(mapKey)}/${source}/${bounds}/${dayRange}${datePart}`;
  const response = await fetch(url, { cache: 'no-store' });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${source}: FIRMS returned ${response.status}. ${text.slice(0, 120)}`);
  }
  if (/Invalid MAP_KEY|MAP_KEY/i.test(text) && !text.includes(',')) {
    throw new Error(`${source}: ${text.trim()}`);
  }
  return text;
}

function getSelectedSources() {
  return Array.from(document.querySelectorAll('input[name="fire-source"]:checked')).map(input => input.value);
}

function getApiBounds() {
  const bounds = state.map.getBounds();
  const west = clamp(bounds.getWest(), -180, 180);
  const south = clamp(bounds.getSouth(), -90, 90);
  const east = clamp(bounds.getEast(), -180, 180);
  const north = clamp(bounds.getNorth(), -90, 90);
  return [west, south, east, north].map(value => value.toFixed(4)).join(',');
}

function updateBoundsLabel() {
  if (!state.map || !els.fireBoundsLabel) return;
  els.fireBoundsLabel.textContent = `Bounds: ${getApiBounds()}`;
}

function parseCsv(csv) {
  const rows = csv.trim().split(/\r?\n/);
  if (rows.length < 2) return [];
  const headers = splitCsvLine(rows[0]).map(header => header.trim().replace(/^\uFEFF/, ''));
  return rows.slice(1).map(line => {
    const values = splitCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = values[index] || '';
      return row;
    }, {});
  });
}

function splitCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function normalizeRow(row, source) {
  const frp = Number(row.frp);
  const acqTime = String(row.acq_time || '').padStart(4, '0');
  const acquiredAtMs = Date.parse(`${row.acq_date || ''}T${acqTime.slice(0, 2)}:${acqTime.slice(2, 4)}:00Z`);
  const brightness = row.bright_ti4 || row.brightness || row.bright_t31 || '';
  return {
    ...row,
    source,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    frp: Number.isFinite(frp) ? frp : 0,
    confidence: row.confidence || 'n/a',
    brightness,
    acquiredAtMs,
    acquiredAt: `${row.acq_date || 'unknown'} ${acqTime.slice(0, 2)}:${acqTime.slice(2, 4)} UTC`
  };
}

function renderRows() {
  const minFrp = Number(els.fireMinFrp.value);
  state.visibleRows = state.allRows.filter(row => row.frp >= minFrp);
  renderMarkers();
  renderSummary(minFrp);
}

function renderMarkers() {
  state.layer.clearLayers();
  if (!els.showFireData.checked) return;

  const scale = fireMarkerFootprintScale();
  state.fireMarkerScale = scale;
  state.visibleRows.forEach(row => {
    const marker = L.rectangle(fireFootprint(row, scale), {
      pane: 'firePane',
      stroke: true,
      color: row.daynight === 'N' ? '#f8fafc' : '#3b1d0a',
      weight: 1,
      fillColor: recencyColor(row.acquiredAtMs),
      fillOpacity: 0.68
    });
    marker.bindPopup(popupHtml(row));
    marker.addTo(state.layer);
  });
  renderActiveLayers();
}

function rerenderFireMarkersForZoom() {
  if (!els.showFireData.checked) return;
  if (fireMarkerFootprintScale() !== state.fireMarkerScale) renderMarkers();
}

function fireMarkerFootprintScale() {
  const baseScale = els.showIncidents.checked ? 1.25 : 4;
  const zoom = state.map.getZoom();
  if (zoom <= 4) return baseScale * 2;
  if (zoom <= 5) return baseScale * 1.5;
  if (zoom <= 6) return baseScale * 1.2;
  return baseScale;
}

function fireFootprint(row, scale = 1) {
  const scanKm = Number(row.scan) || 1;
  const trackKm = Number(row.track) || 1;
  const latitudeHalfSpan = trackKm * scale / 222;
  const longitudeHalfSpan = scanKm * scale / (222 * Math.max(Math.cos(row.latitude * Math.PI / 180), 0.2));
  return [
    [row.latitude - latitudeHalfSpan, row.longitude - longitudeHalfSpan],
    [row.latitude + latitudeHalfSpan, row.longitude + longitudeHalfSpan]
  ];
}

function renderFuelMarkers() {
  state.fuelLayer.clearLayers();
  const showFuel = els.showFuelMoisture.checked;
  els.fuelMoistureLegend.hidden = !showFuel;
  if (!showFuel) return;

  const field = fuelMoistureField();
  state.fuelRows.forEach(row => {
    const moisture = Number(row[field]);
    if (!Number.isFinite(moisture)) return;

    const marker = L.circleMarker([row.latitude, row.longitude], {
      radius: 7,
      color: '#f8fafc',
      weight: 1.5,
      fillColor: fuelMoistureColor(moisture),
      fillOpacity: 0.88
    });
    marker.bindPopup(fuelPopupHtml(row, moisture));
    marker.addTo(state.fuelLayer);
  });
}

function fuelMoistureField() {
  return {
    ten: 'ten_hr_tl_fuel_moisture_min',
    hundred: 'hun_hr_tl_fuel_moisture_min',
    thousand: 'thou_hr_tl_fuel_moisture_min'
  }[els.fuelMoistureClass.value];
}

function fuelMoistureLabel() {
  return {
    ten: '10-hour NFDRS',
    hundred: '100-hour NFDRS',
    thousand: '1000-hour NFDRS'
  }[els.fuelMoistureClass.value];
}

function fuelMoistureColor(moisture) {
  if (moisture < 7) return '#ef4444';
  if (moisture <= 12) return '#f97316';
  return '#38bdf8';
}

function fuelPopupHtml(row, moisture) {
  return `
    <div class="fire-popup">
      <strong>${escapeHtml(row.station_name || `RAWS ${row.station_id}`)}</strong>
      <span>${escapeHtml(row.state || 'RAWS')} | ${escapeHtml(row.summary_date || state.fuelDate)}</span>
      <span>${escapeHtml(fuelMoistureLabel())}: ${formatNumber(moisture)}%</span>
      <span>10-hour NFDRS: ${formatNumber(row.ten_hr_tl_fuel_moisture_min)}%</span>
      <span>100-hour NFDRS: ${formatNumber(row.hun_hr_tl_fuel_moisture_min)}%</span>
      <span>1000-hour NFDRS: ${formatNumber(row.thou_hr_tl_fuel_moisture_min)}%</span>
    </div>
  `;
}

async function loadPm25() {
  try {
    const response = await fetch('assets/live/airnow-pm25.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('AirNow PM2.5 data unavailable.');
    const data = await response.json();
    state.pm25Rows = data.rows || [];
    const updated = data.observedAt ? `Observed ${formatDateTime(data.observedAt)}` : 'Observation time unavailable';
    els.pm25Status.textContent = `${state.pm25Rows.length.toLocaleString()} AirNow PM2.5 monitors. ${updated}${data.stale ? ' (refresh delayed)' : ''}`;
    els.pm25Status.classList.toggle('is-error', Boolean(data.stale));
    renderPm25Markers();
  } catch (error) {
    els.pm25Status.textContent = 'AirNow PM2.5 data is unavailable.';
    els.pm25Status.classList.add('is-error');
    renderPm25Markers();
  }
}

function renderPm25Markers() {
  state.pm25Layer.clearLayers();
  const showPm25 = els.showPm25.checked;
  els.pm25Legend.hidden = !showPm25;
  if (!showPm25) { renderActiveLayers(); return; }

  const aqiMode = els.pm25Mode.value === 'aqi';
  els.pm25Legend.innerHTML = aqiMode
    ? '<span><i class="pm25-good"></i>0-50</span><span><i class="pm25-moderate"></i>51-100</span><span><i class="pm25-unhealthy"></i>101-150</span><span><i class="pm25-very-unhealthy"></i>151+</span>'
    : '<span><i class="pm25-good"></i>&lt; 9</span><span><i class="pm25-moderate"></i>9-35</span><span><i class="pm25-unhealthy"></i>35-55</span><span><i class="pm25-very-unhealthy"></i>55+</span>';

  state.pm25Rows.forEach(row => {
    const value = aqiMode ? Number(row.nowcastAqi) : Number(row.concentration);
    if (!Number.isFinite(value)) return;
    const marker = L.circleMarker([row.latitude, row.longitude], {
      pane: 'pm25Pane',
      radius: 6,
      color: '#f8fafc',
      weight: 1.25,
      fillColor: aqiMode ? aqiColor(value) : pm25Color(value),
      fillOpacity: 0.92
    });
    marker.bindPopup(pm25PopupHtml(row));
    marker.addTo(state.pm25Layer);
  });
  renderActiveLayers();
}

function pm25Color(concentration) {
  if (concentration < 9) return '#22c55e';
  if (concentration < 35) return '#facc15';
  if (concentration < 55) return '#f97316';
  if (concentration < 125) return '#ef4444';
  return '#a855f7';
}

function aqiColor(aqi) {
  if (aqi <= 50) return '#22c55e';
  if (aqi <= 100) return '#facc15';
  if (aqi <= 150) return '#f97316';
  if (aqi <= 200) return '#ef4444';
  return '#a855f7';
}

function pm25PopupHtml(row) {
  return `
    <div class="fire-popup">
      <strong>${escapeHtml(row.siteName || `AirNow ${row.stationId}`)}</strong>
      <span>${escapeHtml(row.state || 'AirNow')} | ${escapeHtml(row.observedAt || 'Observation time unavailable')}</span>
      <span>PM2.5: ${formatNumber(row.concentration)} ug/m3</span>
      <span>PM2.5 NowCast AQI: ${Number.isFinite(Number(row.nowcastAqi)) ? formatNumber(row.nowcastAqi) : 'Unavailable'}</span>
      <span>${escapeHtml(row.agency || 'AirNow preliminary observation')}</span>
    </div>
  `;
}

function renderSummary(minFrp) {
  const count = state.visibleRows.length;
  els.fireCount.textContent = `${count.toLocaleString()} detection${count === 1 ? '' : 's'}`;
}

function popupHtml(row) {
  return `
    <div class="fire-popup">
      <strong>${escapeHtml(row.source)}</strong>
      <span>${escapeHtml(row.acquiredAt)}</span>
      <span>${formatCoordinate(row.latitude)}, ${formatCoordinate(row.longitude)}</span>
      <span>FRP: ${formatNumber(row.frp)} MW</span>
      <span>Confidence: ${escapeHtml(String(row.confidence))}</span>
      <span>Brightness: ${escapeHtml(String(row.brightness || 'n/a'))}</span>
    </div>
  `;
}

function markerRadius(frp) {
  return clamp(4 + Math.log10(Math.max(frp, 1)) * 3, 4, 15);
}

function recencyColor(acquiredAtMs) {
  const ageHours = (Date.now() - acquiredAtMs) / (1000 * 60 * 60);
  if (!Number.isFinite(ageHours)) return '#64748b';
  if (ageHours <= 6) return '#ef4444';
  if (ageHours <= 24) return '#f97316';
  return '#38bdf8';
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const fields = [
    'source',
    'latitude',
    'longitude',
    'acq_date',
    'acq_time',
    'satellite',
    'instrument',
    'confidence',
    'version',
    'frp',
    'daynight',
    'brightness',
    'scan',
    'track'
  ];
  const lines = rows.map(row => fields.map(field => csvEscape(row[field] || '')).join(','));
  return [fields.join(','), ...lines].join('\n');
}

function csvEscape(value) {
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv() {
  if (!state.lastCsv) return;
  const blob = new Blob([state.lastCsv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  link.href = url;
  link.download = `firms-fire-detections-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function setLoading(isLoading) {
  els.loadFireData.disabled = isLoading;
  els.loadFireData.textContent = isLoading ? 'Loading...' : 'Load map view';
}

function setStatus(message, isError = false) {
  els.fireStatus.textContent = message;
  els.fireStatus.classList.toggle('is-error', isError);
}

function setFuelLoading(isLoading) {
  els.loadFuelMoisture.disabled = isLoading;
  els.loadFuelMoisture.textContent = isLoading ? 'Loading...' : 'Load fuel moisture';
}

function setFuelStatus(message, isError = false) {
  els.fuelMoistureStatus.textContent = message;
  els.fuelMoistureStatus.classList.toggle('is-error', isError);
}

function setSmokeStatus(message, isError = false) {
  els.smokeStatus.textContent = message;
  els.smokeStatus.classList.toggle('is-error', isError);
}

function formatCoordinate(value) {
  return Number(value).toFixed(3);
}

function formatNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString(undefined, { maximumFractionDigits: 1 }) : 'n/a';
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';
}

function formatSmokeTimes(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown time';
  const options = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  };
  return [
    ['UTC', 'UTC'],
    ['Mountain', 'America/Denver'],
    ['Pacific', 'America/Los_Angeles']
  ].map(([label, timeZone]) => `${label} ${new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(date)}`).join(' | ');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
