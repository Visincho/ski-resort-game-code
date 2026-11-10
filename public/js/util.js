// Small shared helpers: math, randomness, geo projection, formatting, events.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
export const dist = (ax, az, bx, bz) => Math.sqrt(dist2(ax, az, bx, bz));

// Deterministic hashing / PRNG (mulberry32) so the universe weather is identical for every client.
export function hash32(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= 0x9e3779b9; h = Math.imul(h ^ (h >>> 15), 2246822507);
  }
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// Local tangent-plane projection around the map centre: x = east (m), z = south (m).
export class GeoProjection {
  constructor(lat0, lon0) {
    this.lat0 = lat0; this.lon0 = lon0;
    this.mx = 111320 * Math.cos(lat0 * Math.PI / 180);
    this.mz = 110574;
  }
  toXZ(lat, lon) { return [(lon - this.lon0) * this.mx, -(lat - this.lat0) * this.mz]; }
  toLatLon(x, z) { return [this.lat0 - z / this.mz, this.lon0 + x / this.mx]; }
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Formatting
export function money(v, digits) {
  const s = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${s}€${(a / 1e9).toFixed(digits ?? 2)}B`;
  if (a >= 1e6) return `${s}€${(a / 1e6).toFixed(digits ?? (a >= 1e8 ? 0 : 1))}M`;
  if (a >= 1e4) return `${s}€${(a / 1e3).toFixed(digits ?? 0)}k`;
  return `${s}€${Math.round(a).toLocaleString('en-US')}`;
}
export const int = v => Math.round(v).toLocaleString('en-US');
export const pct = v => `${Math.round(v * 100)}%`;
export function km(m) { return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`; }
export function hhmm(minute) {
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this._h[ev] = (this._h[ev] || []).filter(f => f !== fn); }
  emit(ev, ...args) { for (const fn of this._h[ev] || []) { try { fn(...args); } catch (e) { console.error(e); } } }
}

let _uid = 1;
export function uid(prefix = 'e') { return `${prefix}${Date.now().toString(36)}${(_uid++).toString(36)}`; }
export function setUidCounter(n) { _uid = Math.max(_uid, n); }

// Polyline helpers on [x, z] point arrays
export function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return L;
}
// Closest point on polyline -> {d, s (arc length), i (segment index), x, z}
export function closestOnPoly(pts, x, z) {
  let best = { d: Infinity, s: 0, i: 0, x: pts[0][0], z: pts[0][1] };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz;
    const L = Math.sqrt(L2);
    let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    t = clamp(t, 0, 1);
    const px = ax + dx * t, pz = az + dz * t;
    const d = dist(px, pz, x, z);
    if (d < best.d) best = { d, s: acc + L * t, i: i - 1, x: px, z: pz };
    acc += L;
  }
  return best;
}
// Sub-polyline between arc lengths s0 < s1
export function subPoly(pts, s0, s1) {
  const out = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
    const L = dist(ax, az, bx, bz);
    const a = acc, b = acc + L;
    if (b >= s0 && a <= s1 && L > 0) {
      const t0 = clamp((s0 - a) / L, 0, 1), t1 = clamp((s1 - a) / L, 0, 1);
      const p0 = [ax + (bx - ax) * t0, az + (bz - az) * t0];
      const p1 = [ax + (bx - ax) * t1, az + (bz - az) * t1];
      if (!out.length) out.push(p0);
      else { const l = out[out.length - 1]; if (dist(l[0], l[1], p0[0], p0[1]) > 0.01) out.push(p0); }
      out.push(p1);
    }
    acc = b;
  }
  if (out.length === 1) out.push([out[0][0] + 0.01, out[0][1]]);
  return out;
}
// Resample polyline to points every `step` metres (keeps ends)
export function resample(pts, step) {
  const L = polyLength(pts);
  const n = Math.max(1, Math.ceil(L / step));
  const out = [];
  for (let k = 0; k <= n; k++) out.push(pointAt(pts, (L * k) / n));
  return out;
}
export function pointAt(pts, s) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], az = pts[i - 1][1], bx = pts[i][0], bz = pts[i][1];
    const L = dist(ax, az, bx, bz);
    if (acc + L >= s && L > 0) { const t = (s - acc) / L; return [ax + (bx - ax) * t, az + (bz - az) * t]; }
    acc += L;
  }
  const l = pts[pts.length - 1];
  return [l[0], l[1]];
}
// Douglas-Peucker simplification
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = closestOnPoly([pts[a], pts[b]], pts[i][0], pts[i][1]).d;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
