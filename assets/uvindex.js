const state = {
  map: null,
  manifest: null,
  overlay: null,
  frameRequest: 0,
  frameCache: new Map(),
  timeControl: null,
  scaleControl: null,
  playback: null,
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  Object.assign(els, {
    map: document.getElementById('uvi-map'),
    show: document.getElementById('show-uvi'),
    hour: document.getElementById('uvi-hour'),
    hourLabel: document.getElementById('uvi-hour-label'),
    opacity: document.getElementById('uvi-opacity'),
    play: document.getElementById('uvi-play'),
    timezone: document.getElementById('uvi-timezone'),
    useDeviceTime: document.getElementById('uvi-use-device-time'),
    status: document.getElementById('uvi-status'),
  });

  initMap();
  bindControls();
  loadForecast();
});

function initMap() {
  state.map = L.map(els.map, {
    center: [39.5, -98.5],
    zoom: 4,
    minZoom: 3,
    maxZoom: 9,
    worldCopyJump: false,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);

  state.map.createPane('uviPane');
  state.map.getPane('uviPane').style.zIndex = 430;

  state.timeControl = L.control({ position: 'bottomleft' });
  state.timeControl.onAdd = () => L.DomUtil.create('div', 'uv-time-control');
  state.timeControl.addTo(state.map);

  state.scaleControl = L.control({ position: 'bottomright' });
  state.scaleControl.onAdd = () => L.DomUtil.create('div', 'uv-scale-control');
  state.scaleControl.addTo(state.map);
}

function bindControls() {
  els.show.addEventListener('change', renderFrame);
  els.hour.addEventListener('input', renderFrame);
  els.opacity.addEventListener('input', () => {
    if (state.overlay) state.overlay.setOpacity(Number(els.opacity.value) / 100);
  });
  els.play.addEventListener('click', togglePlayback);
  els.timezone.addEventListener('change', renderFrame);
  els.useDeviceTime.addEventListener('click', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if ([...els.timezone.options].some(option => option.value === zone)) {
      els.timezone.value = zone;
    }
    renderFrame();
  });
}

async function loadForecast() {
  setStatus('Loading NOAA UV Index forecast...');
  try {
    const response = window.__NOAA_UVI_MANIFEST__ ? null : await fetch(liveDataUrl('assets/live/uvi/manifest.json'), { cache: 'no-store' });
    if (response && !response.ok) throw new Error('NOAA UV Index forecast has not been published yet.');
    state.manifest = window.__NOAA_UVI_MANIFEST__ || await response.json();
    if (!state.manifest.frames?.length) throw new Error(state.manifest.message || 'NOAA UV Index forecast is unavailable.');

    els.hour.min = '0';
    els.hour.max = String(state.manifest.frames.length - 1);
    els.hour.value = String(findInitialFrameIndex());
    els.hour.disabled = false;
    els.play.disabled = false;
    state.map.fitBounds(state.manifest.bounds, { padding: [10, 10] });
    renderScale();
    renderFrame();
    setStatus(`${state.manifest.stale ? 'Using cached' : 'Loaded'} ${state.manifest.model || 'NOAA UV Index'} run: ${formatTime(state.manifest.run)}.`);
  } catch (error) {
    els.show.checked = false;
    els.hour.disabled = true;
    els.play.disabled = true;
    clearOverlay();
    setStatus(error.message || 'Unable to load NOAA UV Index data.', true);
  }
}

function findInitialFrameIndex() {
  const now = Date.now();
  const frames = state.manifest.frames;
  let bestIndex = 0;
  let bestDistance = Infinity;
  frames.forEach((frame, index) => {
    const distance = Math.abs(Date.parse(frame.validTime) - now);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function renderFrame() {
  if (!state.manifest) return;
  if (!els.show.checked) {
    stopPlayback();
    clearOverlay();
    return;
  }

  const frame = state.manifest.frames[Number(els.hour.value)];
  if (!frame) return;
  const url = assetUrl(frame.path);
  const requestId = ++state.frameRequest;
  preloadFrame(url).ready.then(image => {
    if (!image || requestId !== state.frameRequest || !els.show.checked) return;
    const nextOverlay = L.imageOverlay(url, state.manifest.bounds, {
      opacity: Number(els.opacity.value) / 100,
      pane: 'uviPane',
      interactive: false,
    }).addTo(state.map);
    const previous = state.overlay;
    state.overlay = nextOverlay;
    if (previous) previous.remove();
  });
  preloadNeighborFrames(Number(els.hour.value));

  const token = `F${String(frame.hour).padStart(3, '0')}`;
  const label = `${token} | valid ${formatTime(frame.validTime)} | max ${frame.maxUvi}`;
  els.hourLabel.textContent = label;
  state.timeControl.getContainer().innerHTML = `<button type="button" data-uvi-step="-1" aria-label="Previous UV forecast hour">&larr;</button><div><strong>UV Index ${token}</strong><span>${escapeHtml(formatTime(frame.validTime))}</span></div><button type="button" data-uvi-step="1" aria-label="Next UV forecast hour">&rarr;</button>`;
  state.timeControl.getContainer().querySelectorAll('[data-uvi-step]').forEach(button => {
    button.addEventListener('click', () => advanceFrame(Number(button.dataset.uviStep)));
  });
}

function preloadFrame(url) {
  const cached = state.frameCache.get(url);
  if (cached) return cached;
  const image = new Image();
  const entry = {
    image,
    ready: new Promise(resolve => {
      image.onload = () => resolve(image);
      image.onerror = () => {
        state.frameCache.delete(url);
        resolve(null);
      };
    }),
  };
  state.frameCache.set(url, entry);
  image.src = url;
  return entry;
}

function preloadNeighborFrames(index) {
  [-2, -1, 1, 2].forEach(offset => {
    const frame = state.manifest.frames[index + offset];
    if (frame) preloadFrame(assetUrl(frame.path));
  });
}

function advanceFrame(step) {
  const max = Number(els.hour.max);
  const next = Math.max(0, Math.min(max, Number(els.hour.value) + step));
  els.hour.value = String(next);
  renderFrame();
}

function togglePlayback() {
  if (state.playback) {
    stopPlayback();
    return;
  }
  els.play.textContent = 'Pause';
  state.playback = window.setInterval(() => {
    const max = Number(els.hour.max);
    els.hour.value = String(Number(els.hour.value) >= max ? 0 : Number(els.hour.value) + 1);
    renderFrame();
  }, 900);
}

function stopPlayback() {
  if (!state.playback) return;
  window.clearInterval(state.playback);
  state.playback = null;
  els.play.textContent = 'Play';
}

function clearOverlay() {
  state.frameRequest += 1;
  if (state.overlay) {
    state.overlay.remove();
    state.overlay = null;
  }
}

function renderScale() {
  const container = state.scaleControl.getContainer();
  const breaks = state.manifest.breaks || [];
  const colors = state.manifest.colors || [];
  container.style.setProperty('--scale-steps', colors.length);
  container.innerHTML = `<strong>UV Index</strong><div class="uv-scale-colors">${colors.map(color => `<i style="background:${escapeHtml(color)}"></i>`).join('')}</div><div class="uv-scale-labels">${breaks.map(value => `<span>${escapeHtml(String(value))}</span>`).join('')}<span>11+</span></div>`;
}

function assetUrl(path) {
  const version = state.manifest?.generatedAt || state.manifest?.run || '';
  return `assets/live/uvi/${path}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
}

function liveDataUrl(url) {
  return `${url}${url.includes('?') ? '&' : '?'}cachebust=${Date.now()}`;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('is-error', isError);
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown time';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: els.timezone?.value || 'America/Los_Angeles',
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}
