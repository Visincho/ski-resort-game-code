// Caching proxies for third-party map data: Terrarium elevation tiles (AWS),
// OpenStreetMap features (Overpass API) and place search (Nominatim).
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  USER_AGENT, HttpError, fail, sendJson, sendBuffer, sendText, Limiter, dedupe, sleep,
  atomicWrite, atomicWriteSync, readJsonFileSync, round6,
} from './lib.js';

// ---------------------------------------------------------------------------------------------
// Elevation tiles
// ---------------------------------------------------------------------------------------------

const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const TILE_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=31536000',
  'Access-Control-Allow-Origin': '*',
};

export function createTileProxy(cacheDir) {
  const limiter = new Limiter(6);
  const inflight = new Map();
  const tileFile = (z, x, y) => path.join(cacheDir, 'tiles', String(z), String(x), `${y}.png`);

  async function fetchTile(z, x, y) {
    const file = tileFile(z, x, y);
    // Another request may have filled the cache while this one was queued.
    try { return await fsp.readFile(file); } catch { /* not cached yet */ }
    const res = await fetch(TILE_URL(z, x, y), {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8 || !buf.subarray(0, 4).equals(PNG_MAGIC)) throw new Error('upstream returned a non-PNG body');
    await atomicWrite(file, buf);
    return buf;
  }

  return async function handleTile(req, res, zs, xs, ys) {
    const z = Number(zs), x = Number(xs), y = Number(ys);
    const max = 2 ** z;
    if (!(z >= 0 && z <= 15) || !(x >= 0 && x < max) || !(y >= 0 && y < max)) {
      return sendText(res, 400, 'Tile coordinates out of range');
    }
    const headOnly = req.method === 'HEAD';
    let buf;
    try {
      buf = await fsp.readFile(tileFile(z, x, y));
    } catch {
      try {
        buf = await dedupe(inflight, `${z}/${x}/${y}`, () => limiter.run(() => fetchTile(z, x, y)));
      } catch (err) {
        console.warn(`[tiles] ${z}/${x}/${y} failed: ${err.message}`);
        return sendText(res, 502, 'Upstream tile fetch failed', { 'Access-Control-Allow-Origin': '*' });
      }
    }
    sendBuffer(res, 200, buf, TILE_HEADERS, headOnly);
  };
}

// ---------------------------------------------------------------------------------------------
// OpenStreetMap via Overpass
// ---------------------------------------------------------------------------------------------

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const SKIP_AERIALWAY = new Set(['goods', 'station', 'zip_line', 'pylon']);
const HUT_AMENITIES = new Set(['restaurant', 'cafe', 'bar', 'fast_food', 'pub']);
const PLACE_KINDS = new Set(['town', 'village', 'hamlet', 'city']);
const MAX_BUILDINGS = 12000;
const MAX_RELATION_MEMBERS = 400;
const MAX_RELATION_POINTS = 40000;

function mainQuery(b) {
  const bb = `(${b.s},${b.w},${b.n},${b.e})`;
  return `[out:json][timeout:120];
(
  way["aerialway"]${bb};
  way["piste:type"="downhill"]${bb};
  relation["piste:type"="downhill"]${bb};
  node["tourism"="alpine_hut"]${bb};
  way["tourism"="alpine_hut"]${bb};
  node["amenity"~"^(restaurant|cafe|bar|fast_food|pub)$"]${bb};
  node["place"~"^(town|village|hamlet|city)$"]${bb};
  way["amenity"="parking"]${bb};
);
out geom;`;
}

function buildingsQuery(b) {
  return `[out:json][timeout:120];way["building"](${b.s},${b.w},${b.n},${b.e});out ids center ${MAX_BUILDINGS};`;
}

const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

async function overpassOnce(url, query) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(150000), // the query itself has [timeout:120]
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.transient = TRANSIENT_STATUS.has(res.status);
    throw err;
  }
  const json = await res.json();
  if (typeof json.remark === 'string' && /error|timed out|out of memory/i.test(json.remark)) {
    throw new Error(`remark: ${json.remark.slice(0, 200)}`);
  }
  if (!Array.isArray(json.elements)) throw new Error('response has no elements array');
  return json;
}

/** Run a query on the primary Overpass server (one retry on overload errors), then the fallback. */
async function overpass(query) {
  const errors = [];
  for (const [i, url] of OVERPASS_URLS.entries()) {
    const host = new URL(url).host;
    for (let attempt = 0; attempt < (i === 0 ? 2 : 1); attempt++) {
      try {
        return await overpassOnce(url, query);
      } catch (err) {
        errors.push(`${host}: ${err.message}`);
        console.warn(`[osm] ${host} failed: ${err.message}`);
        if (!err.transient) break;
        await sleep(5000);
      }
    }
  }
  throw new Error(`All Overpass servers failed (${errors.join('; ')})`);
}

const toPts = (geometry) =>
  (Array.isArray(geometry) ? geometry : [])
    .filter((g) => g && Number.isFinite(g.lat) && Number.isFinite(g.lon))
    .map((g) => [round6(g.lat), round6(g.lon)]);

function isClosed(pts) {
  return pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
}

/** Isoperimetric quotient 4*pi*A/P^2 (1 = circle, ~0 = thin loop) of a closed ring. */
function compactness(pts) {
  const lat0 = (pts[0][0] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0), ky = 110540;
  let area = 0, perim = 0;
  for (let i = 1; i < pts.length; i++) {
    const x1 = pts[i - 1][1] * kx, y1 = pts[i - 1][0] * ky;
    const x2 = pts[i][1] * kx, y2 = pts[i][0] * ky;
    area += x1 * y2 - x2 * y1;
    perim += Math.hypot(x2 - x1, y2 - y1);
  }
  return perim > 0 ? (4 * Math.PI * Math.abs(area / 2)) / (perim * perim) : 0;
}

/** A downhill piste is an area if it is a closed ring tagged area=yes, or a compact (non-thin) ring. */
function isPisteArea(pts, tags, multipolygon = false) {
  if (!isClosed(pts) || tags.area === 'no') return false;
  if (tags.area === 'yes' || multipolygon) return true;
  return compactness(pts) > 0.1;
}

function centroid(pts) {
  const ring = isClosed(pts) ? pts.slice(0, -1) : pts;
  let lat = 0, lon = 0;
  for (const p of ring) { lat += p[0]; lon += p[1]; }
  return { lat: round6(lat / ring.length), lon: round6(lon / ring.length) };
}

function parsePopulation(v) {
  if (v == null) return 0;
  const n = Number(String(v).split(';')[0].replace(/[\s,.'_]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Convert raw Overpass output into the compact client format. */
export function convertOsm(bbox, main, buildings) {
  const out = {
    bbox: [bbox.s, bbox.w, bbox.n, bbox.e],
    fetchedAt: Date.now(),
    lifts: [], pistes: [], huts: [], places: [], parkings: [], buildings: [],
  };
  const pisteById = new Map();
  const relations = [];

  for (const el of main.elements) {
    const t = el.tags || {};
    if (el.type === 'way') {
      const pts = toPts(el.geometry);
      if (!pts.length) continue;
      if (t.aerialway && !SKIP_AERIALWAY.has(t.aerialway) && pts.length >= 2) {
        out.lifts.push({ id: el.id, name: t.name || '', type: t.aerialway, tags: t, pts });
      }
      if (t['piste:type'] === 'downhill' && pts.length >= 2) {
        const piste = {
          id: el.id,
          name: t['piste:name'] || t.name || '',
          difficulty: t['piste:difficulty'] || '',
          area: isPisteArea(pts, t),
          tags: t,
          pts,
        };
        out.pistes.push(piste);
        pisteById.set(el.id, piste);
      }
      if (t.tourism === 'alpine_hut') out.huts.push({ id: el.id, name: t.name || '', kind: 'alpine_hut', ...centroid(pts) });
      if (t.amenity === 'parking') {
        const p = centroid(pts);
        const cap = parseInt(t.capacity, 10);
        out.parkings.push(Number.isFinite(cap) && cap > 0 ? { ...p, capacity: cap } : p);
      }
    } else if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
      const lat = round6(el.lat), lon = round6(el.lon);
      if (t.tourism === 'alpine_hut') out.huts.push({ id: el.id, name: t.name || '', kind: 'alpine_hut', lat, lon });
      else if (HUT_AMENITIES.has(t.amenity)) out.huts.push({ id: el.id, name: t.name || '', kind: t.amenity, lat, lon });
      if (PLACE_KINDS.has(t.place) && t.name) {
        out.places.push({ name: t.name, kind: t.place, lat, lon, population: parsePopulation(t.population) });
      }
    } else if (el.type === 'relation' && t['piste:type'] === 'downhill') {
      relations.push(el);
    }
  }

  // Piste relations: flatten member ways into individual pistes carrying the relation's name/difficulty.
  for (const rel of relations) {
    const t = rel.tags || {};
    const name = t['piste:name'] || t.name || '';
    const difficulty = t['piste:difficulty'] || '';
    const multipolygon = t.type === 'multipolygon';
    const members = (rel.members || []).filter((m) => m.type === 'way' && Array.isArray(m.geometry) && m.role !== 'inner');
    const totalPts = members.reduce((n, m) => n + m.geometry.length, 0);
    if (members.length > MAX_RELATION_MEMBERS || totalPts > MAX_RELATION_POINTS) continue;
    for (const m of members) {
      const existing = pisteById.get(m.ref);
      if (existing) {
        // Member is already a piste in its own right: just fill in missing info from the route.
        if (!existing.name) existing.name = name;
        if (!existing.difficulty) existing.difficulty = difficulty;
        continue;
      }
      const pts = toPts(m.geometry);
      if (pts.length < 2) continue;
      const piste = { id: m.ref, name, difficulty, area: isPisteArea(pts, t, multipolygon), tags: t, pts, relation: rel.id };
      out.pistes.push(piste);
      pisteById.set(m.ref, piste);
    }
  }

  if (buildings) {
    for (const el of buildings.elements) {
      if (out.buildings.length >= MAX_BUILDINGS) break;
      const c = el.center;
      if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) out.buildings.push([round6(c.lat), round6(c.lon)]);
    }
  }
  return out;
}

function parseBbox(query) {
  const b = {};
  for (const k of ['s', 'w', 'n', 'e']) {
    const raw = query.get(k);
    const v = raw === null || raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(v)) fail(400, `Parameter "${k}" must be a number`);
    b[k] = Math.round(v * 1e4) / 1e4;
  }
  if (b.s < -90 || b.n > 90 || b.w < -180 || b.e > 180) fail(400, 'Bounding box out of range');
  if (!(b.n > b.s) || !(b.e > b.w)) fail(400, 'Bounding box must satisfy s < n and w < e');
  if (b.n - b.s > 0.5 || b.e - b.w > 0.7) fail(400, 'Bounding box too large (max 0.5 deg lat x 0.7 deg lon)');
  return b;
}

export function createOsmProxy(cacheDir) {
  const queue = new Limiter(1); // Overpass is shared infrastructure: one query at a time.
  const inflight = new Map();
  const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };

  // Main-query results kept briefly when the buildings query failed, so a retry only redoes buildings.
  const partialMain = new Map();

  async function build(b, file, key) {
    try { return await fsp.readFile(file); } catch { /* not cached */ }
    const t0 = Date.now();
    const kept = partialMain.get(key);
    const main = kept && Date.now() - kept.time < 30 * 60000 ? kept.main : await overpass(mainQuery(b));
    partialMain.delete(key);
    let buildings = null;
    try {
      buildings = await overpass(buildingsQuery(b));
    } catch (err) {
      console.warn(`[osm] ${key}: building query failed, returning partial data (not cached): ${err.message}`);
      partialMain.set(key, { main, time: Date.now() });
      for (const [k, v] of partialMain) if (Date.now() - v.time > 30 * 60000) partialMain.delete(k);
    }
    const data = convertOsm(b, main, buildings);
    if (!buildings) data.partial = true;
    const buf = Buffer.from(JSON.stringify(data));
    if (buildings) await atomicWrite(file, buf);
    console.log(`[osm] ${key}: ${data.lifts.length} lifts, ${data.pistes.length} pistes, ${data.huts.length} huts, ` +
      `${data.places.length} places, ${data.buildings.length} buildings (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    return buf;
  }

  return async function handleOsm(req, res, query) {
    const b = parseBbox(query);
    const key = [b.s, b.w, b.n, b.e].map((v) => v.toFixed(4)).join('_');
    const file = path.join(cacheDir, 'osm', `${key}.json`);
    let buf;
    try {
      buf = await fsp.readFile(file);
    } catch {
      try {
        buf = await dedupe(inflight, key, () => queue.run(() => build(b, file, key)));
      } catch (err) {
        return sendJson(res, 502, { error: err.message }, { 'Access-Control-Allow-Origin': '*' });
      }
    }
    sendBuffer(res, 200, buf, JSON_HEADERS, req.method === 'HEAD');
  };
}

// ---------------------------------------------------------------------------------------------
// Geocoding via Nominatim
// ---------------------------------------------------------------------------------------------

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const GEOCODE_CACHE_MAX = 5000;

/** Nominatim's boundingbox is [south, north, west, east] (strings); return [s, w, n, e] like /api/osm. */
function toSwne(bb) {
  if (!Array.isArray(bb) || bb.length !== 4) return null;
  const [s, n, w, e] = bb.map(Number);
  return [s, w, n, e].every(Number.isFinite) ? [s, w, n, e] : null;
}

export function createGeocodeProxy(cacheDir) {
  const file = path.join(cacheDir, 'geocode.json');
  const cache = new Map(Object.entries(readJsonFileSync(file, {})));
  const inflight = new Map();
  const queue = new Limiter(1);
  let lastRequest = 0;
  let saveTimer = null;

  function persistSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      atomicWrite(file, JSON.stringify(Object.fromEntries(cache))).catch((err) => console.warn(`[geocode] save failed: ${err.message}`));
    }, 5000);
  }

  function flushSync() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    try { atomicWriteSync(file, JSON.stringify(Object.fromEntries(cache))); } catch (err) { console.warn(`[geocode] save failed: ${err.message}`); }
  }

  async function lookup(q) {
    // Nominatim usage policy: max 1 request per second.
    const wait = lastRequest + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const url = `${NOMINATIM_URL}?format=jsonv2&limit=8&addressdetails=1&accept-language=en&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
      const raw = await res.json();
      if (!Array.isArray(raw)) throw new Error('Unexpected Nominatim response');
      return raw
        .map((r) => ({
          name: String(r.display_name || r.name || '').slice(0, 120),
          lat: Number(r.lat),
          lon: Number(r.lon),
          type: r.type || r.addresstype || '',
          country: r.address?.country || '',
          countryCode: (r.address?.country_code || '').toUpperCase(),
          bbox: toSwne(r.boundingbox),
        }))
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    } finally {
      lastRequest = Date.now();
    }
  }

  async function handleGeocode(req, res, query) {
    const q = (query.get('q') || '').replace(/\s+/g, ' ').trim();
    if (q.length < 2 || q.length > 200) fail(400, 'Query "q" must be 2-200 characters');
    const key = q.toLowerCase();
    let results = cache.get(key);
    if (!results) {
      try {
        results = await dedupe(inflight, key, () => queue.run(() => lookup(q)));
      } catch (err) {
        console.warn(`[geocode] "${q}" failed: ${err.message}`);
        throw new HttpError(502, `Geocoding failed: ${err.message}`);
      }
      cache.set(key, results);
      while (cache.size > GEOCODE_CACHE_MAX) cache.delete(cache.keys().next().value);
      persistSoon();
    }
    sendJson(res, 200, results);
  }

  return { handleGeocode, flushSync };
}
