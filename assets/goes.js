const GOES_BASE = 'https://www.star.nesdis.noaa.gov/goes/conus_band.php';
const GOES_PRODUCTS = {
  GEOCOLOR: { label: 'True Color / GeoColor', description: 'True color by day, infrared composite by night' },
  DayNightCloudMicroCombo: { label: 'Day Cloud Phase / Night Microphysics', description: 'Day cloud phase / night microphysics' },
  13: { label: 'Infrared 10.3 um', description: 'Clean longwave infrared' },
  FireTemperature: { label: 'Fire Temperature RGB', description: 'Fire temperature composite' }
};

const goesState = { frames: [], frame: 0, playback: null, requestId: 0 };
const goes = {};

document.addEventListener('DOMContentLoaded', () => {
  ['product', 'play', 'refresh', 'frame', 'time', 'status', 'source', 'image', 'loading'].forEach(name => {
    goes[name] = document.getElementById(`goes-${name}`);
  });
  if (!goes.product) return;
  goes.product.addEventListener('change', loadGoesFrames);
  goes.play.addEventListener('click', togglePlayback);
  goes.refresh.addEventListener('click', loadGoesFrames);
  goes.frame.addEventListener('input', () => renderFrame(Number(goes.frame.value)));
  document.addEventListener('keydown', handleKeys, true);
  window.setInterval(loadGoesFrames, 5 * 60 * 1000);
  loadGoesFrames();
});

async function loadGoesFrames() {
  stopPlayback();
  const requestId = ++goesState.requestId;
  const product = goes.product.value;
  const url = new URL(GOES_BASE);
  url.search = new URLSearchParams({ band: product, length: '24', sat: 'G18' });
  goes.status.textContent = `Loading ${GOES_PRODUCTS[product].label} frames...`;
  goes.loading.hidden = false;
  goes.frame.disabled = true;
  goes.play.disabled = true;
  goes.source.href = url.href;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`NOAA returned ${response.status}`);
    const frames = parseFrames(await response.text());
    if (frames.length === 0) throw new Error('No imagery frames were listed by NOAA.');
    if (requestId !== goesState.requestId) return;
    goesState.frames = frames;
    goesState.frame = frames.length - 1;
    goes.frame.max = String(frames.length - 1);
    goes.frame.value = String(goesState.frame);
    goes.frame.disabled = false;
    goes.play.disabled = false;
    renderFrame(goesState.frame);
    goes.status.textContent = `${frames.length} frames loaded | ${GOES_PRODUCTS[product].description}`;
  } catch (error) {
    if (requestId !== goesState.requestId) return;
    goesState.frames = [];
    goes.status.textContent = `Unable to load GOES imagery: ${error.message}`;
    goes.loading.textContent = 'GOES imagery is temporarily unavailable.';
  }
}

function parseFrames(html) {
  const match = html.match(/animationImages\s*=\s*\[([\s\S]*?)\];/);
  if (!match) return [];
  return [...new Set([...match[1].matchAll(/['"](https:[^'"]+\.jpg)['"]/g)].map(entry => entry[1]))]
    .map(url => ({ url, time: parseFrameTime(url) }))
    .filter(frame => frame.time);
}

function parseFrameTime(url) {
  const match = url.match(/\/(\d{4})(\d{3})(\d{2})(\d{2})_GOES/);
  if (!match) return null;
  const [, year, day, hour, minute] = match.map(Number);
  return new Date(Date.UTC(year, 0, day, hour, minute));
}

function renderFrame(index) {
  const frame = goesState.frames[index];
  if (!frame) return;
  goesState.frame = index;
  goes.frame.value = String(index);
  goes.loading.hidden = false;
  goes.loading.textContent = 'Loading frame...';
  goes.image.onload = () => { goes.loading.hidden = true; };
  goes.image.onerror = () => { goes.loading.textContent = 'This frame is unavailable.'; goes.loading.hidden = false; };
  goes.image.src = frame.url;
  goes.image.alt = `${GOES_PRODUCTS[goes.product.value].label} GOES-West image valid ${formatTimes(frame.time)}`;
  goes.time.textContent = `${String(index + 1).padStart(2, '0')}/${String(goesState.frames.length).padStart(2, '0')} | ${formatTimes(frame.time)}`;
}

function togglePlayback() {
  if (goesState.playback) return stopPlayback();
  goesState.playback = window.setInterval(() => {
    renderFrame((goesState.frame + 1) % goesState.frames.length);
  }, 650);
  goes.play.textContent = 'Pause';
}

function stopPlayback() {
  if (goesState.playback) window.clearInterval(goesState.playback);
  goesState.playback = null;
  if (goes.play) goes.play.textContent = 'Play';
}

function handleKeys(event) {
  if (goesState.frames.length === 0 || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) return;
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    renderFrame((goesState.frame + direction + goesState.frames.length) % goesState.frames.length);
  }
}

function formatTimes(date) {
  const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  return [['UTC', 'UTC'], ['Mountain', 'America/Denver'], ['Pacific', 'America/Los_Angeles']]
    .map(([label, timeZone]) => `${label} ${new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(date)}`)
    .join(' | ');
}
