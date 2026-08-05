import { mkdir, readFile, writeFile } from 'node:fs/promises';

const outputDirectory = new URL('../assets/live/', import.meta.url);
const firmsKey = 'ba50bf93112cabcd9ed7c7f5e71f631a';
const bounds = '-125,31,-102,50';
const sources = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'];
const firmsBase = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const femsUrl = 'https://fems.fs2c.usda.gov/api/climatology/graphql';
const incidentBase = 'https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/USA_Wildfires_v1/FeatureServer';
const airnowBase = 'https://s3-us-west-1.amazonaws.com/files.airnowtech.org/airnow/today';
const oregonEvacuationsUrl = 'https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/Fire_Evacuation_Areas_Public/FeatureServer/0';
const californiaEvacuationsUrl = 'https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0';
const requestTimeoutMs = 60_000;
const skipFuelMoisture = process.argv.includes('--skip-fuel-moisture');

await mkdir(outputDirectory, { recursive: true });

await refreshFirms();
if (!skipFuelMoisture) {
  await refreshFuelMoisture();
}

await refreshIncidents();
await refreshAirNowPm25();
await refreshEvacuations();

async function refreshFirms() {
  const fireResults = await Promise.allSettled(sources.map(async source => {
    const response = await fetchWithTimeout(`${firmsBase}/${firmsKey}/${source}/${bounds}/2`);
    if (!response.ok) throw new Error(`FIRMS ${source} returned ${response.status}`);
    const csv = await response.text();
    if (!isFirmsCsv(csv)) throw new Error(`FIRMS ${source} returned an invalid CSV response`);
    return { source, csv };
  }));
  const fireResponses = fireResults.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const unavailableSources = fireResults.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    console.warn(`Skipping ${sources[index]}: ${result.reason.message}`);
    return [sources[index]];
  });
  if (fireResponses.length === 0) {
    const cachedFirms = await readJson('firms.json');
    if (cachedFirms) console.warn(`All FIRMS sources were unavailable; retaining cached detections from ${cachedFirms.generatedAt || 'an unknown time'}.`);
    else console.warn('All FIRMS sources were unavailable and no prior retrieval cache was found; publishing an empty dataset for this run.');
    await writeJson('firms.json', {
      ...cachedFirms,
      generatedAt: cachedFirms?.generatedAt || new Date().toISOString(),
      bounds,
      days: 2,
      sources: cachedFirms?.sources || [],
      lastAttemptAt: new Date().toISOString(),
      unavailableSources: sources,
      stale: true,
      rows: cachedFirms?.rows || []
    });
    return;
  }
  const fireRows = fireResponses.flatMap(({ source, csv }) => parseCsv(csv).map(row => ({ ...row, source })));
  await writeJson('firms.json', {
    generatedAt: new Date().toISOString(),
    bounds,
    days: 2,
    sources: fireResponses.map(response => response.source),
    unavailableSources,
    stale: false,
    rows: fireRows
  });
}

async function refreshFuelMoisture() {
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 3);
  try {
    const fuelResult = await fems(`query {
  nfdrMinMax(startDate: "${toIsoDate(startDate)}", endDate: "${toIsoDate(endDate)}", nfdrType: "O", per_page: 20000) {
    data { station_id summary_date ten_hr_tl_fuel_moisture_min hun_hr_tl_fuel_moisture_min thou_hr_tl_fuel_moisture_min }
  }
}`);
    const allMeasurements = fuelResult.data?.nfdrMinMax?.data || [];
    const date = [...new Set(allMeasurements.map(row => row.summary_date).filter(Boolean))].sort().at(-1);
    if (!date) throw new Error('No recent NFDRS observations were returned');
    const measurements = [...new Map(allMeasurements.filter(row => row.summary_date === date).map(row => [row.station_id, row])).values()];
    if (measurements.length === 0) throw new Error(`No NFDRS stations were returned for ${date}`);
    const stationIds = measurements.map(row => row.station_id).join(',');
    const stationsResult = stationIds ? await fems(`query {
  stationMetaData(stationIds: "${stationIds}", networkName: "RAWS", per_page: 3000) {
    data { station_id station_name latitude longitude state }
  }
}`) : { data: { stationMetaData: { data: [] } } };
    const stations = new Map((stationsResult.data?.stationMetaData?.data || []).map(row => [row.station_id, row]));
    const fuelRows = measurements.map(row => ({ ...row, ...stations.get(row.station_id) }))
      .filter(row => Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)));
    await writeJson('fuel-moisture.json', { generatedAt: new Date().toISOString(), date, stale: false, rows: fuelRows });
  } catch (error) {
    await retainCachedJson('fuel-moisture.json', { date: toIsoDate(endDate), rows: [] }, error);
  }
}

async function refreshIncidents() {
  try {
    const [incidents, perimeters] = await Promise.all([0, 1].map(fetchIncidentLayer));
    await writeJson('incidents.json', {
      generatedAt: new Date().toISOString(),
      stale: false,
      incidents,
      perimeters: simplifyPerimeters(perimeters)
    });
  } catch (error) {
    await retainCachedJson('incidents.json', {
      incidents: { type: 'FeatureCollection', features: [] },
      perimeters: { type: 'FeatureCollection', features: [] }
    }, error);
  }
}

function simplifyPerimeters(collection) {
  return {
    ...collection,
    features: (collection.features || [])
      .map(feature => ({ ...feature, geometry: simplifyGeometry(feature.geometry) }))
      .sort((a, b) => featureAcres(b) - featureAcres(a))
  };
}

function featureAcres(feature) {
  const properties = feature.properties || {};
  return Number(properties.DailyAcres || properties.GISAcres || properties.CalculatedAcres || 0);
}

function simplifyGeometry(geometry) {
  if (!geometry) return geometry;
  if (geometry.type === 'Polygon') {
    return { ...geometry, coordinates: geometry.coordinates.map(simplifyRing) };
  }
  if (geometry.type === 'MultiPolygon') {
    return { ...geometry, coordinates: geometry.coordinates.map(polygon => polygon.map(simplifyRing)) };
  }
  return geometry;
}

function simplifyRing(ring) {
  const maxPoints = 750;
  if (ring.length <= maxPoints) return ring;
  const stride = Math.ceil((ring.length - 1) / (maxPoints - 1));
  const simplified = ring.filter((_, index) => index === 0 || index === ring.length - 1 || index % stride === 0);
  const first = simplified[0];
  const last = simplified.at(-1);
  if (first?.[0] !== last?.[0] || first?.[1] !== last?.[1]) simplified.push([...first]);
  return simplified;
}

async function refreshAirNowPm25() {
  try {
    const sitesResponse = await fetchWithTimeout(`${airnowBase}/monitoring_site_locations.dat`);
    if (!sitesResponse.ok) throw new Error(`AirNow station file returned ${sitesResponse.status}`);
    const sites = new Map();
    for (const line of (await sitesResponse.text()).split(/\r?\n/)) {
      const fields = line.split('|');
      if (fields[1] !== 'PM2.5' || fields[4] !== 'Active') continue;
      const latitude = Number(fields[8]);
      const longitude = Number(fields[9]);
      if (!inWest(latitude, longitude)) continue;
      sites.set(fields[0], { stationId: fields[0], siteName: fields[3], agency: fields[6], state: fields[18], latitude, longitude });
    }

    const readingsByStation = new Map();
    let observedAt = null;
    for (let hoursAgo = 1; hoursAgo <= 12; hoursAgo += 1) {
      const candidate = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
      const filename = `HourlyData_${candidate.toISOString().slice(0, 13).replace(/[-T:]/g, '')}.dat`;
      const response = await fetchWithTimeout(`${airnowBase}/${filename}`);
      if (!response.ok) continue;
      const text = await response.text();
      if (!text.trim()) continue;
      if (!observedAt) observedAt = candidate.toISOString();
      for (const line of text.split(/\r?\n/)) {
        const fields = line.split('|');
        if (fields[5] !== 'PM2.5' || fields[6] !== 'UG/M3' || !sites.has(fields[2])) continue;
        const concentration = Number(fields[7]);
        if (!Number.isFinite(concentration)) continue;
        const readings = readingsByStation.get(fields[2]) || [];
        readings.push({ concentration, agency: fields[8] });
        readingsByStation.set(fields[2], readings);
      }
    }
    if (!observedAt) throw new Error('No AirNow hourly PM2.5 file was available in the last 12 hours');

    const rows = [...readingsByStation].map(([stationId, readings]) => {
      const latest = readings[0];
      return { ...sites.get(stationId), concentration: latest.concentration, nowcastAqi: pm25NowcastAqi(readings.map(row => row.concentration)), observedAt, agency: latest.agency || sites.get(stationId).agency };
    });
    await writeJson('airnow-pm25.json', { generatedAt: new Date().toISOString(), observedAt, stale: false, rows });
  } catch (error) {
    await retainCachedJson('airnow-pm25.json', { observedAt: null, rows: [] }, error);
  }
}

async function refreshEvacuations() {
  try {
    const [oregon, california] = await Promise.all([
      fetchArcGisFeatures(oregonEvacuationsUrl, 'Fire_Evacuation_Level IN (1,2,3)'),
      fetchArcGisFeatures(californiaEvacuationsUrl, "STATUS IN ('EVACUATION WARNING','EVACUATION ORDER','SHELTER IN PLACE')")
    ]);
    const features = [
      ...oregon.features.map(normalizeOregonEvacuation),
      ...california.features.map(normalizeCaliforniaEvacuation)
    ].filter(Boolean);
    await writeJson('evacuations.json', {
      generatedAt: new Date().toISOString(),
      stale: false,
      coverage: 'Oregon Ready/Set/Go areas and participating California county feeds only.',
      features: { type: 'FeatureCollection', features }
    });
  } catch (error) {
    await retainCachedJson('evacuations.json', {
      coverage: 'Oregon Ready/Set/Go areas and participating California county feeds only.',
      features: { type: 'FeatureCollection', features: [] }
    }, error);
  }
}

async function fetchArcGisFeatures(baseUrl, where) {
  const countParams = new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' });
  const count = Number((await fetchJson(`${baseUrl}/query?${countParams}`)).count || 0);
  const features = [];
  const pageSize = 1_000;
  for (let offset = 0; offset < count; offset += pageSize) {
    const params = new URLSearchParams({
      where,
      outFields: '*',
      returnGeometry: 'true',
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      orderByFields: 'OBJECTID ASC',
      f: 'geojson'
    });
    const page = await fetchJson(`${baseUrl}/query?${params}`);
    features.push(...(page.features || []));
  }
  return { type: 'FeatureCollection', features };
}

function normalizeOregonEvacuation(feature) {
  const properties = feature.properties || {};
  const level = Number(properties.Fire_Evacuation_Level);
  const status = { 1: 'Oregon Level 1: Ready', 2: 'Oregon Level 2: Set', 3: 'Oregon Level 3: Go' }[level];
  if (!status || !feature.geometry) return null;
  return {
    ...feature,
    properties: {
      displayStatus: status,
      source: 'Oregon Department of Emergency Management',
      sourceUrl: 'https://wildfire.oregon.gov/evacuations',
      zoneName: properties.Evac_Area_Name,
      zoneId: properties.GlobalID || properties.OBJECTID,
      county: properties.County,
      eventName: properties.Fire_Name,
      updatedAt: properties.last_edited_date || properties.created_date
    }
  };
}

function normalizeCaliforniaEvacuation(feature) {
  const properties = feature.properties || {};
  const status = String(properties.STATUS || '').trim();
  if (!status || !feature.geometry) return null;
  return {
    ...feature,
    properties: {
      displayStatus: `California ${status.replace(/\b\w/g, character => character.toUpperCase())}`,
      source: 'Cal OES evacuation aggregation layer',
      sourceUrl: 'https://experience.arcgis.com/experience/5e3c140030bb4a3b9cbd4e068d05631f',
      zoneName: properties.ZONE_NAME,
      zoneId: properties.ZONE_ID,
      county: properties.COUNTY,
      eventName: properties.EVENT_TYPE,
      updatedAt: properties.STATEWIDE_LAST_UPDATED || properties.EDIT_DATE
    }
  };
}

function pm25NowcastAqi(readings) {
  if (readings.length < 2) return null;
  const maximum = Math.max(...readings);
  const minimum = Math.min(...readings);
  const weight = maximum > 0 ? Math.max(0.5, 1 - (maximum - minimum) / maximum) : 1;
  const nowcast = readings.reduce((total, value, index) => total + value * weight ** index, 0)
    / readings.reduce((total, _, index) => total + weight ** index, 0);
  const concentration = Math.floor(nowcast * 10) / 10;
  const breakpoints = [[0, 9, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150], [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 400], [325.5, 500.4, 401, 500]];
  const [lowConcentration, highConcentration, lowAqi, highAqi] = breakpoints.find(([, high]) => concentration <= high) || [325.5, 99999.9, 501, 999];
  return Math.round((highAqi - lowAqi) / (highConcentration - lowConcentration) * (concentration - lowConcentration) + lowAqi);
}

function inWest(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= 31 && latitude <= 50 && longitude >= -125 && longitude <= -102;
}

async function fems(query) {
  const response = await fetchWithTimeout(femsUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Error(payload.errors?.[0]?.message || `FEMS returned ${response.status}`);
  return payload;
}

async function fetchIncidentLayer(layerId) {
  const sizeField = layerId === 0 ? 'DailyAcres' : 'GISAcres';
  const where = `IncidentTypeCategory = 'WF' AND ${sizeField} >= 50`;
  const url = `${incidentBase}/${layerId}/query`;
  const spatialParams = {
    geometry: '-125,31,-102,50',
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects'
  };
  const countParams = new URLSearchParams({ where, ...spatialParams, returnCountOnly: 'true', f: 'json' });
  const count = Number((await fetchJson(`${url}?${countParams}`)).count || 0);
  const features = [];
  const pageSize = 1_000;

  for (let offset = 0; offset < count; offset += pageSize) {
    const params = new URLSearchParams({
      where,
      ...spatialParams,
      outFields: '*',
      orderByFields: `${sizeField} DESC, OBJECTID ASC`,
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: 'geojson'
    });
    const page = await fetchJson(`${url}?${params}`);
    features.push(...(page.features || []));
  }
  return { type: 'FeatureCollection', features };
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Request returned ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'Service returned an error');
  return payload;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function writeJson(name, value) {
  await writeFile(new URL(name, outputDirectory), JSON.stringify(value));
  const globalName = {
    'firms.json': '__FIRE_FIRMS__',
    'incidents.json': '__FIRE_INCIDENTS__',
    'airnow-pm25.json': '__FIRE_AIRNOW__',
    'evacuations.json': '__FIRE_EVACUATIONS__',
    'fuel-moisture.json': '__FIRE_FUEL_MOISTURE__'
  }[name];
  if (globalName) {
    await writeFile(new URL(name.replace('.json', '.data.js'), outputDirectory), `window.${globalName}=${JSON.stringify(value)};`);
  }
}

async function readJson(name) {
  try {
    return JSON.parse(await readFile(new URL(name, outputDirectory), 'utf8'));
  } catch {
    return null;
  }
}

async function retainCachedJson(name, emptyValue, error) {
  const cached = await readJson(name);
  const timestamp = new Date().toISOString();
  if (cached) console.warn(`${name} refresh failed; retaining cached data from ${cached.generatedAt || 'an unknown time'}: ${error.message}`);
  else console.warn(`${name} refresh failed with no prior cache; publishing an empty dataset: ${error.message}`);
  await writeJson(name, {
    ...emptyValue,
    ...cached,
    generatedAt: cached?.generatedAt || timestamp,
    lastAttemptAt: timestamp,
    stale: true
  });
}

function parseCsv(csv) {
  const [headerLine, ...lines] = csv.trim().split(/\r?\n/);
  if (!headerLine || lines.length === 0) return [];
  const headers = headerLine.replace(/^\uFEFF/, '').split(',');
  return lines.map(line => Object.fromEntries(headers.map((header, index) => [header, line.split(',')[index] || ''])));
}

function isFirmsCsv(csv) {
  const [headerLine] = csv.trim().split(/\r?\n/);
  const headers = headerLine?.replace(/^\uFEFF/, '').split(',') || [];
  return headers.includes('latitude') && headers.includes('longitude');
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}
