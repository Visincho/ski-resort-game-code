// Snowline server: static client files, caching map-data proxies and the persistent universe API.
// Zero dependencies - Node built-ins only.  Start with `npm start` (PORT, DAY_MINUTES env vars).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, fail, sendJson, sendText, readJson, RateLimiter } from './lib.js';
import { createTileProxy, createOsmProxy, createGeocodeProxy } from './proxies.js';
import { Store } from './store.js';
import { createApi } from './api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(ROOT, 'cache'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// ---- static files ----------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};
const NO_CACHE_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map']);

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request path');
  }
  if (rel.includes('\0')) return sendText(res, 400, 'Bad request path');
  // Refuse dot-segments and hidden files outright; then make sure the resolved path stays in public/.
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return sendText(res, 404, 'Not found');
  let file = path.join(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 404, 'Not found');

  let st;
  try {
    st = await fsp.stat(file);
    if (st.isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { Location: pathname + '/' });
        return res.end();
      }
      file = path.join(file, 'index.html');
      st = await fsp.stat(file);
    }
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (!st.isFile()) return sendText(res, 404, 'Not found');

  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': NO_CACHE_EXT.has(ext) ? 'no-cache' : 'public, max-age=3600',
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---- API routing -----------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function compileRoutes(routes) {
  return routes.map((r) => {
    const keys = [];
    const pattern = r.path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    return { ...r, keys, re: new RegExp(`^${pattern}$`) };
  });
}

function matchRoute(routes, method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = {};
    r.keys.forEach((k, i) => {
      try { params[k] = decodeURIComponent(m[i + 1]); } catch { fail(400, 'Bad URL encoding'); }
    });
    return { route: r, params };
  }
  if (pathMatched) fail(405, 'Method not allowed');
  fail(404, 'Unknown API endpoint');
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---- bootstrap -------------------------------------------------------------------------------

const store = new Store(DATA_DIR);
store.load();
await store.seedFamousResorts(path.join(PUBLIC_DIR, 'js', 'shared', 'resorts.js'));

const api = createApi(store);
const routes = compileRoutes(api.routes);
const handleTile = createTileProxy(CACHE_DIR);
const handleOsm = createOsmProxy(CACHE_DIR);
const geocode = createGeocodeProxy(CACHE_DIR);
const apiLimiter = new RateLimiter(900, 60000); // generous per-IP safety net for all /api calls

async function handleApi(req, res, url) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const ip = clientIp(req);
  try {
    if (!apiLimiter.allow(ip)) fail(429, 'Too many requests, slow down');
    const pathname = url.pathname.length > 5 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    if (pathname === '/api/osm' || pathname === '/api/geocode') {
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed');
      return pathname === '/api/osm'
        ? await handleOsm(req, res, url.searchParams)
        : await geocode.handleGeocode(req, res, url.searchParams);
    }

    const { route, params } = matchRoute(routes, req.method, pathname);
    const auth = api.authenticate(req);
    if (route.auth === 'required' && !auth) fail(401, 'Not logged in (missing or expired token)');
    const body = route.body ? await readJson(req, route.body) : {};
    const result = await route.handler({
      req, params, body, ip,
      query: url.searchParams,
      player: auth?.player || null,
      token: auth?.token || null,
    });
    sendJson(res, 200, result);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[api] ${req.method} ${url.pathname} failed:`, err);
    if (res.headersSent) return res.destroy();
    sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
  }
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url.startsWith('/') ? `http://localhost${req.url}` : req.url);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  const { pathname } = url;
  if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(req, res, url);

  if (pathname.startsWith('/tiles/')) {
    const m = /^\/tiles\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/.exec(pathname);
    if (!m) return sendText(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    return handleTile(req, res, m[1], m[2], m[3]);
  }
  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`[server] ${req.method} ${req.url} crashed:`, err);
    if (!res.headersSent) sendText(res, 500, 'Internal server error');
    else res.destroy();
  });
});

// ---- timers & shutdown -----------------------------------------------------------------------

const safely = (fn) => () => { try { fn(); } catch (err) { console.error('[timer]', err); } };
const timers = [
  setInterval(safely(() => api.resolveCompetitions()), 30000),
  setInterval(safely(() => { api.sweepLimiters(); apiLimiter.sweep(); }), 60000),
  setInterval(safely(() => store.purgeSessions()), 3600000),
];
safely(() => api.resolveCompetitions())();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) process.exit(1); // second Ctrl+C: exit immediately
  shuttingDown = true;
  console.log(`\n[server] ${signal} received - saving universe...`);
  timers.forEach(clearInterval);
  server.close();
  geocode.flushSync();
  try {
    await store.shutdown();
    console.log('[server] saved, bye.');
  } catch (err) {
    console.error('[server] final save failed:', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => console.error('[server] uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));

server.on('error', (err) => {
  console.error(`[server] cannot listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const info = store.db.info;
  console.log(`Snowline server running at http://localhost:${PORT}/  (listening on ${HOST}:${PORT})`);
  console.log(`  universe "${info.name}", ${info.dayRealMinutes} real min per game day, data in ${DATA_DIR}, cache in ${CACHE_DIR}`);
});
