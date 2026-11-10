// Deterministic land cover derived from the real elevation model: forest below the treeline on
// moderate slopes, bare rock on cliffs, meadows elsewhere. Used by the renderer (trees, colours)
// and by the builder (tree-clearing cost of new pistes).

import { clamp, smoothstep } from './util.js';

function hashXY(ix, iz, seed) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function valueNoise(x, z, scale, seed = 1) {
  const fx = x / scale, fz = z / scale;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = hashXY(ix, iz, seed), b = hashXY(ix + 1, iz, seed), c = hashXY(ix, iz + 1, seed), d = hashXY(ix + 1, iz + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}
export function fbm(x, z, scale, seed = 1) {
  return valueNoise(x, z, scale, seed) * 0.55 + valueNoise(x, z, scale / 2.3, seed + 7) * 0.3 + valueNoise(x, z, scale / 5.1, seed + 13) * 0.15;
}

export class Biome {
  constructor(terrain, treeline, townXZ) {
    this.t = terrain;
    this.treeline = treeline;
    this.town = townXZ; // [x,z] or null
    this.cleared = []; // [{pts, r}] corridors (pistes, lifts) without trees
  }
  // 0..1 forest density at a point
  forest(x, z) {
    const h = this.t.heightAt(x, z);
    const s = this.t.slopeDeg(x, z);
    const n = fbm(x, z, 900, 3);
    const tl = this.treeline + (n - 0.5) * 260;
    let d = 1 - smoothstep(tl - 220, tl, h);
    d *= 1 - smoothstep(32, 42, s);
    d *= smoothstep(0.32, 0.5, n + 0.08 * (fbm(x, z, 140, 9) - 0.5));
    // valley floors near the village are meadows and houses
    if (this.town) {
      const dd = Math.hypot(x - this.town[0], z - this.town[1]);
      d *= smoothstep(500, 1300, dd);
    }
    if (s < 4 && h < this.treeline - 300) d *= 0.4; // flat valley bottoms: pastures
    return clamp(d, 0, 1);
  }
  isForest(x, z) { return this.forest(x, z) > 0.45; }
  rock(x, z) { return smoothstep(36, 48, this.t.slopeDeg(x, z)); }
}
