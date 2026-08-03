import { mkdir, writeFile } from 'node:fs/promises';

const outputDirectory = new URL('../assets/live/', import.meta.url);
const firmsKey = 'ba50bf93112cabcd9ed7c7f5e71f631a';
const bounds = '-125,31,-102,49';
const sources = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'];
const firmsBase = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const femsUrl = 'https://fems.fs2c.usda.gov/api/climatology/graphql';
const incidentBase = 'https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/USA_Wildfires_v1/FeatureServer';

await mkdir(outputDirectory, { recursive: true });

const fireResults = await Promise.allSettled(sources.map(async source => {
  const response = await fetch(`${firmsBase}/${firmsKey}/${source}/${bounds}/2`);
  if (!response.ok) throw new Error(`FIRMS ${source} returned ${response.status}`);
  return { source, csv: await response.text() };
}));
const fireResponses = fireResults.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
const unavailableSources = fireResults.flatMap((result, index) => {
  if (result.status === 'fulfilled') return [];
  console.warn(`Skipping ${sources[index]}: ${result.reason.message}`);
  return [sources[index]];
});
if (fireResponses.length === 0) throw new Error('All FIRMS sources were unavailable.');

const fireRows = fireResponses.flatMap(({ source, csv }) => parseCsv(csv).map(row => ({ ...row, source })));
await writeJson('firms.json', {
  generatedAt: new Date().toISOString(),
  bounds,
  days: 2,
  sources: fireResponses.map(response => response.source),
  unavailableSources,
  rows: fireRows
});

const date = new Date().toISOString().slice(0, 10);
const fuelResult = await fems(`query {
  nfdrMinMax(startDate: "${date}", endDate: "${date}", nfdrType: "O", per_page: 20000) {
    data { station_id summary_date ten_hr_tl_fuel_moisture_min hun_hr_tl_fuel_moisture_min thou_hr_tl_fuel_moisture_min }
  }
}`);
const measurements = [...new Map((fuelResult.data?.nfdrMinMax?.data || []).map(row => [row.station_id, row])).values()];
const stationIds = measurements.map(row => row.station_id).join(',');
const stationsResult = stationIds ? await fems(`query {
  stationMetaData(stationIds: "${stationIds}", networkName: "RAWS", per_page: 3000) {
    data { station_id station_name latitude longitude state }
  }
}`) : { data: { stationMetaData: { data: [] } } };
const stations = new Map((stationsResult.data?.stationMetaData?.data || []).map(row => [row.station_id, row]));
const fuelRows = measurements.map(row => ({ ...row, ...stations.get(row.station_id) }))
  .filter(row => Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)));
await writeJson('fuel-moisture.json', { generatedAt: new Date().toISOString(), date, rows: fuelRows });

const [incidents, perimeters] = await Promise.all([0, 1].map(async layerId => {
  const sizeField = layerId === 0 ? 'DailyAcres' : 'GISAcres';
  const where = `IncidentTypeCategory%3D%27WF%27%20AND%20${sizeField}%3E%3D50`;
  const response = await fetch(`${incidentBase}/${layerId}/query?where=${where}&outFields=*&f=geojson`);
  if (!response.ok) throw new Error(`Incident service layer ${layerId} returned ${response.status}`);
  return response.json();
}));
await writeJson('incidents.json', { generatedAt: new Date().toISOString(), incidents, perimeters });

async function fems(query) {
  const response = await fetch(femsUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Error(payload.errors?.[0]?.message || `FEMS returned ${response.status}`);
  return payload;
}

async function writeJson(name, value) {
  await writeFile(new URL(name, outputDirectory), JSON.stringify(value));
}

function parseCsv(csv) {
  const [headerLine, ...lines] = csv.trim().split(/\r?\n/);
  if (!headerLine || lines.length === 0) return [];
  const headers = headerLine.replace(/^\uFEFF/, '').split(',');
  return lines.map(line => Object.fromEntries(headers.map((header, index) => [header, line.split(',')[index] || ''])));
}
