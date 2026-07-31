const SPC_BASE = 'https://www.spc.noaa.gov/exper/archive/events';
const IEM_RAOB_BASE = 'https://mesonet.agron.iastate.edu/json/raob.py';
const IEM_RAOB_NETWORK =
  'https://mesonet.agron.iastate.edu/geojson/network.py?network=RAOB';
const PYODIDE_VERSION = 'v0.26.4';

let CONUS_STATIONS = [
  { id: 'UIL', name: 'Quillayute, WA', lat: 47.95, lon: -124.56 },
  { id: 'SLE', name: 'Salem, OR', lat: 44.91, lon: -123.00 },
  { id: 'MFR', name: 'Medford, OR', lat: 42.37, lon: -122.87 },
  { id: 'OTX', name: 'Spokane, WA', lat: 47.70, lon: -116.40 },
  { id: 'BOI', name: 'Boise, ID', lat: 43.57, lon: -116.24 },
  { id: 'LKN', name: 'Elko, NV', lat: 40.86, lon: -115.74 },
  { id: 'REV', name: 'Reno, NV', lat: 39.57, lon: -119.80 },
  { id: 'OAK', name: 'Oakland, CA', lat: 37.72, lon: -122.22 },
  { id: 'NKX', name: 'San Diego, CA', lat: 32.87, lon: -117.14 },
  { id: 'VEF', name: 'Las Vegas, NV', lat: 36.05, lon: -115.18 },
  { id: 'FGZ', name: 'Flagstaff, AZ', lat: 35.23, lon: -111.82 },
  { id: 'SLC', name: 'Salt Lake City, UT', lat: 40.77, lon: -111.97 },
  { id: 'RIW', name: 'Riverton, WY', lat: 43.06, lon: -108.48 },
  { id: 'GJT', name: 'Grand Junction, CO', lat: 39.12, lon: -108.53 },
  { id: 'DNR', name: 'Denver, CO', lat: 39.76, lon: -104.87 },
  { id: 'ABQ', name: 'Albuquerque, NM', lat: 35.04, lon: -106.62 },
  { id: 'EPZ', name: 'Santa Teresa, NM', lat: 31.87, lon: -106.70 },
  { id: 'TFX', name: 'Great Falls, MT', lat: 47.46, lon: -111.38 },
  { id: 'GGW', name: 'Glasgow, MT', lat: 48.21, lon: -106.62 },
];

let CONUS_IDS = new Set(CONUS_STATIONS.map(station => station.id));

const state = {
  pyodide: null,
  pyReady: null,
  profilesByCycle: new Map(),
  plotCache: new Map(),
  markers: new Map(),
  map: null,
  cycles: [],
  selectedCycle: null,
  preloadPromise: null,
  activeRequest: 0,
};

const els = {};

document.addEventListener('DOMContentLoaded', async () => {
  Object.assign(els, {
    stationSelect: document.getElementById('station-select'),
    refresh: document.getElementById('refresh-sounding'),
    status: document.getElementById('sounding-status'),
    preloadSummary: document.getElementById('preload-summary'),
    cycleToggle: document.getElementById('cycle-toggle'),
    cycle: document.getElementById('selected-cycle'),
    dataSource: document.getElementById('data-source-link'),
    spcSource: document.getElementById('spc-source-link'),
    output: document.getElementById('skewt-output'),
    placeholder: document.getElementById('plot-placeholder'),
    cycleList: document.getElementById('cycle-list'),
    diagnostics: document.getElementById('sounding-diagnostics'),
  });

  const requestedStation =
    new URLSearchParams(window.location.search).get('station')?.toUpperCase();

  await loadConusStations();
  populateStationSelect(
    requestedStation && CONUS_IDS.has(requestedStation) ? requestedStation : 'SLC'
  );
  state.cycles = recentCycles();
  state.selectedCycle = state.cycles.filter(cycle => !cycle.future).reduce(
    (latest, cycle) => cycle.timestamp > latest ? cycle.timestamp : latest,
    state.cycles[0].timestamp,
  );
  renderCycleToggle();
  initStationMap();
  els.refresh.addEventListener('click', refreshAllSites);
  els.stationSelect.addEventListener('change', () => selectStation(getStation()));

  preloadConusSoundings().then(() => selectStation(getStation()));
});

function getStation() {
  return els.stationSelect.value;
}

function setStatus(message) {
  els.status.textContent = message;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function makeCycle(date) {
  const yyyy = date.getUTCFullYear();
  const yy = pad(yyyy % 100);
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const ymd = `${yyyy}${mm}${dd}`;
  const short = `${yy}${mm}${dd}${hh}`;
  return {
    date,
    timestamp: `${yyyy}${mm}${dd}${hh}00`,
    label: `${yyyy}-${mm}-${dd} ${hh}Z`,
    urlStem: `${SPC_BASE}/${ymd}/soundings/${short}_SNDG`,
  };
}

function recentCycles() {
  const now = new Date();
  const currentUtcDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const cycles = [];
  for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
    const dayStart = currentUtcDay - dayOffset * 24 * 60 * 60 * 1000;
    [0, 6, 12, 18].forEach(hour => {
      const cycle = makeCycle(new Date(dayStart + hour * 60 * 60 * 1000));
      cycle.future = cycle.date > now;
      cycles.push(cycle);
    });
  }
  return cycles;
}

function getSelectedCycle() {
  return state.cycles.find(cycle => cycle.timestamp === state.selectedCycle);
}

function getCycleProfiles() {
  return state.profilesByCycle.get(state.selectedCycle) || new Map();
}

function selectStation(station) {
  els.stationSelect.value = station;

  if (state.profilesByCycle.size && !getCycleProfiles().has(station)) {
    const newestAvailable = [...state.cycles]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .find(cycle => state.profilesByCycle.get(cycle.timestamp)?.has(station));
    if (newestAvailable) state.selectedCycle = newestAvailable.timestamp;
  }

  renderCycleToggle();
  updateMapMarkers(station);
  updatePreloadSummary();
  renderStation(station);
}

function renderCycleToggle() {
  els.cycleToggle.innerHTML = '';
  const station = getStation();
  const availabilityKnown = state.profilesByCycle.size > 0;
  state.cycles.forEach(cycle => {
    const available = state.profilesByCycle.get(cycle.timestamp)?.has(station) || false;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cycle-toggle-button';
    button.dataset.cycle = cycle.timestamp;
    button.setAttribute('aria-pressed', String(cycle.timestamp === state.selectedCycle));
    button.disabled = cycle.future || (availabilityKnown && !available);
    button.title = cycle.future
      ? `${cycle.label} - not yet available`
      : button.disabled
      ? `${cycle.label} - no ${station} profile`
      : cycle.label;

    const date = document.createElement('span');
    date.textContent = `${pad(cycle.date.getUTCMonth() + 1)}/${pad(cycle.date.getUTCDate())}`;
    const hour = document.createElement('strong');
    hour.textContent = `${pad(cycle.date.getUTCHours())}Z`;
    button.append(date, hour);

    button.addEventListener('click', () => {
      state.selectedCycle = cycle.timestamp;
      renderCycleToggle();
      updateMapMarkers();
      updatePreloadSummary();
      renderStation(getStation());
    });
    els.cycleToggle.appendChild(button);
  });
}

async function fetchJson(url) {
  const separator = url.includes('?') ? '&' : '?';
  const response = await fetch(`${url}${separator}cachebust=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function normalizeStationId(id = '') {
  return id.length === 4 && id.startsWith('K') ? id.slice(1) : id;
}

async function loadConusStations() {
  try {
    const data = await fetchJson(IEM_RAOB_NETWORK);
    const stations = (data.features || [])
      .filter(feature => {
        const properties = feature.properties || {};
        const coordinates = feature.geometry?.coordinates || [];
        const [lon, lat] = coordinates;
        return properties.country === 'US'
          && /^K[A-Z0-9]{3}$/.test(properties.sid || '')
          && !properties.archive_end
          && lon >= -125
          && lon <= -66
          && lat >= 24
          && lat <= 50;
      })
      .map(feature => {
        const properties = feature.properties;
        const [lon, lat] = feature.geometry.coordinates;
        const name = properties.sname
          .replace(/\/US\s*$/, '')
          .replaceAll('_', ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          id: normalizeStationId(properties.sid),
          name,
          lat,
          lon,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    if (stations.length < 60) throw new Error('Incomplete CONUS station metadata');
    CONUS_STATIONS = stations;
    CONUS_IDS = new Set(stations.map(station => station.id));
  } catch (error) {
    console.error('CONUS station metadata failed; using bundled stations:', error);
  }
}

function populateStationSelect(selectedStation) {
  els.stationSelect.innerHTML = '';
  CONUS_STATIONS.forEach(station => {
    const option = document.createElement('option');
    option.value = station.id;
    option.textContent = `${station.id} - ${station.name}`;
    option.selected = station.id === selectedStation;
    els.stationSelect.appendChild(option);
  });
}

function initStationMap() {
  if (!window.L) {
    els.preloadSummary.textContent = 'Map unavailable. Use the station menu.';
    return;
  }

  state.map = L.map('station-map', {
    zoomControl: true,
    scrollWheelZoom: false,
  }).setView([39.0, -98.0], 3);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 8,
    attribution: '&copy; OpenStreetMap',
  }).addTo(state.map);

  CONUS_STATIONS.forEach(station => {
    const marker = L.circleMarker([station.lat, station.lon], markerStyle(false, false))
      .addTo(state.map)
      .bindTooltip(`${station.id} · ${station.name}`, { direction: 'top' });
    marker.on('click', () => {
      selectStation(station.id);
    });
    state.markers.set(station.id, marker);
  });
}

function markerStyle(available, selected) {
  return {
    radius: selected ? 8 : 5,
    color: selected ? '#ffffff' : available ? '#9be6c6' : '#94a3b8',
    weight: selected ? 3 : 2,
    fillColor: available ? '#1b9e77' : '#64748b',
    fillOpacity: available ? 0.95 : 0.55,
  };
}

function updateMapMarkers(selected = getStation()) {
  const profiles = getCycleProfiles();
  state.markers.forEach((marker, station) => {
    marker.setStyle(markerStyle(profiles.has(station), station === selected));
  });
}

function updatePreloadSummary() {
  const cycle = getSelectedCycle();
  const count = getCycleProfiles().size;
  els.preloadSummary.textContent =
    `${count} of ${CONUS_STATIONS.length} sites at ${cycle.label}.`;
}

function renderDownloadedCycles(cycles) {
  els.cycleList.innerHTML = '';
  cycles.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item.cycle.future
      ? `${item.cycle.label} - not yet available`
      : item.ok
      ? `${item.cycle.label} - ${item.count} CONUS profiles`
      : `${item.cycle.label} - download failed`;
    li.className = item.ok && !item.cycle.future ? 'cycle-ok' : 'cycle-missing';
    els.cycleList.appendChild(li);
  });
}

async function preloadConusSoundings(force = false) {
  if (state.preloadPromise && !force) return state.preloadPromise;

  const preload = (async () => {
    const cycles = state.cycles;
    els.preloadSummary.textContent = `Downloading ${cycles.length} recent sounding cycles...`;

    const responses = await Promise.all(cycles.map(async cycle => {
      if (cycle.future) {
        return { cycle, data: { profiles: [] }, ok: true };
      }
      try {
        const data = await fetchJson(`${IEM_RAOB_BASE}?ts=${cycle.timestamp}`);
        return { cycle, data, ok: true };
      } catch (error) {
        return { cycle, ok: false, error };
      }
    }));

    const profilesByCycle = new Map();
    const downloadedCycles = responses.map(result => {
      const profiles = new Map();
      if (result.ok) {
        (result.data.profiles || []).forEach(record => {
          const station = normalizeStationId(record.station);
          if (!CONUS_IDS.has(station)) return;
          if (!Array.isArray(record.profile) || record.profile.length < 6) return;
          const stationMeta = CONUS_STATIONS.find(item => item.id === station);
          profiles.set(station, {
            station,
            latitude: stationMeta.lat,
            cycle: result.cycle,
            profile: record.profile,
            dataUrl: `${IEM_RAOB_BASE}?ts=${result.cycle.timestamp}&station=${station}`,
            spcUrl: `${result.cycle.urlStem}/${station}.gif`,
          });
        });
      }
      profilesByCycle.set(result.cycle.timestamp, profiles);
      return { cycle: result.cycle, ok: result.ok, count: profiles.size };
    });

    state.profilesByCycle = profilesByCycle;
    renderDownloadedCycles(downloadedCycles);
    renderCycleToggle();
    updateMapMarkers();
    updatePreloadSummary();
    return profilesByCycle;
  })();

  state.preloadPromise = preload;
  try {
    return await preload;
  } finally {
    if (force) state.preloadPromise = null;
  }
}

async function loadMetPy() {
  if (state.pyReady) return state.pyReady;
  state.pyReady = (async () => {
    const pyodide = await loadPyodide({
      indexURL: `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`,
    });
    await pyodide.loadPackage([
      'micropip',
      'matplotlib',
      'numpy',
      'scipy',
      'pandas',
      'packaging',
      'pyproj',
      'lzma',
    ]);
    await pyodide.runPythonAsync(`
import micropip
await micropip.install(["pint", "pooch", "traitlets", "xarray"])
await micropip.install("metpy==1.6.3", deps=False)
`);
    await pyodide.runPythonAsync(`
import base64
import io
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from metpy.plots import Hodograph, SkewT
from metpy.units import units
from metpy.calc import (
    downdraft_cape,
    lcl,
    mixed_layer_cape_cin,
    mixed_parcel,
    most_unstable_cape_cin,
    most_unstable_parcel,
    parcel_profile,
    surface_based_cape_cin,
    wind_components,
)


def parse_iem_profile(profile_json):
    rows = []
    for row in json.loads(profile_json):
        p = row.get("pres")
        h = row.get("hght")
        t = row.get("tmpc")
        td = row.get("dwpc")
        wd = row.get("drct")
        ws = row.get("sknt")
        if p is None or t is None or td is None:
            continue
        rows.append((
            float(p),
            np.nan if h is None else float(h),
            float(t),
            float(td),
            np.nan if wd is None else float(wd),
            np.nan if ws is None else float(ws),
        ))
    if len(rows) < 6:
        raise ValueError("Could not parse enough pressure-level rows from IEM RAOB JSON.")
    arr = np.array(rows, dtype=float)
    arr = arr[np.argsort(arr[:, 0])[::-1]]
    _, unique_idx = np.unique(arr[:, 0], return_index=True)
    return arr[np.sort(unique_idx)]


def calculate_diagnostics(arr, p, t, td):
    diagnostics = {
        "mucape": None,
        "mu_height": None,
        "mlcape": None,
        "sbcape": None,
        "dcape": None,
        "advection": "Unavailable",
        "dgz": "Unavailable",
        "dgz_p_bottom": None,
        "dgz_p_top": None,
    }

    def cape_value(calculation):
        try:
            value = calculation()
            if isinstance(value, tuple):
                value = value[0]
            return int(round(max(0.0, float(value.to("J/kg").magnitude))))
        except Exception:
            return None

    diagnostics["mucape"] = cape_value(lambda: most_unstable_cape_cin(p, t, td))
    diagnostics["mlcape"] = cape_value(lambda: mixed_layer_cape_cin(p, t, td))
    diagnostics["sbcape"] = cape_value(lambda: surface_based_cape_cin(p, t, td))
    diagnostics["dcape"] = cape_value(lambda: downdraft_cape(p, t, td))

    try:
        _, _, _, mu_index = most_unstable_parcel(p, t, td)
        heights = arr[:, 1]
        surface_height = heights[np.isfinite(heights)][0]
        mu_height = heights[mu_index]
        if np.isfinite(mu_height):
            diagnostics["mu_height"] = int(round(max(0.0, mu_height - surface_height)))
    except Exception:
        pass

    try:
        wind_mask = np.isfinite(arr[:, 4]) & np.isfinite(arr[:, 5])
        wind_p = arr[wind_mask, 0]
        wind_u, wind_v = wind_components(
            arr[wind_mask, 5] * units.knots,
            arr[wind_mask, 4] * units.degrees,
        )
        surface_p = float(p[0].magnitude)
        low = (wind_p <= surface_p) & (wind_p >= surface_p - 100)
        middle = (wind_p < surface_p - 100) & (wind_p >= surface_p - 250)
        if np.count_nonzero(low) and np.count_nonzero(middle):
            def vector_direction(u_values, v_values):
                mean_u = float(np.mean(u_values.magnitude))
                mean_v = float(np.mean(v_values.magnitude))
                return (np.degrees(np.arctan2(-mean_u, -mean_v)) + 360) % 360

            low_direction = vector_direction(wind_u[low], wind_v[low])
            middle_direction = vector_direction(wind_u[middle], wind_v[middle])
            turning = (middle_direction - low_direction + 180) % 360 - 180
            if turning >= 15:
                diagnostics["advection"] = f"Warm advection implied (veering {turning:.0f} deg)"
            elif turning <= -15:
                diagnostics["advection"] = f"Cold advection implied (backing {abs(turning):.0f} deg)"
            else:
                diagnostics["advection"] = f"Little directional turning ({turning:+.0f} deg)"
    except Exception:
        pass

    dgz_mask = (
        (arr[:, 2] >= -18)
        & (arr[:, 2] <= -12)
        & np.isfinite(arr[:, 1])
    )
    if np.count_nonzero(dgz_mask) >= 2:
        surface_height = arr[np.isfinite(arr[:, 1]), 1][0]
        base = max(0.0, float(np.min(arr[dgz_mask, 1]) - surface_height))
        top = max(base, float(np.max(arr[dgz_mask, 1]) - surface_height))
        diagnostics["dgz"] = f"{base / 1000:.1f}-{top / 1000:.1f} km AGL"
        diagnostics["dgz_p_bottom"] = float(np.max(arr[dgz_mask, 0]))
        diagnostics["dgz_p_top"] = float(np.min(arr[dgz_mask, 0]))

    return diagnostics


def temperature_advection_profile(arr, latitude):
    wind_mask = np.isfinite(arr[:, 4]) & np.isfinite(arr[:, 5])
    if np.count_nonzero(wind_mask) < 6:
        return np.array([]), np.array([]), np.array([]), np.array([])

    wind_p = arr[wind_mask, 0]
    wind_u, wind_v = wind_components(
        arr[wind_mask, 5] * units.knots,
        arr[wind_mask, 4] * units.degrees,
    )
    wind_u = wind_u.to("m/s").magnitude
    wind_v = wind_v.to("m/s").magnitude

    surface_level = np.floor(wind_p[0] / 50) * 50
    bottom_level = max(100, np.ceil(wind_p[-1] / 50) * 50)
    target_p = np.arange(surface_level, bottom_level - 1, -50)
    if target_p.size < 4:
        return np.array([]), np.array([]), np.array([]), np.array([])

    log_wind_p = np.log(wind_p[::-1])
    log_target_p = np.log(target_p)
    u_interp = np.interp(log_target_p, log_wind_p, wind_u[::-1])
    v_interp = np.interp(log_target_p, log_wind_p, wind_v[::-1])

    du_dlnp = np.gradient(u_interp, log_target_p)
    dv_dlnp = np.gradient(v_interp, log_target_p)
    coriolis = 2 * 7.2921159e-5 * np.sin(np.radians(latitude))
    dry_air_gas_constant = 287.05
    advection = (
        coriolis
        / dry_air_gas_constant
        * (u_interp * dv_dlnp - v_interp * du_dlnp)
        * 3600
    )

    if advection.size >= 3:
        advection = np.convolve(advection, np.ones(3) / 3, mode="same")
    return target_p, advection, u_interp, v_interp


def make_skewt(profile_json, station, cycle_label, station_latitude):
    arr = parse_iem_profile(profile_json)
    p = arr[:, 0] * units.hPa
    t = arr[:, 2] * units.degC
    td = arr[:, 3] * units.degC
    wd = arr[:, 4] * units.degrees
    ws = arr[:, 5] * units.knots
    diagnostics = calculate_diagnostics(arr, p, t, td)
    advection_p, advection, grid_u, grid_v = temperature_advection_profile(
        arr,
        station_latitude,
    )

    fig = plt.figure(figsize=(10.5, 9), dpi=150)
    skew = SkewT(fig, rotation=45, rect=(0.065, 0.055, 0.68, 0.91))
    skew.plot(p, t, color="#d95f02", linewidth=2.0, label="Temperature")
    skew.plot(p, td, color="#1b9e77", linewidth=2.0, label="Dew point")

    try:
        lcl_p, lcl_t = lcl(p[0], t[0], td[0])
        prof = parcel_profile(p, t[0], td[0]).to("degC")
        skew.plot(p, prof, color="#7570b3", linewidth=1.5, linestyle="--", label="Surface parcel")
        skew.ax.plot(lcl_t, lcl_p, marker="o", color="#7570b3", markersize=5)
    except Exception:
        pass

    try:
        _, mixed_t, mixed_td = mixed_parcel(
            p,
            t,
            td,
            depth=100 * units.hPa,
        )
        mixed_prof = parcel_profile(p, mixed_t, mixed_td).to("degC")
        skew.plot(
            p,
            mixed_prof,
            color="#7570b3",
            linewidth=1.5,
            linestyle=":",
            label="100-hPa mixed parcel",
        )
    except Exception:
        pass

    skew.ax.set_ylim(1050, 100)
    skew.ax.set_xlim(-40, 45)
    skew.plot_dry_adiabats(alpha=0.35, linewidth=0.7)
    skew.plot_moist_adiabats(alpha=0.35, linewidth=0.7)
    skew.plot_mixing_lines(alpha=0.25, linewidth=0.7)
    if diagnostics["dgz_p_bottom"] is not None:
        skew.ax.axhspan(
            diagnostics["dgz_p_top"],
            diagnostics["dgz_p_bottom"],
            color="#56b4e9",
            alpha=0.14,
            label="DGZ (-12 to -18 C)",
        )
    skew.ax.axvline(0, color="#444444", linewidth=1.0)
    skew.ax.set_title(f"{station} Observed Sounding - {cycle_label}", loc="left", fontsize=13)
    skew.ax.set_xlabel("Temperature (deg C)")
    skew.ax.set_ylabel("Pressure (hPa)")
    skew.ax.legend(loc="upper right", fontsize=9)

    try:
        hodo_mask = (
            np.isfinite(arr[:, 1])
            & np.isfinite(arr[:, 4])
            & np.isfinite(arr[:, 5])
        )
        hodo_height = arr[hodo_mask, 1]
        surface_height = hodo_height[0]
        hodo_height = hodo_height - surface_height
        hodo_u, hodo_v = wind_components(
            arr[hodo_mask, 5] * units.knots,
            arr[hodo_mask, 4] * units.degrees,
        )
        hodo_u = hodo_u.to("knots").magnitude
        hodo_v = hodo_v.to("knots").magnitude
        hodo_keep = (hodo_height >= 0) & (hodo_height <= 12000)
        hodo_height = hodo_height[hodo_keep]
        hodo_u = hodo_u[hodo_keep]
        hodo_v = hodo_v[hodo_keep]
        hodo_order = np.argsort(hodo_height)
        hodo_height = hodo_height[hodo_order]
        hodo_u = hodo_u[hodo_order]
        hodo_v = hodo_v[hodo_order]

        if hodo_height.size >= 4:
            component_peak = np.nanpercentile(
                np.abs(np.concatenate((hodo_u, hodo_v))),
                98,
            )
            component_range = max(40, int(np.ceil(component_peak / 20)) * 20)
            hodo_ax = skew.ax.inset_axes([0.035, 0.755, 0.21, 0.21], zorder=10)
            hodo_ax.set_facecolor((1, 1, 1, 0.92))
            hodo = Hodograph(hodo_ax, component_range=component_range)
            hodo.add_grid(
                increment=20,
                color="#64748b",
                linewidth=0.55,
                alpha=0.55,
            )
            hodo.plot_colormapped(
                hodo_u,
                hodo_v,
                hodo_height,
                cmap="turbo",
                linewidth=2.2,
            )
            for marker_km in (1, 3, 6, 9):
                marker_height = marker_km * 1000
                if marker_height > hodo_height[-1]:
                    continue
                marker_u = np.interp(marker_height, hodo_height, hodo_u)
                marker_v = np.interp(marker_height, hodo_height, hodo_v)
                hodo_ax.plot(
                    marker_u,
                    marker_v,
                    marker="o",
                    markersize=2.6,
                    color="#111827",
                )
                hodo_ax.annotate(
                    str(marker_km),
                    (marker_u, marker_v),
                    xytext=(3, 2),
                    textcoords="offset points",
                    fontsize=5,
                    color="#111827",
                )
            hodo_ax.tick_params(labelsize=5, length=1.5, pad=1)
            hodo_ax.set_title("Hodograph (kt)", fontsize=7, pad=1)
            for spine in hodo_ax.spines.values():
                spine.set_color("#475569")
                spine.set_linewidth(0.8)
    except Exception:
        pass

    fig.canvas.draw()
    skew_position = skew.ax.get_position()
    barb_left = skew_position.x1 + 0.012
    barb_width = 0.07
    advection_left = barb_left + barb_width + 0.012
    advection_width = max(0.11, 0.98 - advection_left)

    barb_ax = fig.add_axes(
        [barb_left, skew_position.y0, barb_width, skew_position.height],
        sharey=skew.ax,
    )
    barb_ax.set_xlim(0, 1)
    barb_ax.set_ylim(1050, 100)
    barb_ax.set_axis_off()
    for guide_pressure in np.arange(100, 1001, 100):
        barb_ax.axhline(guide_pressure, color="#94a3b8", linewidth=0.5, alpha=0.22)
    barb_ax.barbs(
        np.full(advection_p.shape, 0.5),
        advection_p,
        grid_u * 1.943844,
        grid_v * 1.943844,
        length=7.0,
        linewidth=1.05,
        pivot="middle",
        sizes={"emptybarb": 0.18, "spacing": 0.22, "height": 0.45},
    )

    advection_ax = fig.add_axes(
        [advection_left, skew_position.y0, advection_width, skew_position.height],
        sharey=skew.ax,
    )
    advection_ax.axvline(0, color="#475569", linewidth=0.8)
    if advection.size:
        advection_ax.plot(advection, advection_p, color="#334155", linewidth=1.0)
        advection_ax.fill_betweenx(
            advection_p,
            0,
            advection,
            where=advection >= 0,
            color="#dc2626",
            alpha=0.72,
            interpolate=True,
        )
        advection_ax.fill_betweenx(
            advection_p,
            0,
            advection,
            where=advection < 0,
            color="#2563eb",
            alpha=0.72,
            interpolate=True,
        )
        limit = max(0.1, float(np.nanpercentile(np.abs(advection), 95)) * 1.25)
        advection_ax.set_xlim(-limit, limit)
    else:
        advection_ax.text(
            0.5,
            0.5,
            "Unavailable",
            transform=advection_ax.transAxes,
            ha="center",
            va="center",
            fontsize=9,
            color="#64748b",
        )
    advection_ax.set_ylim(1050, 100)
    advection_ax.tick_params(axis="y", labelleft=False, left=False)
    advection_ax.tick_params(axis="x", labelsize=8)
    advection_ax.grid(axis="y", alpha=0.2)
    advection_ax.set_title("Implied Temp\\nAdvection", fontsize=11)
    advection_ax.set_xlabel("°C/hr", fontsize=9)

    out = io.BytesIO()
    fig.savefig(
        out,
        format="png",
        bbox_inches="tight",
        pad_inches=0.02,
        facecolor="white",
    )
    plt.close(fig)
    diagnostics.pop("dgz_p_bottom", None)
    diagnostics.pop("dgz_p_top", None)
    return json.dumps({
        "image": "data:image/png;base64," + base64.b64encode(out.getvalue()).decode("ascii"),
        "diagnostics": diagnostics,
    })
`);
    state.pyodide = pyodide;
    return pyodide;
  })();
  return state.pyReady;
}

function showUnavailable(station) {
  const cycle = getSelectedCycle();
  els.output.classList.remove('is-visible');
  const upstreamNote = station === 'OTX'
    ? ' The active KOTX site is currently absent from the SPC near-real-time feed.'
    : '';
  els.placeholder.textContent =
    `No ${station} sounding was available at ${cycle.label}.${upstreamNote}`;
  els.placeholder.classList.add('is-visible');
  els.diagnostics.hidden = true;
  els.cycle.textContent = 'Cycle: unavailable';
  setStatus(station === 'OTX'
    ? `KOTX has no profile in the recent SPC-sourced archive at ${cycle.label}.`
    : `${station} has no observed profile at ${cycle.label}.`);
}

function renderDiagnostics(values) {
  const formatCape = value => value == null ? 'Unavailable' : `${value} J/kg`;
  const diagnostics = {
    mucape: values.mucape == null
      ? 'Unavailable'
      : `${formatCape(values.mucape)} · ${values.mu_height ?? '—'} m AGL`,
    mlcape: formatCape(values.mlcape),
    sbcape: formatCape(values.sbcape),
    dcape: formatCape(values.dcape),
    advection: values.advection,
    dgz: values.dgz,
  };

  els.diagnostics.querySelectorAll('[data-diagnostic]').forEach(element => {
    element.textContent = diagnostics[element.dataset.diagnostic] || 'Unavailable';
  });
  els.diagnostics.hidden = false;
}

function showPlot(station, found, result) {
  els.output.src = result.image;
  els.output.dataset.station = station;
  els.output.dataset.cycle = found.cycle.timestamp;
  els.output.alt = `MetPy skew-T plot for ${station} at ${found.cycle.label}`;
  els.output.classList.add('is-visible');
  els.placeholder.classList.remove('is-visible');
  els.cycle.textContent = `Cycle: ${found.cycle.label}`;
  els.dataSource.href = found.dataUrl;
  els.spcSource.href = found.spcUrl;
  renderDiagnostics(result.diagnostics);
  setStatus(`Updated ${station} from ${found.cycle.label}.`);
}

async function renderStation(station) {
  const requestId = ++state.activeRequest;
  updateMapMarkers(station);

  try {
    if (!state.profilesByCycle.size) await preloadConusSoundings();
    if (requestId !== state.activeRequest) return;

    const found = getCycleProfiles().get(station);
    if (!found) {
      showUnavailable(station);
      return;
    }

    const plotKey = `${station}-${found.cycle.timestamp}`;
    if (state.plotCache.has(plotKey)) {
      showPlot(station, found, state.plotCache.get(plotKey));
      return;
    }

    const displayedPlotMatches =
      els.output.dataset.station === station
      && els.output.dataset.cycle === found.cycle.timestamp;
    if (!displayedPlotMatches) {
      els.output.classList.remove('is-visible');
      els.diagnostics.hidden = true;
      els.placeholder.textContent =
        `Rendering ${station} from ${found.cycle.label} with ${found.profile.length} levels...`;
      els.placeholder.classList.add('is-visible');
    }
    setStatus(`${found.profile.length} ${station} levels cached. Plotting with MetPy...`);

    const pyodide = await loadMetPy();
    if (requestId !== state.activeRequest) return;
    pyodide.globals.set('profile_json', JSON.stringify(found.profile));
    pyodide.globals.set('station_id', station);
    pyodide.globals.set('cycle_label', found.cycle.label);
    pyodide.globals.set('station_latitude', found.latitude);
    const resultJson = await pyodide.runPythonAsync(
      'make_skewt(profile_json, station_id, cycle_label, station_latitude)'
    );
    const result = JSON.parse(resultJson);

    if (requestId !== state.activeRequest) return;
    state.plotCache.set(plotKey, result);
    showPlot(station, found, result);
  } catch (error) {
    els.output.classList.remove('is-visible');
    els.diagnostics.hidden = true;
    els.placeholder.textContent = `Plot unavailable for ${station}.`;
    els.placeholder.classList.add('is-visible');
    setStatus('Select another station or refresh all sites.');
    console.error('Radiosonde rendering failed:', error);
  }
}

async function refreshAllSites() {
  els.refresh.disabled = true;
  setStatus('Refreshing all CONUS sounding profiles...');
  try {
    await preloadConusSoundings(true);
    selectStation(getStation());
  } catch (error) {
    setStatus('CONUS profiles could not be refreshed.');
    console.error('CONUS profile refresh failed:', error);
  } finally {
    els.refresh.disabled = false;
  }
}
