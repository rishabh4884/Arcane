// Serves the production build (dist/) and saves benchmark results that devices post back, so a
// phone or another computer can run /?bench or /?bench&diagnose and the numbers land here.
//
//   npm run build
//   node tools/bench-serve.mjs [--port=4173]
//
// Results are written to bench-results/<id>.json (one file per run, updated as it goes) and a one-line
// summary is printed. Put a tunnel (ngrok, cloudflared) in front of it for devices off this network:
// cameras need https. Only dist/ is served; nothing else on this machine is reachable through it.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));
const port = Number(args.port ?? 4173);
const root = resolve('dist');
const out = resolve('bench-results');
if (!existsSync(join(root, 'index.html'))) { console.error('No dist/index.html: run `npm run build` first.'); process.exit(1); }
mkdirSync(out, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.ktx2': 'image/ktx2', '.bin': 'application/octet-stream',
  '.task': 'application/octet-stream', '.tflite': 'application/octet-stream', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY = 4 * 1024 * 1024;
let saved = 0;

function summary(run) {
  const env = run.env ?? {};
  const head = `[${run.kind ?? 'bench'} ${run.id}] ${run.status} · ${env.gpu ?? '?'} · ${env.viewport ?? '?'}@${env.devicePixelRatio ?? '?'} · ${String(env.userAgent ?? '').replace(/^Mozilla\/5\.0 /, '').slice(0, 90)}`;
  const rows = run.kind === 'draws'
    ? (run.draws ?? []).slice(0, 30).map((d) => `  ${String(d.ms).padStart(7)} ms ${String(d.draws).padStart(6)} draws ${String(d.tris).padStart(9)} tris  ${d.label}`)
    : run.kind === 'diagnose'
    ? (run.phases ?? []).map((p) => `  ${String(p.phase).padEnd(14)} ${String(p.fps).padStart(6)} fps  p95 ${String(p.p95).padStart(5)}  >20ms ${String(p.over20).padStart(5)}%  cpu ${p.cpu}  track ${p.inferenceMs} ms  gpu ${p.gpuMs || '–'}${p.passes ? ' ' + JSON.stringify(p.passes) : ''}`)
    : (run.levels ?? []).map((l) => `  level ${String(l.level).padStart(2)} ${String(l.fps).padStart(6)} fps  p95 ${l.p95}  >20ms ${l.over20}%  cpu ${l.cpu}  track ${l.inference} ms/${l.tracking} Hz  ratio ${l.pixelRatio}  post ${l.post ? 'on' : 'off'}`);
  return [head, ...rows].join('\n');
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  if (url.pathname === '/__bench') {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try {
        const run = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const id = String(run.id ?? Date.now()).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || String(Date.now());
        if (saved++ > 2000) throw new Error('too many results');
        writeFileSync(join(out, `${run.kind ?? 'bench'}-${id}.json`), JSON.stringify(run, null, 1));
        if (run.status === 'done' || run.status === 'failed') console.log(summary(run));
        else console.log(`[${run.kind ?? 'bench'} ${id}] ${run.status}: ${(run.phases?.length ?? 0) || (run.levels?.length ?? 0)} done`);
        res.writeHead(204).end();
      } catch (error) {
        res.writeHead(400).end(String(error));
      }
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let path;
  try { path = normalize(join(root, decodeURIComponent(url.pathname))); } catch { res.writeHead(400).end(); return; }
  if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  if (!existsSync(path) || statSync(path).isDirectory()) path = existsSync(join(path, 'index.html')) ? join(path, 'index.html') : join(root, 'index.html');
  const stat = statSync(path);
  res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', 'content-length': stat.size, 'cache-control': path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(path).pipe(res);
}).listen(port, () => console.log(`Serving dist/ on http://localhost:${port} · results go to bench-results/`));
