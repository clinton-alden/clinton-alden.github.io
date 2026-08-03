import { mkdir, readFile, writeFile } from 'node:fs/promises';

const outputDirectory = new URL('../assets/live/', import.meta.url);
const firmsKey = 'ba50bf93112cabcd9ed7c7f5e71f631a';
const bounds = '-125,31,-102,49';
const sources = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'];
const firmsBase = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const femsUrl = 'https://fems.fs2c.usda.gov/api/climatology/graphql';
const incidentBase = 'https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/USA_Wildfires_v1/FeatureServer';
const requestTimeoutMs = 60_000;

await mkdir(outputDirectory, { recursive: true });

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
} else {
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

await refreshFuelMoisture();
await refreshIncidents();

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
    await writeJson('incidents.json', { generatedAt: new Date().toISOString(), stale: false, incidents, perimeters });
  } catch (error) {
    await retainCachedJson('incidents.json', {
      incidents: { type: 'FeatureCollection', features: [] },
      perimeters: { type: 'FeatureCollection', features: [] }
    }, error);
  }
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
  const countParams = new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' });
  const count = Number((await fetchJson(`${url}?${countParams}`)).count || 0);
  const features = [];
  const pageSize = 1_000;

  for (let offset = 0; offset < count; offset += pageSize) {
    const params = new URLSearchParams({
      where,
      outFields: '*',
      orderByFields: 'OBJECTID ASC',
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
