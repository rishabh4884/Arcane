// Runs the in-game benchmark (/?bench, see docs/PERFORMANCE.md) in Chrome on this machine's GPU, with
// Chrome's simulated webcam feeding MediaPipe, and prints the results.
//
//   npm i --no-save puppeteer-core          (once; package.json is not changed)
//   npm run dev                             (in another terminal)
//   node tools/bench-headless.mjs [label] [--query=bench=30&levels=3,10,20,30,40] [--size=1536x864]
//        [--dpr=1.25] [--mobile] [--novsync] [--url=http://localhost:5173/] [--chrome=<path>]
//
// Results are also written to bench-results/<label>.json. `--novsync` lifts the 60 fps cap (to measure
// cost rather than smoothness). Set CHROME_PATH or --chrome if Chrome is not in a usual place.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; } catch {
  console.error('puppeteer-core is not installed: run `npm i --no-save puppeteer-core` first.');
  process.exit(1);
}

const label = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'run';
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));
const chrome = args.chrome ?? process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => existsSync(p));
if (!chrome) { console.error('Chrome not found: pass --chrome=<path> or set CHROME_PATH.'); process.exit(1); }

const [width, height] = String(args.size ?? '1536x864').split('x').map(Number);
const dpr = Number(args.dpr ?? 1.25);
const query = String(args.query ?? 'bench=30&levels=3,10,20,30,40');
const url = String(args.url ?? 'http://localhost:5173/');
const flags = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-gpu-blocklist', '--enable-gpu',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${width},${height}`, '--enable-precise-memory-info'];
if (process.platform === 'win32') flags.push('--use-angle=d3d11');
if (args.novsync) flags.push('--disable-gpu-vsync', '--disable-frame-rate-limit');

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: flags, protocolTimeout: 1800000 });
const page = await browser.newPage();
await page.setViewport({ width, height, deviceScaleFactor: dpr, isMobile: Boolean(args.mobile), hasTouch: Boolean(args.mobile) });
const messages = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') messages.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => messages.push(`pageerror: ${e.message}`));
await page.goto(`${url}${url.includes('?') ? '&' : '?'}${query}`, { waitUntil: 'domcontentloaded' });

let result = null;
for (const deadline = Date.now() + 1800000; Date.now() < deadline;) {
  await new Promise((r) => setTimeout(r, 3000));
  result = await page.evaluate(() => window.__arcaneBench ?? null).catch(() => null);
  if (result && (result.status === 'done' || result.status === 'failed')) break;
}
await browser.close();
if (!result) { console.error('No result.', messages.slice(0, 10).join('\n')); process.exit(1); }

mkdirSync('bench-results', { recursive: true });
writeFileSync(`bench-results/${label}.json`, JSON.stringify({ label, args, result, messages }, null, 1));
console.log(`[${label}] ${result.status} · ${result.env.gpu} · ${result.env.viewport}@${result.env.devicePixelRatio} · tracking ${result.tracker.delegate}`);
console.log('level    fps   p50   p95   p99  >33ms   cpu  calls   tris(M)  ratio  post');
for (const r of result.levels) {
  console.log([String(r.level).padStart(5), String(r.fps).padStart(6), String(r.p50).padStart(5), String(r.p95).padStart(5), String(r.p99).padStart(5),
    `${r.over33}%`.padStart(6), String(r.cpu).padStart(5), String(Math.round(r.calls)).padStart(6), (r.triangles / 1e6).toFixed(2).padStart(9), String(r.pixelRatio).padStart(6), r.post ? '   on' : '  off'].join(' '));
}
if (messages.length) console.log(`${messages.length} console messages (see the JSON).`);
