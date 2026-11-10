// Real-world terrain: fetches Terrarium-encoded elevation tiles (AWS open terrain tiles, via the local
// caching proxy when available), stitches them and resamples them onto a metric grid around the resort.

import { GeoProjection, clamp, mulberry32, hash32 } from './util.js';

const TILE_REMOTE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

function lonToTileX(lon, z) { return ((lon + 180) / 360) * 2 ** z; }
function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

async function loadTileImage(z, x, y) {
  const urls = [`tiles/${z}/${x}/${y}.png`, `${TILE_REMOTE}/${z}/${x}/${y}.png`];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!blob.type.includes('png') && blob.size < 100) throw new Error('not a png');
      return await createImageBitmap(blob);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('tile failed');
}

export class Terrain {
  // def: {lat, lon, w, h} (km)
  constructor(def) {
    this.def = def;
    this.proj = new GeoProjection(def.lat, def.lon);
    this.width = def.w * 1000;
    this.depth = def.h * 1000;
    this.cell = Math.max(16, Math.round((Math.max(this.width, this.depth) / 900) * 10) / 10);
    this.nx = Math.round(this.width / this.cell) + 1;
    this.nz = Math.round(this.depth / this.cell) + 1;
    this.x0 = -this.width / 2;
    this.z0 = -this.depth / 2;
    this.h = new Float32Array(this.nx * this.nz);
    this.minH = 0; this.maxH = 0;
    this.synthetic = false;
  }

  async load(onProgress) {
    const { lat, lon } = this.def;
    const [latN] = this.proj.toLatLon(0, this.z0);
    const [latS] = this.proj.toLatLon(0, -this.z0);
    const [, lonW] = this.proj.toLatLon(this.x0, 0);
    const [, lonE] = this.proj.toLatLon(-this.x0, 0);
    this.bbox = { s: latS, n: latN, w: lonW, e: lonE };
    // choose zoom so that tile count stays reasonable
    let z = 13;
    const count = zz => (Math.floor(lonToTileX(lonE, zz)) - Math.floor(lonToTileX(lonW, zz)) + 1) *
      (Math.floor(latToTileY(latS, zz)) - Math.floor(latToTileY(latN, zz)) + 1);
    while (z > 10 && count(z) > 42) z--;
    const tx0 = Math.floor(lonToTileX(lonW, z)), tx1 = Math.floor(lonToTileX(lonE, z));
    const ty0 = Math.floor(latToTileY(latN, z)), ty1 = Math.floor(latToTileY(latS, z));
    const tw = tx1 - tx0 + 1, th = ty1 - ty0 + 1;
    const canvas = new OffscreenCanvas(tw * 256, th * 256);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let done = 0;
    const total = tw * th;
    const jobs = [];
    let failed = 0;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(loadTileImage(z, tx, ty).then(img => {
        ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256);
      }).catch(() => { failed++; }).finally(() => { done++; onProgress && onProgress(done / total); }));
    }
    await Promise.all(jobs);
    if (failed > total * 0.25) {
      console.warn('Elevation tiles unavailable, using synthetic terrain');
      this.makeSynthetic();
      return this;
    }
    const img = ctx.getImageData(0, 0, tw * 256, th * 256).data;
    const W = tw * 256, H = th * 256;
    const elev = new Float32Array(W * H);
    for (let i = 0, p = 0; i < elev.length; i++, p += 4) {
      elev[i] = img[p + 3] ? img[p] * 256 + img[p + 1] + img[p + 2] / 256 - 32768 : NaN; // transparent = tile failed
    }
    const sample = (px, py) => {
      px = clamp(px, 0, W - 1.001); py = clamp(py, 0, H - 1.001);
      const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
      const i = iy * W + ix;
      return (elev[i] * (1 - fx) + elev[i + 1] * fx) * (1 - fy) + (elev[i + W] * (1 - fx) + elev[i + W + 1] * fx) * fy;
    };
    let mn = Infinity, mx = -Infinity;
    const holes = [];
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const [la, lo] = this.proj.toLatLon(this.x0 + i * this.cell, this.z0 + j * this.cell);
        const px = (lonToTileX(lo, z) - tx0) * 256, py = (latToTileY(la, z) - ty0) * 256;
        const v = sample(px, py);
        const k = j * this.nx + i;
        if (!(v > -500 && v < 9000)) { holes.push(k); this.h[k] = NaN; continue; }
        this.h[k] = v;
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
    }
    if (mn > mx) { this.h.fill(0); mn = mx = 0; } else if (holes.length) this._fillHoles(holes);
    this.minH = mn; this.maxH = mx;
    this.zoom = z;
    this.smooth(1);
    return this;
  }

  // cells under missing tiles: grow the surrounding terrain inwards instead of leaving sea-level pits
  _fillHoles(cells) {
    const { nx, nz, h } = this;
    const add = (n, acc) => { const v = h[n]; if (v === v) { acc[0] += v; acc[1]++; } }; // v === v: not NaN
    const acc = [0, 0];
    const vals = new Float32Array(cells.length);
    while (cells.length) {
      for (let n = 0; n < cells.length; n++) {
        const k = cells[n], i = k % nx, j = (k - i) / nx;
        acc[0] = 0; acc[1] = 0;
        if (i > 0) add(k - 1, acc);
        if (i < nx - 1) add(k + 1, acc);
        if (j > 0) add(k - nx, acc);
        if (j < nz - 1) add(k + nx, acc);
        vals[n] = acc[1] ? acc[0] / acc[1] : NaN;
      }
      const rest = [];
      for (let n = 0; n < cells.length; n++) if (vals[n] === vals[n]) h[cells[n]] = vals[n]; else rest.push(cells[n]);
      if (rest.length === cells.length) { for (const k of rest) h[k] = 0; break; }
      cells = rest;
    }
  }

  // light smoothing removes tile-quantisation stair steps
  smooth(passes) {
    const { nx, nz } = this;
    const tmp = new Float32Array(this.h.length);
    for (let p = 0; p < passes; p++) {
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const w = di === 0 && dj === 0 ? 4 : (di === 0 || dj === 0 ? 2 : 1);
          s += this.h[jj * nx + ii] * w; c += w;
        }
        tmp[j * nx + i] = s / c;
      }
      this.h.set(tmp);
    }
  }

  makeSynthetic() {
    this.synthetic = true;
    const rng = mulberry32(hash32(this.def.lat, this.def.lon));
    const waves = [];
    for (let k = 0; k < 24; k++) waves.push({ a: rng() * Math.PI * 2, f: 0.0002 + rng() * 0.0012 * (1 + k / 6), p: rng() * 10, amp: 600 / (1 + k * 0.6) });
    let mn = Infinity, mx = -Infinity;
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      const x = this.x0 + i * this.cell, z = this.z0 + j * this.cell;
      let v = 1400;
      for (const w of waves) v += Math.abs(Math.sin((x * Math.cos(w.a) + z * Math.sin(w.a)) * w.f + w.p)) * w.amp;
      const valley = Math.exp(-((x * 0.0003) ** 2)) * 900;
      v -= valley;
      this.h[j * this.nx + i] = v;
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    this.minH = mn; this.maxH = mx;
  }

  inBounds(x, z, margin = 0) {
    return x >= this.x0 + margin && x <= -this.x0 - margin && z >= this.z0 + margin && z <= -this.z0 - margin;
  }

  heightAt(x, z) {
    const fx = clamp((x - this.x0) / this.cell, 0, this.nx - 1.001);
    const fz = clamp((z - this.z0) / this.cell, 0, this.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * this.nx + i, h = this.h;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - tz) + (h[k + this.nx] * (1 - tx) + h[k + this.nx + 1] * tx) * tz;
  }

  // Height of the rendered (coarser) terrain mesh, matching its triangle split exactly.
  meshHeightAt(x, z) {
    const st = this.meshStep || 1;
    const nxm = Math.floor((this.nx - 1) / st), nzm = Math.floor((this.nz - 1) / st);
    const fx = clamp((x - this.x0) / (this.cell * st), 0, nxm - 0.0001);
    const fz = clamp((z - this.z0) / (this.cell * st), 0, nzm - 0.0001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const H = (ii, jj) => this.h[(jj * st) * this.nx + ii * st];
    const a = H(i, j), b = H(i + 1, j), c = H(i, j + 1), d = H(i + 1, j + 1);
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }
  // visible ground: never below the mesh, never below the real terrain
  surfaceAt(x, z) { return Math.max(this.heightAt(x, z), this.meshHeightAt(x, z)); }

  // gradient (rise over run, dimensionless) and downhill direction
  gradientAt(x, z) {
    const e = this.cell;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return { dx, dz, g: Math.sqrt(dx * dx + dz * dz) };
  }
  slopeDeg(x, z) { return Math.atan(this.gradientAt(x, z).g) * 180 / Math.PI; }
  // +1 = faces south (sunny in the north hemisphere), -1 = faces north
  southness(x, z) {
    const { dx, dz, g } = this.gradientAt(x, z);
    if (g < 0.05) return 0;
    // downhill direction is (-dx, -dz); south is +z
    return clamp(-dz / g, -1, 1) * Math.min(1, g * 2);
  }

  // Ray / heightfield intersection (ray in world coords; y up). Returns {x,y,z} or null.
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 80000) {
    let t = 0;
    let step = Math.max(this.cell * 0.5, 4);
    let prevT = 0, prevAbove = true;
    // skip to map bounding box altitude band
    if (oy > this.maxH + 50 && dy < 0) { t = Math.max(0, (oy - (this.maxH + 50)) / -dy); }
    for (let iter = 0; iter < 6000 && t < maxDist; iter++) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      if (!this.inBounds(x, z)) {
        if (iter > 0 && prevAbove === false) break;
      }
      const hh = this.heightAt(x, z);
      const above = y > hh;
      if (!above) {
        // refine between prevT and t
        let a = prevT, b = t;
        for (let k = 0; k < 20; k++) {
          const m = (a + b) / 2;
          const yy = oy + dy * m;
          if (yy > this.heightAt(ox + dx * m, oz + dz * m)) a = m; else b = m;
        }
        const x2 = ox + dx * b, z2 = oz + dz * b;
        if (!this.inBounds(x2, z2)) return null;
        return { x: x2, y: this.heightAt(x2, z2), z: z2 };
      }
      prevT = t; prevAbove = above;
      // adaptive step: bigger when far above ground
      step = clamp((y - hh) * 0.5, this.cell * 0.4, 400);
      t += step;
    }
    return null;
  }

  // Profile stats of a polyline [[x,z],...] sampled every `step` m.
  profile(pts, step = 10) {
    const out = { length: 0, drop: 0, maxGrad: 0, avgGrad: 0, maxUp: 0, minH: Infinity, maxH: -Infinity, meanH: 0, steepest100: 0, flatLen: 0, maxCross: 0, south: 0 };
    if (pts.length < 2) return out;
    const samples = [];
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / step));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        const t = k / n;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        samples.push({ x, z, h: this.heightAt(x, z), s: out.length + L * t });
      }
      out.length += L;
    }
    let sumH = 0, sumS = 0;
    for (const s of samples) { sumH += s.h; out.minH = Math.min(out.minH, s.h); out.maxH = Math.max(out.maxH, s.h); sumS += this.southness(s.x, s.z); }
    out.meanH = sumH / samples.length;
    out.south = sumS / samples.length;
    out.drop = samples[0].h - samples[samples.length - 1].h;
    out.avgGrad = out.length > 0 ? Math.max(0, out.drop) / out.length : 0;
    // steepest sustained 100 m (or whole length if shorter) and uphill sections
    let j = 0;
    let upRun = 0;
    for (let i = 0; i < samples.length; i++) {
      while (j < samples.length - 1 && samples[j].s - samples[i].s < Math.min(100, out.length)) j++;
      const ds = samples[j].s - samples[i].s;
      if (ds > 0) {
        const g = (samples[i].h - samples[j].h) / ds;
        out.steepest100 = Math.max(out.steepest100, g);
      }
      if (i > 0) {
        const ds1 = samples[i].s - samples[i - 1].s;
        const g1 = ds1 > 0 ? (samples[i - 1].h - samples[i].h) / ds1 : 0;
        out.maxGrad = Math.max(out.maxGrad, g1);
        if (g1 < -0.04) { upRun += samples[i].h - samples[i - 1].h; out.maxUp = Math.max(out.maxUp, upRun); }
        else if (g1 > 0.02) upRun = 0;
        if (g1 < 0.03) out.flatLen += ds1;
        // cross slope: terrain gradient perpendicular to travel direction
        const tx = (samples[i].x - samples[i - 1].x) / ds1, tz = (samples[i].z - samples[i - 1].z) / ds1;
        const gr = this.gradientAt(samples[i].x, samples[i].z);
        const cross = Math.abs(gr.dx * -tz + gr.dz * tx);
        out.maxCross = Math.max(out.maxCross, cross);
      }
    }
    out.samples = samples;
    return out;
  }

  // Fraction of steep (30-50 deg) terrain within radius r uphill of a point: avalanche exposure
  avalancheExposure(pts) {
    let steep = 0, total = 0;
    const r = 160;
    for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 20))) {
      const [x, z] = pts[i];
      const h0 = this.heightAt(x, z);
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        for (const rr of [60, 110, r]) {
          const sx = x + Math.cos(ang) * rr, sz = z + Math.sin(ang) * rr;
          const hh = this.heightAt(sx, sz);
          if (hh < h0 + 20) continue;
          total++;
          const sd = this.slopeDeg(sx, sz);
          if (sd > 28 && sd < 52) steep++;
        }
      }
    }
    return total ? steep / Math.max(total, 30) : 0;
  }
}
