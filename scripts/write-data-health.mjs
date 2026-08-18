import { mkdir, readFile, writeFile } from 'node:fs/promises';

const sources = {
  satellite: 'assets/live/firms.json',
  incidents: 'assets/live/incidents.json',
  evacuations: 'assets/live/evacuations.json',
  air: 'assets/live/airnow-pm25.json',
  smoke: 'assets/live/hrrr-smoke/manifest.json',
  uvi: 'assets/live/uvi/manifest.json'
};

async function sourceHealth(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return {
      timestamp: data.run || data.generatedAt || data.observedAt || null,
      stale: Boolean(data.stale),
      available: true
    };
  } catch {
    return { timestamp: null, stale: true, available: false };
  }
}

const entries = await Promise.all(Object.entries(sources).map(async ([name, file]) => [name, await sourceHealth(file)]));
const payload = {
  generatedAt: new Date().toISOString(),
  workflowRun: process.env.GITHUB_RUN_ID || null,
  sources: Object.fromEntries(entries)
};

await mkdir('assets/live', { recursive: true });
await writeFile('assets/live/data-health.json', JSON.stringify(payload));
