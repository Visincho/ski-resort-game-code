// Scene content built from the game world: forests, village, lifts (stations, towers, cables,
// moving carriers), pistes, buildings, skiers, construction previews and labels.

import * as THREE from 'three';
import { LIFTS, BUILDINGS, DIFF } from '../catalog.js';
import { resample, clamp, dist, mulberry32, hash32, polyLength } from '../util.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const lineMats = new Set();
function lineMat(opts) {
  const m = new LineMaterial({ worldUnits: false, transparent: true, depthWrite: false, ...opts });
  m.resolution.set(window.innerWidth, window.innerHeight);
  lineMats.add(m);
  m.addEventListener('dispose', () => lineMats.delete(m));
  return m;
}
export function updateLineResolution(w, h) { for (const m of lineMats) m.resolution.set(w, h); }
window.addEventListener('resize', () => updateLineResolution(window.innerWidth, window.innerHeight));

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const ICONS = {
  base: '🎫', parking: '🅿️', rental: '🎿', school: '🧒', hut: '🍲', restaurant: '🍽️', cafe: '☕', apres: '🍹', toilet: '🚻',
  patrol: '⛑️', garage: '🚜', reservoir: '💧', weather: '📡', gazex: '💥', hotel: '🏨', hotel5: '🏰', chalet: '🛖', viewpoint: '🔭',
  terrainpark: '🛹', halfpipe: '🏂', grandstand: '🏟️', icearena: '⛸️', slidingcenter: '🛷', skijump: '🎌', nordic: '⛷️', helipad: '🚁',
};
const iconCache = {};
const MAJOR_ICONS = new Set(['base', 'hut', 'restaurant', 'hotel', 'hotel5', 'chalet', 'viewpoint', 'terrainpark', 'halfpipe', 'grandstand', 'icearena', 'slidingcenter', 'skijump', 'nordic', 'apres']);
function iconTexture(emoji, ring = '#ffffff') {
  const key = emoji + ring;
  if (iconCache[key]) return iconCache[key];
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(48, 48, 40, 0, Math.PI * 2);
  g.fillStyle = 'rgba(18,24,36,0.82)'; g.fill();
  g.lineWidth = 5; g.strokeStyle = ring; g.stroke();
  g.font = '48px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(emoji, 48, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  iconCache[key] = tex;
  return tex;
}

export class Layers {
  constructor(scene3d, game) {
    this.s3 = scene3d;
    this.scene = scene3d.scene;
    this.game = game;
    this.world = game.world;
    this.terrain = game.terrain;
    this.groups = {};
    for (const k of ['trees', 'village', 'lifts', 'pistes', 'buildings', 'agents', 'preview', 'icons', 'select']) {
      this.groups[k] = new THREE.Group();
      this.scene.add(this.groups[k]);
    }
    this.pisteMeshes = new Map();
    this.liftObjs = new Map();
    this.buildingObjs = new Map();
    this.showIcons = true;
    this.labelsEl = null;
    this.selected = null;
    this._initAgents();
    this._initCarriers();
  }

  // ---------- trees ----------
  buildTrees() {
    const T = this.terrain, B = this.game.biome;
    if (!B) return;
    if (!this.treeSpots) {
      const rng = mulberry32(hash32('trees', T.def.lat, T.def.lon));
      const spots = [];
      const step = 56;
      for (let z = T.z0 + 20; z < -T.z0 - 20; z += step) for (let x = T.x0 + 20; x < -T.x0 - 20; x += step) {
        const px = x + (rng() - 0.5) * step, pz = z + (rng() - 0.5) * step;
        const f = B.forest(px, pz);
        if (f < 0.3 || rng() > f * 1.05) continue;
        spots.push([px, T.surfaceAt(px, pz), pz, 0.7 + rng() * 0.6, rng()]);
        if (f > 0.75 && rng() < 0.35) { const qx = px + (rng() - 0.5) * 20, qz = pz + (rng() - 0.5) * 20; spots.push([qx, T.surfaceAt(qx, qz), qz, 0.6 + rng() * 0.5, rng()]); }
      }
      this.treeSpots = spots;
    }
    this._layoutTrees();
  }
  _layoutTrees() {
    const spots = this.treeSpots;
    const blocked = this._clearingIndex();
    if (!this.treeMesh) {
      const cone1 = new THREE.ConeGeometry(4.2, 11, 6); cone1.translate(0, 9, 0);
      const cone2 = new THREE.ConeGeometry(3, 8, 6); cone2.translate(0, 15, 0);
      const trunk = new THREE.CylinderGeometry(0.6, 0.8, 4, 5); trunk.translate(0, 2, 0);
      const geo = mergeGeos([trunk, cone1, cone2], [0x4a3626, 0xffffff, 0xffffff]);
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      this.treeMesh = new THREE.InstancedMesh(geo, mat, spots.length);
      this.treeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.groups.trees.add(this.treeMesh);
    }
    let n = 0;
    const col = new THREE.Color();
    for (const s of spots) {
      if (blocked(s[0], s[2])) continue;
      const sc = s[3] * 1.25;
      tmpQ.setFromAxisAngle(UP, s[4] * 6.28);
      tmpM.compose(tmpP.set(s[0], s[1] - 0.5, s[2]), tmpQ, tmpS.set(sc, sc * (0.9 + s[4] * 0.3), sc));
      this.treeMesh.setMatrixAt(n, tmpM);
      n++;
    }
    this.treeMesh.count = n;
    this.treeMesh.instanceMatrix.needsUpdate = true;
    this.updateTreeColors(this._lastSnowline ?? 1500, this._lastSummer ?? 0, true);
  }
  updateTreeColors(snowline, summer, force) {
    if (!this.treeMesh) return;
    if (!force && Math.abs(snowline - (this._lastSnowline ?? -1e9)) < 60 && summer === this._lastSummer) return;
    this._lastSnowline = snowline; this._lastSummer = summer;
    const blocked = this._clearing || (() => false);
    const col = new THREE.Color();
    let n = 0;
    for (const s of this.treeSpots) {
      if (blocked(s[0], s[2])) continue;
      const snowy = clamp((s[1] - snowline + 120) / 300, 0, 1);
      const g = 0.16 + s[4] * 0.08;
      col.setRGB(0.10 + snowy * 0.55, g + 0.08 + snowy * 0.5, 0.12 + snowy * 0.58);
      if (summer) col.setRGB(0.12, 0.26 + s[4] * 0.08, 0.13);
      this.treeMesh.setColorAt(n, col);
      n++;
    }
    if (this.treeMesh.instanceColor) this.treeMesh.instanceColor.needsUpdate = true;
  }
  // corridor test for pistes, lift lines and buildings, using a coarse spatial hash
  _clearingIndex() {
    const cell = 80;
    const grid = new Map();
    const add = (x, z, r, item) => {
      const i0 = Math.floor((x - r) / cell), i1 = Math.floor((x + r) / cell), j0 = Math.floor((z - r) / cell), j1 = Math.floor((z + r) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i * 100003 + j; let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(item); }
    };
    const segs = [];
    for (const p of this.world.pistes) {
      const r = p.width / 2 + 5;
      for (let i = 1; i < p.pts.length; i++) {
        const s = { a: p.pts[i - 1], b: p.pts[i], r };
        const L = dist(s.a[0], s.a[1], s.b[0], s.b[1]);
        const n = Math.ceil(L / cell) + 1;
        for (let k = 0; k <= n; k++) { const u = k / n; add(s.a[0] + (s.b[0] - s.a[0]) * u, s.a[1] + (s.b[1] - s.a[1]) * u, r, s); }
        segs.push(s);
      }
    }
    for (const l of this.world.lifts) {
      const s = { a: l.a, b: l.b, r: 9 };
      const L = dist(l.a[0], l.a[1], l.b[0], l.b[1]);
      const n = Math.ceil(L / cell) + 1;
      for (let k = 0; k <= n; k++) { const u = k / n; add(l.a[0] + (l.b[0] - l.a[0]) * u, l.a[1] + (l.b[1] - l.a[1]) * u, 9, s); }
    }
    for (const b of this.world.buildings) { const r = BUILDINGS[b.type].size + 6; add(b.x, b.z, r, { a: [b.x, b.z], b: [b.x + 0.01, b.z], r }); }
    if (this.village) for (const h of this.village) add(h[0], h[1], 12, { a: [h[0], h[1]], b: [h[0] + 0.01, h[1]], r: 12 });
    const fn = (x, z) => {
      const a = grid.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell));
      if (!a) return false;
      for (const s of a) if (segDist(x, z, s.a, s.b) < s.r) return true;
      return false;
    };
    this._clearing = fn;
    return fn;
  }

  // ---------- village (OSM buildings) ----------
  buildVillage(houses) {
    this.village = houses;
    if (!houses.length) return;
    const T = this.terrain;
    const rng = mulberry32(hash32('houses', houses.length));
    const wallGeo = new THREE.BoxGeometry(1, 1, 1); wallGeo.translate(0, 0.5, 0);
    const roofGeo = new THREE.ConeGeometry(0.78, 0.5, 4, 1); roofGeo.rotateY(Math.PI / 4); roofGeo.translate(0, 0.25, 0);
    const walls = new THREE.InstancedMesh(wallGeo, new THREE.MeshLambertMaterial(), houses.length);
    const roofs = new THREE.InstancedMesh(roofGeo, new THREE.MeshLambertMaterial(), houses.length);
    const col = new THREE.Color();
    houses.forEach(([x, z], i) => {
      const w = 9 + rng() * 9, d = 8 + rng() * 8, h = 6 + rng() * 7;
      const y = T.surfaceAt(x, z);
      const g = T.gradientAt(x, z);
      tmpQ.setFromAxisAngle(UP, Math.atan2(g.dx, g.dz) + (rng() < 0.5 ? 0 : Math.PI / 2));
      tmpM.compose(tmpP.set(x, y - 1, z), tmpQ, tmpS.set(w, h + 1, d));
      walls.setMatrixAt(i, tmpM);
      const wall = [0xe8dcc4, 0xd9c4a0, 0xf0ead8, 0xc49b6c, 0xb98a5a][Math.floor(rng() * 5)];
      walls.setColorAt(i, col.set(wall));
      tmpM.compose(tmpP.set(x, y + h, z), tmpQ, tmpS.set(w * 1.18, h * 0.55 + 2, d * 1.18));
      roofs.setMatrixAt(i, tmpM);
      roofs.setColorAt(i, col.set([0x5b4a3e, 0x4c4f55, 0x7a3b2e, 0x6b5a48][Math.floor(rng() * 4)]).lerp(new THREE.Color(0xf4f6fa), 0.35));
    });
    this.groups.village.add(walls, roofs);
    this.houseRoofs = roofs;
    this.houseWalls = walls;
  }

  // ---------- full rebuild of world entities ----------
  rebuildAll() {
    this._iconsNear = null;
    for (const g of ['lifts', 'pistes', 'buildings', 'icons']) { this._dispose(this.groups[g]); }
    this.pisteMeshes.clear(); this.liftObjs.clear(); this.buildingObjs.clear();
    for (const p of this.world.pistes) this._addPiste(p);
    for (const l of this.world.lifts) this._addLift(l);
    for (const b of this.world.buildings) this._addBuilding(b);
    this._buildPylons();
    if (this.treeSpots) this._layoutTrees();
    this.refreshStatus();
  }
  _dispose(group) {
    while (group.children.length) {
      const o = group.children.pop();
      o.traverse?.(c => { if (c.geometry && !c.geometry._shared) c.geometry.dispose(); if (c.material && !c.material._shared) { if (Array.isArray(c.material)) c.material.forEach(m => m.dispose()); else c.material.dispose(); } });
    }
  }

  // ---------- pistes ----------
  ribbonGeometry(pts, width, lift = 1.2) {
    const T = this.terrain;
    const rs = resample(pts, 10);
    const pos = [], idx = [];
    for (let i = 0; i < rs.length; i++) {
      const a = rs[Math.max(0, i - 1)], b = rs[Math.min(rs.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const nx = -dz, nz = dx;
      for (const side of [-1, -0.5, 0, 0.5, 1]) {
        const x = rs[i][0] + nx * width / 2 * side, z = rs[i][1] + nz * width / 2 * side;
        pos.push(x, T.surfaceAt(x, z) + lift, z);
      }
      if (i > 0) {
        const base = (i - 1) * 5;
        for (let k = 0; k < 4; k++) { const a0 = base + k, b0 = base + k + 1, c0 = base + 5 + k, d0 = base + 6 + k; idx.push(a0, c0, b0, b0, c0, d0); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  _addPiste(p) {
    const geo = this.ribbonGeometry(p.pts, p.width);
    const mat = new THREE.MeshLambertMaterial({ color: DIFF[p.difficulty].color, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    mesh.userData.ent = p;
    // centre line (constant pixel width, readable from afar like a trail map)
    const flat = [];
    for (const q of resample(p.pts, 20)) flat.push(q[0], this.terrain.surfaceAt(q[0], q[1]) + 4, q[1]);
    const lg = new LineGeometry(); lg.setPositions(flat);
    const under = new Line2(lg, lineMat({ color: 0xffffff, linewidth: 5.5, opacity: 0.55 }));
    const line = new Line2(lg, lineMat({ color: DIFF[p.difficulty].color, linewidth: 3, opacity: 0.95 }));
    under.renderOrder = 3; line.renderOrder = 4;
    under.computeLineDistances(); line.computeLineDistances();
    const grp = new THREE.Group();
    grp.add(mesh, under, line);
    this.groups.pistes.add(grp);
    this.pisteMeshes.set(p.id, { grp, mesh, line, mat });
  }

  // ---------- lifts ----------
  _addLift(l) {
    const T = LIFTS[l.type];
    const grp = new THREE.Group();
    const col = new THREE.Color(T.color);
    const stationMat = new THREE.MeshLambertMaterial({ color: col });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x3b3f46 });
    const big = ['gondola', 'cablecar', 'tram3s'].includes(l.type);
    const size = T.surface ? [5, 3.5, 4] : big ? [26, 12, 16] : [16, 8, 11];
    const dir = Math.atan2(l.b[0] - l.a[0], l.b[1] - l.a[1]);
    for (const [p, y] of [[l.a, l.ya], [l.b, l.yb]]) {
      if (l.type === 'carpet') continue;
      const box = new THREE.Mesh(new THREE.BoxGeometry(size[2], size[1], size[0]), stationMat);
      box.position.set(p[0], y + size[1] / 2 - 1, p[1]);
      box.rotation.y = dir;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(size[2] * 1.15, 1.2, size[0] * 1.1), roofMat);
      roof.position.set(0, size[1] / 2 + 0.6, 0);
      box.add(roof);
      grp.add(box);
    }
    // cables
    let cableObj;
    if (l.type === 'carpet') {
      const g = this.ribbonGeometry([l.a, l.b], 3, 0.5);
      cableObj = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x2b2b2b, side: THREE.DoubleSide }));
    } else {
      const off = T.surface ? 0 : big ? 4 : 2.6;
      const ang = dir + Math.PI / 2;
      const ox = Math.sin(ang) * off, oz = Math.cos(ang) * off;
      const pos = [];
      const c = l.cable;
      for (let i = 1; i < c.length; i++) {
        for (const s of off ? [-1, 1] : [0]) pos.push(c[i - 1][0] + ox * s, c[i - 1][1], c[i - 1][2] + oz * s, c[i][0] + ox * s, c[i][1], c[i][2] + oz * s);
      }
      const g = new LineSegmentsGeometry(); g.setPositions(pos);
      cableObj = new LineSegments2(g, lineMat({ color: 0x16181d, linewidth: big ? 1.8 : 1.4, opacity: 0.9 }));
    }
    grp.add(cableObj);
    grp.userData.ent = l;
    this.groups.lifts.add(grp);
    this.liftObjs.set(l.id, { grp, cable: cableObj, stationMat });
  }
  _buildPylons() {
    if (this.pylonMesh) { this.groups.lifts.remove(this.pylonMesh); this.pylonMesh.geometry.dispose(); }
    const list = [];
    for (const l of this.world.lifts) for (const p of l.pylons || []) list.push([p, l]);
    if (!list.length) { this.pylonMesh = null; return; }
    const geo = new THREE.CylinderGeometry(0.55, 0.9, 1, 6); geo.translate(0, 0.5, 0);
    const bar = new THREE.BoxGeometry(7, 0.035, 0.6); bar.translate(0, 1, 0);
    const merged = mergeGeos([geo, bar], [0x6c737d, 0x50565e]);
    const mesh = new THREE.InstancedMesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }), list.length);
    list.forEach(([p, l], i) => {
      const dir = Math.atan2(l.b[0] - l.a[0], l.b[1] - l.a[1]);
      tmpQ.setFromAxisAngle(UP, dir + Math.PI / 2);
      const big = ['gondola', 'cablecar', 'tram3s'].includes(l.type);
      const w = big ? 1.6 : LIFTS[l.type].surface ? 0.5 : 1;
      tmpM.compose(tmpP.set(p.x, p.y - 0.5, p.z), tmpQ, tmpS.set(w * (big ? 1.8 : 1), p.h + 0.5, w * (big ? 1.8 : 1)));
      mesh.setMatrixAt(i, tmpM);
    });
    this.pylonMesh = mesh;
    this.groups.lifts.add(mesh);
  }

  _initCarriers() {
    const chair = new THREE.BoxGeometry(2.4, 1.6, 1.4);
    const gond = new THREE.BoxGeometry(2.6, 2.6, 2.6);
    const tram = new THREE.BoxGeometry(9, 4.5, 4.5);
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.carriers = {
      chair: new THREE.InstancedMesh(chair, m, 6000),
      gond: new THREE.InstancedMesh(gond, m.clone(), 3000),
      tram: new THREE.InstancedMesh(tram, m.clone(), 200),
    };
    for (const k in this.carriers) { this.carriers[k].count = 0; this.carriers[k].frustumCulled = false; this.groups.lifts.parent.add(this.carriers[k]); }
    this.carrierPhase = 0;
  }
  updateCarriers(dtVisual, scale) {
    this.carrierPhase += dtVisual;
    const counts = { chair: 0, gond: 0, tram: 0 };
    const col = new THREE.Color();
    for (const l of this.world.lifts) {
      const T = LIFTS[l.type];
      if (T.surface || l.status === 'construction') continue;
      const kind = l.type === 'cablecar' ? 'tram' : ['gondola', 'tram3s'].includes(l.type) ? 'gond' : 'chair';
      const mesh = this.carriers[kind];
      const c = l.cable;
      const L = l.length;
      const running = l.status === 'open';
      if (!l._phase) l._phase = 0;
      if (running) l._phase += dtVisual * T.speed * 6;
      const spacing = kind === 'tram' ? L : Math.max(kind === 'gond' ? 60 : 30, L / 45);
      const n = kind === 'tram' ? 1 : Math.floor(L / spacing);
      const big = kind !== 'chair';
      const off = big ? 4 : 2.6;
      const dir = Math.atan2(l.b[0] - l.a[0], l.b[1] - l.a[1]);
      const ang = dir + Math.PI / 2;
      const ox = Math.sin(ang) * off, oz = Math.cos(ang) * off;
      tmpQ.setFromAxisAngle(UP, dir);
      col.set(T.color);
      const sc = clamp(scale, 1, 4);
      for (let side = 0; side < 2; side++) {
        for (let k = 0; k < n; k++) {
          let f;
          if (kind === 'tram') { const ph = (l._phase / L) % 2; f = side === 0 ? (ph < 1 ? ph : 2 - ph) : (ph < 1 ? 1 - ph : ph - 1); }
          else { f = ((k * spacing + l._phase) % L) / L; if (side === 1) f = 1 - f; }
          const idx = f * (c.length - 1);
          const i0 = Math.floor(idx), i1 = Math.min(c.length - 1, i0 + 1), u = idx - i0;
          const s = side === 0 ? -1 : 1;
          const x = c[i0][0] + (c[i1][0] - c[i0][0]) * u + ox * s;
          const y = c[i0][1] + (c[i1][1] - c[i0][1]) * u - (kind === 'tram' ? 3.5 : 2.4);
          const z = c[i0][2] + (c[i1][2] - c[i0][2]) * u + oz * s;
          if (counts[kind] >= mesh.instanceMatrix.count) break;
          tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sc, sc, sc));
          mesh.setMatrixAt(counts[kind], tmpM);
          mesh.setColorAt(counts[kind], col);
          counts[kind]++;
        }
      }
    }
    for (const k in this.carriers) {
      const m = this.carriers[k];
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  // ---------- buildings ----------
  _addBuilding(b) {
    const B = BUILDINGS[b.type];
    const grp = new THREE.Group();
    const y = this.terrain.surfaceAt(b.x, b.z);
    grp.position.set(b.x, y, b.z);
    grp.rotation.y = b.rot || 0;
    const mat = new THREE.MeshLambertMaterial({ color: B.color });
    const dark = new THREE.MeshLambertMaterial({ color: 0x3e3a36 });
    const s = B.size;
    const add = (geo, m, px = 0, py = 0, pz = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(px, py, pz); grp.add(o); return o; };
    switch (b.type) {
      case 'parking': add(new THREE.BoxGeometry(s * 1.6, 0.6, s), new THREE.MeshLambertMaterial({ color: 0x6d7077 }), 0, 0.3, 0); break;
      case 'reservoir': add(new THREE.CylinderGeometry(s, s, 1, 28), new THREE.MeshLambertMaterial({ color: 0x3f8fc4 }), 0, 0.6, 0); add(new THREE.TorusGeometry(s, 2, 6, 28).rotateX(Math.PI / 2), dark, 0, 1.2, 0); break;
      case 'terrainpark': {
        add(new THREE.BoxGeometry(s * 0.6, 0.5, s * 1.8), new THREE.MeshLambertMaterial({ color: 0xf5f7fb }), 0, 0.3, 0);
        for (let i = 0; i < 5; i++) add(new THREE.BoxGeometry(6, 2.5, 4), new THREE.MeshLambertMaterial({ color: [0x30c2b2, 0xff5d73, 0xffd166][i % 3] }), (i % 2 ? 8 : -8), 1.3, -s * 0.7 + i * s * 0.35);
        break;
      }
      case 'halfpipe': { const g = new THREE.CylinderGeometry(9, 9, s * 1.8, 16, 1, true, Math.PI / 2, Math.PI); g.rotateX(Math.PI / 2); add(g, new THREE.MeshLambertMaterial({ color: 0xf2f6fb, side: THREE.DoubleSide }), 0, 9, 0); break; }
      case 'grandstand': for (let i = 0; i < 5; i++) add(new THREE.BoxGeometry(s * 1.4, 2.5, 5), mat, 0, 1.25 + i * 2.5, -i * 4); add(new THREE.BoxGeometry(4, 20, 4), dark, s * 0.8, 10, 0); break;
      case 'icearena': { const g = new THREE.SphereGeometry(s * 0.8, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2); g.scale(1.3, 0.45, 1); add(g, mat, 0, 0, 0); break; }
      case 'slidingcenter': { const pts = []; for (let i = 0; i <= 14; i++) pts.push(new THREE.Vector3(Math.sin(i * 0.9) * 22, 0, -s + i * s / 7)); const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 2.4, 6, false); const m = add(g, mat, 0, 2, 0); break; }
      case 'skijump': { const g = new THREE.BoxGeometry(8, 3, s * 2); const m = add(g, mat, 0, 18, 0); m.rotation.x = -0.6; add(new THREE.BoxGeometry(5, 40, 5), dark, 0, 20, -s * 0.9); break; }
      case 'nordic': add(new THREE.BoxGeometry(s * 1.2, 0.4, s * 0.8), new THREE.MeshLambertMaterial({ color: 0xf5f7fb }), 0, 0.2, 0); add(new THREE.BoxGeometry(30, 7, 8), mat, 0, 3.5, -s * 0.45); break;
      case 'helipad': add(new THREE.CylinderGeometry(s, s, 0.6, 24), new THREE.MeshLambertMaterial({ color: 0x55585e }), 0, 0.3, 0); add(new THREE.BoxGeometry(2, 0.3, 9), new THREE.MeshLambertMaterial({ color: 0xffffff }), 0, 0.7, 0); break;
      case 'weather': add(new THREE.CylinderGeometry(0.3, 0.4, 12, 6), dark, 0, 6, 0); add(new THREE.SphereGeometry(1.4, 10, 8), mat, 0, 12.5, 0); break;
      case 'gazex': for (let i = 0; i < 3; i++) add(new THREE.CylinderGeometry(0.8, 1.2, 6, 8), mat, i * 8 - 8, 3, 0); break;
      case 'viewpoint': add(new THREE.CylinderGeometry(s, s, 1.2, 20), new THREE.MeshLambertMaterial({ color: 0x8b6b4a }), 0, 0.6, 0); add(new THREE.BoxGeometry(6, 4, 6), mat, 0, 3, 0); break;
      default: {
        const w = s * 1.5, d = s * 1.1, h = B.h;
        add(new THREE.BoxGeometry(w, h, d), mat, 0, h / 2 - 0.5, 0);
        const roof = new THREE.ConeGeometry(Math.max(w, d) * 0.72, Math.max(3, w * 0.28), 4); roof.rotateY(Math.PI / 4); roof.scale(w / Math.max(w, d), 1, d / Math.max(w, d));
        add(roof, new THREE.MeshLambertMaterial({ color: 0x51443a }), 0, h + Math.max(3, w * 0.28) / 2 - 0.5, 0);
      }
    }
    grp.userData.ent = b;
    this.groups.buildings.add(grp);
    // icon sprite
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTexture(ICONS[b.type] || '🏠'), depthTest: false, sizeAttenuation: false, transparent: true }));
    spr.scale.set(0.034, 0.034, 1);
    spr.position.set(b.x, y + Math.max(14, B.h + 10), b.z);
    spr.renderOrder = 20;
    spr.userData.ent = b;
    this.groups.icons.add(spr);
    this.buildingObjs.set(b.id, { grp, spr, mat });
  }

  // ---------- status colouring ----------
  // lit pistes glow after dark
  updateNightLights(dayFactor) {
    const night = dayFactor < 0.35;
    if (night === this._night) return;
    this._night = night;
    for (const p of this.world.pistes) {
      const o = this.pisteMeshes.get(p.id);
      if (!o) continue;
      o.mat.emissive.set(night && p.lighting ? 0xffe2a8 : 0x000000);
      o.mat.emissiveIntensity = night && p.lighting ? 1.4 : 0;
      if (night && p.lighting) o.mat.opacity = 0.55;
    }
    // warm windows in the village
    if (this.houseWalls) { this.houseWalls.material.emissive.set(night ? 0xffa040 : 0x000000); this.houseWalls.material.emissiveIntensity = night ? 0.85 : 0; }
  }
  refreshStatus() {
    this._night = null;
    const day = this.game.s.day;
    for (const p of this.world.pistes) {
      const o = this.pisteMeshes.get(p.id);
      if (!o) continue;
      const open = p.status === 'open' || p.status === 'season' && false;
      const constr = p.status === 'construction';
      const sel = this.selected === p;
      o.mat.color.set(constr ? 0xff9b3d : DIFF[p.difficulty].color);
      o.mat.opacity = sel ? 0.6 : open ? 0.28 : 0.1;
      o.line.material.color.set(constr ? 0xff9b3d : DIFF[p.difficulty].color);
      o.line.material.opacity = sel ? 1 : open ? 0.9 : 0.4;
    }
    for (const l of this.world.lifts) {
      const o = this.liftObjs.get(l.id);
      if (!o) continue;
      const constr = l.status === 'construction';
      const sel = this.selected === l;
      o.stationMat.color.set(constr ? 0xff9b3d : LIFTS[l.type].color);
      if (o.cable.material.color) o.cable.material.color.set(sel ? 0xffd400 : l.status === 'open' ? 0x16181d : constr ? 0xff9b3d : 0x7b7f86);
      o.cable.visible = !constr || true;
    }
    for (const b of this.world.buildings) {
      const o = this.buildingObjs.get(b.id);
      if (!o) continue;
      const constr = day < b.buildUntil;
      o.mat.color.set(constr ? 0xff9b3d : BUILDINGS[b.type].color);
      o.spr.material.map = iconTexture(constr ? '🏗️' : ICONS[b.type] || '🏠', this.selected === b ? '#ffd400' : constr ? '#ff9b3d' : '#ffffff');
    }
  }
  setSelected(e) {
    this.selected = e;
    this._dispose(this.groups.select);
    if (e && e.kind === 'building') {
      const B = BUILDINGS[e.type];
      const ring = new THREE.Mesh(new THREE.RingGeometry(B.size * 1.1 + 4, B.size * 1.1 + 8, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: 0.9, depthTest: false }));
      ring.position.set(e.x, this.terrain.heightAt(e.x, e.z) + 2, e.z);
      ring.renderOrder = 30;
      this.groups.select.add(ring);
    }
    if (e && e.kind === 'lift') {
      for (const [p, y] of [[e.a, e.ya], [e.b, e.yb]]) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(24, 30, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: 0.9, depthTest: false }));
        ring.position.set(p[0], y + 2, p[1]); ring.renderOrder = 30;
        this.groups.select.add(ring);
      }
    }
    this.refreshStatus();
  }

  // ---------- skiers ----------
  _initAgents() {
    const g = new THREE.CapsuleGeometry(0.55, 1.1, 2, 6); g.translate(0, 1.1, 0);
    this.agentMesh = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: 0xffffff }), 3000);
    this.agentMesh.count = 0;
    this.agentMesh.frustumCulled = false;
    this.groups.agents.add(this.agentMesh);
  }
  updateAgents(camDist) {
    const ag = this.game.crowd.agents;
    const m = this.agentMesh;
    const sc = clamp(camDist / 420, 1, 22);
    const col = new THREE.Color();
    let n = 0;
    for (const a of ag) {
      if (n >= 3000) break;
      if (a.pos[1] < -1000) continue;
      tmpQ.setFromAxisAngle(UP, a.heading || 0);
      tmpM.compose(tmpP.set(a.pos[0], a.pos[1] - 1, a.pos[2]), tmpQ, tmpS.set(sc, sc, sc));
      m.setMatrixAt(n, tmpM);
      m.setColorAt(n, col.setHex(a.color));
      n++;
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  // ---------- previews ----------
  clearPreview() { this._dispose(this.groups.preview); }
  previewLift(plan) {
    this.clearPreview();
    if (!plan || !plan.cable) return;
    const ok = plan.ok;
    const color = ok ? 0x2ee59d : 0xff4d4d;
    const lg = new LineGeometry();
    lg.setPositions(plan.cable.flatMap(c => [c[0], c[1], c[2]]));
    const line = new Line2(lg, lineMat({ color, linewidth: 3.5, opacity: 0.95, depthTest: false }));
    line.renderOrder = 40;
    this.groups.preview.add(line);
    for (const p of plan.pylons || []) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, p.h, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }));
      m.position.set(p.x, p.y + p.h / 2, p.z);
      this.groups.preview.add(m);
    }
    for (const [p, y] of [[plan.a, plan.ya], [plan.b, plan.yb]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(14, 8, 14), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 }));
      m.position.set(p[0], y + 4, p[1]);
      this.groups.preview.add(m);
    }
  }
  previewPiste(plan, rawPts) {
    this.clearPreview();
    const pts = plan && plan.pts ? plan.pts : rawPts;
    if (!pts || pts.length < 2) {
      if (rawPts && rawPts.length === 1) this._previewDot(rawPts[0], 0x2ee59d);
      return;
    }
    const color = plan && !plan.ok ? 0xff4d4d : DIFF[plan?.difficulty ?? 1].color;
    const geo = this.ribbonGeometry(pts, 40, 1.8);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
    mesh.renderOrder = 41;
    this.groups.preview.add(mesh);
    const lg = new LineGeometry();
    lg.setPositions(resample(pts, 15).flatMap(q => [q[0], this.terrain.surfaceAt(q[0], q[1]) + 5, q[1]]));
    const cl = new Line2(lg, lineMat({ color, linewidth: 4, opacity: 0.95 }));
    cl.renderOrder = 42;
    this.groups.preview.add(cl);
    for (const p of rawPts || []) this._previewDot(p, 0xffffff);
  }
  _previewDot(p, color) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(7, 10, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.position.set(p[0], this.terrain.heightAt(p[0], p[1]) + 5, p[1]);
    m.renderOrder = 42;
    this.groups.preview.add(m);
  }
  previewBuilding(plan) {
    this.clearPreview();
    if (!plan) return;
    const B = BUILDINGS[plan.type];
    const color = plan.ok ? 0x2ee59d : 0xff4d4d;
    const m = new THREE.Mesh(new THREE.BoxGeometry(B.size * 1.5, Math.max(4, B.h), B.size * 1.1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }));
    m.position.set(plan.x, this.terrain.heightAt(plan.x, plan.z) + Math.max(4, B.h) / 2, plan.z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(B.size * 1.2, B.size * 1.2 + 5, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
    ring.position.set(plan.x, this.terrain.heightAt(plan.x, plan.z) + 2, plan.z);
    ring.renderOrder = 42;
    this.groups.preview.add(m, ring);
  }
  previewRadius(x, z, r, color = 0xffd400) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - 12, r, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.6 }));
    ring.position.set(x, this.terrain.heightAt(x, z) + 30, z);
    this.groups.preview.add(ring);
  }

  setIconsVisible(v) { this.groups.icons.visible = v; }
  // small service icons only appear when zoomed in
  updateIcons(camDist) {
    const near = camDist < 4500;
    if (near === this._iconsNear) return;
    this._iconsNear = near;
    for (const spr of this.groups.icons.children) spr.visible = near || MAJOR_ICONS.has(spr.userData.ent?.type);
  }
}

// --- helpers
function segDist(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L2 = dx * dx + dz * dz;
  let t = L2 ? ((x - a[0]) * dx + (z - a[1]) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

export function mergeGeos(geos, colors) {
  let total = 0;
  const parts = geos.map(g => g.index ? g.toNonIndexed() : g);
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  const c = new THREE.Color();
  parts.forEach((g, i) => {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    c.set(colors[i]);
    for (let k = 0; k < g.attributes.position.count; k++) { col[(o + k) * 3] = c.r; col[(o + k) * 3 + 1] = c.g; col[(o + k) * 3 + 2] = c.b; }
    o += g.attributes.position.count;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}
